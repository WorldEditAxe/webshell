// SPDX-License-Identifier: MIT
//
// FragmentedFS: a filesystem split into many small blobs.
//
// File contents live in `blobs/<random hex>`, each at most a configured size.
// Everything else lives in `metadata/`: `<path>.json` for every file (its name,
// the SHA-256 of the whole file, its fragments in assembly order with the
// SHA-256 of each) and a directory document per directory that describes it and
// enumerates what it holds (docs/FRAGMENTED-FS.md).
//
// This is an `FS` backend like `indexedDbFS` or `nodeDirectoryFS`, so it serves
// a guest through `fileSystemDevice` (virtio-fs) or `ninePDevice` (virtio-9p)
// and reads and writes its two folders through any `FragmentStore`.
import { FSError } from "./contract.js";
import { DIRECTORY_DOCUMENT, DIRECTORY_NAME, DOCUMENT_SUFFIX, FORMAT, directoryKey, documentKey, entryDocumentPath, isEntryName, parseDirectoryDocument, parseEntryDocument, printDocument, } from "./format.js";
import { EMPTY_SHA256, createHasher, randomHex, sha256Hex, updateZeros } from "./sha256.js";
import { FragmentCache, Mutex, RWLock, StreamingBlob, forEachLimit } from "./sync.js";
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;
const O_ACCMODE = 3;
const O_TRUNC = 0o1000;
const MIB = 1024 * 1024;
const MAX_NAME_BYTES = 250; // leaves room for ".json" within a 255-byte file name
const utf8 = new TextEncoder();
class FileNode {
    kind = "file";
    parent;
    name;
    perm;
    uid;
    gid;
    mtime;
    ctime;
    unlinked = false;
    retired = false;
    size = 0;
    sha256 = EMPTY_SHA256;
    fragments = [];
    /** The fragment list has been read from the store (or the file is new). */
    ready;
    loading;
    /** Created in memory and not yet written to the store. */
    pending;
    /** The last committed state, as the directory document lists it. */
    entry;
    contentDirty = false;
    attrDirty = false;
    dirtyBytes = 0;
    opens = 0;
    /** Blobs no longer referenced once the next commit lands. */
    obsolete = [];
    /** Hashes the file's bytes so far while it has only ever been appended to. */
    hasher;
    hashed = 0;
    lock = new RWLock();
    constructor(parent, name, perm, uid, gid, time, pending) {
        this.parent = parent;
        this.name = name;
        this.perm = perm;
        this.uid = uid;
        this.gid = gid;
        this.mtime = time;
        this.ctime = time;
        this.pending = pending;
        this.ready = pending;
    }
}
class SymlinkNode {
    kind = "symlink";
    parent;
    name;
    target;
    perm = 0o777;
    uid;
    gid;
    mtime;
    ctime;
    unlinked = false;
    entry;
    constructor(parent, name, target, uid, gid, time) {
        this.parent = parent;
        this.name = name;
        this.target = target;
        this.uid = uid;
        this.gid = gid;
        this.mtime = time;
        this.ctime = time;
    }
}
class DirectoryNode {
    kind = "directory";
    parent;
    name;
    perm;
    uid;
    gid;
    mtime;
    ctime;
    unlinked = false;
    /** Whether mode, owner and times are known (a folder found by listing has none until read). */
    attrsKnown;
    children = new Map();
    /** `children` in name order, until the next change. */
    sorted;
    ready = false;
    loading;
    /** Bumped by every change the directory document has not recorded yet. */
    revision = 0;
    timer;
    constructor(parent, name, perm, uid, gid, time, attrsKnown = true) {
        this.parent = parent;
        this.name = name;
        this.perm = perm;
        this.uid = uid;
        this.gid = gid;
        this.mtime = time;
        this.ctime = time;
        this.attrsKnown = attrsKnown;
    }
}
/**
 * Opens the FragmentedFS in `store`, starting an empty one when a writable
 * store has none.
 *
 * @example
 * ```ts
 * const fs = await fragmentedFS(nodeDirectoryFragmentStore("/srv/disk"), { maxFragmentMB: 4 });
 * await bootMachine({ cpus: 2, plugins: [ninePDevice(fs, { tag: "disk" })] });
 * ```
 */
export async function fragmentedFS(store, options = {}) {
    const fs = new Fragmented(store, options);
    await fs.ready();
    return fs;
}
/**
 * The same filesystem, handed back at once and opened by the first operation
 * that reaches it: for building a virtio device before the store has been
 * read. A store that turns out not to hold a FragmentedFS fails every
 * operation (EIO) instead of failing this call.
 */
export function lazyFragmentedFS(store, options = {}) {
    return new Fragmented(store, options);
}
const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const toTimestamp = (time) => ({ seconds: BigInt(time.sec), nanoseconds: time.nsec });
function fromTimestamp(value) {
    return { sec: Number(value.seconds), nsec: value.nanoseconds ?? 0 };
}
function megabytes(name, value, fallback) {
    const mb = value ?? fallback;
    if (!Number.isFinite(mb) || mb <= 0)
        throw new RangeError(`${name} must be a positive number`);
    return mb;
}
class Fragmented {
    store;
    options;
    root;
    maxFragmentBytes;
    #verify;
    #writable;
    #maxDirty;
    #indexDelay;
    #concurrency;
    #capacity;
    #clock;
    #newId;
    #reconcile;
    #cache;
    /** The blobs on their way from a store that can stream them. */
    #streams = new Map();
    /** Serializes everything that changes a name: the namespace and its documents. */
    #names = new Mutex();
    #dirtyFiles = new Set();
    #dirtyDirectories = new Set();
    #dirtyBytes = 0;
    /** The root document, read once by `start` and handed to the first directory load. */
    #rootDocument;
    #closed = false;
    #spilling;
    #failure;
    constructor(store, options) {
        this.store = store;
        this.options = options;
        this.maxFragmentBytes = Math.max(1, Math.floor(megabytes("maxFragmentMB", options.maxFragmentMB, 4) * MIB));
        this.#verify = options.verify ?? true;
        this.#writable = store.writable && !options.readOnly;
        this.#maxDirty = Math.floor(megabytes("maxDirtyMB", options.maxDirtyMB, 64) * MIB);
        this.#indexDelay = options.indexDelayMs ?? 200;
        this.#concurrency = Math.max(1, options.concurrency ?? 4);
        this.#capacity = BigInt(Math.floor(megabytes("capacityGB", options.capacityGB, 256) * 1024)) * BigInt(MIB);
        this.#clock = options.now ?? Date.now;
        const idBytes = options.blobIdBytes ?? 16;
        this.#newId = options.randomId ?? (() => randomHex(idBytes));
        this.#reconcile = this.#writable && typeof store.listMetadata === "function";
        this.#cache = new FragmentCache(Math.floor(megabytes("cacheMB", options.cacheMB, 64) * MIB));
        const now = this.#now();
        this.root = new DirectoryNode(undefined, "", 0o755, options.uid ?? 0, options.gid ?? 0, now, false);
    }
    #started;
    /** Opens the store, once; every operation waits for it, so a filesystem can be handed to a device before it is open. */
    ready() {
        return (this.#started ??= this.#open());
    }
    async #open() {
        const raw = await this.store.getMetadata(DIRECTORY_DOCUMENT);
        if (raw) {
            this.#applyDirectory(this.root, parseDirectoryDocument(DIRECTORY_DOCUMENT, raw));
            this.#rootDocument = raw;
        }
        else if (this.#writable) {
            this.root.attrsKnown = true;
            await this.#writeIndex(this.root);
        }
        else {
            throw new FSError("EIO", `FragmentedFS: no ${DIRECTORY_DOCUMENT} in the store, so it holds no FragmentedFS`);
        }
        await this.#ensureLoaded(this.root);
    }
    // ---- time, names and paths ----------------------------------------------
    #now() {
        const ms = this.#clock();
        const sec = Math.floor(ms / 1000);
        return { sec, nsec: Math.round((ms - sec * 1000) * 1_000_000) };
    }
    #assertWritable() {
        if (!this.#writable)
            throw new FSError("EROFS");
    }
    #validateName(name) {
        if (name.length === 0 || name === "." || name === ".." || name.includes("/") || name.includes("\0")) {
            throw new FSError("EINVAL", "invalid path component");
        }
        if (utf8.encode(name).byteLength > MAX_NAME_BYTES)
            throw new FSError("ENAMETOOLONG");
        if (name === DIRECTORY_NAME)
            throw new FSError("EINVAL", `${DIRECTORY_NAME} is reserved by FragmentedFS`);
    }
    /**
     * A file or symlink `x` is described by `x.json` and a directory `x.json` is a
     * folder of that name, so the two cannot share a directory; nor can a
     * directory take the name of the directory document.
     */
    #checkConflict(dir, name, kind, replacing) {
        if (kind === "directory") {
            if (name === DIRECTORY_DOCUMENT)
                throw new FSError("EINVAL", `${name} is reserved by FragmentedFS`);
            if (name.endsWith(DOCUMENT_SUFFIX)) {
                const other = dir.children.get(name.slice(0, -DOCUMENT_SUFFIX.length));
                if (other && other.kind !== "directory" && other !== replacing) {
                    throw new FSError("EINVAL", `a directory named ${name} would collide with the document of ${other.name}`);
                }
            }
        }
        else {
            const other = dir.children.get(name + DOCUMENT_SUFFIX);
            if (other && other.kind === "directory" && other !== replacing) {
                throw new FSError("EINVAL", `${name} would collide with the directory ${other.name}`);
            }
        }
    }
    #segments(node) {
        const names = [];
        let at = node;
        while (at !== this.root) {
            if (!at.parent)
                throw new FSError("ESTALE", "the file was removed");
            names.push(at.name);
            at = at.parent;
        }
        return names.reverse();
    }
    #directoryPath(dir) {
        return this.#segments(dir).join("/");
    }
    #indexKey(dir) {
        return directoryKey(this.#directoryPath(dir));
    }
    #entryKey(node) {
        if (!node.parent)
            throw new FSError("ESTALE", "the file was removed");
        return documentKey(this.#directoryPath(node.parent), node.name);
    }
    #directory(node) {
        if (node.kind !== "directory")
            throw new FSError("ENOTDIR");
        return node;
    }
    #file(node) {
        if (node.kind === "directory")
            throw new FSError("EISDIR");
        if (node.kind !== "file")
            throw new FSError("EINVAL");
        return node;
    }
    // ---- loading ---------------------------------------------------------------
    #ensureLoaded(dir) {
        if (dir.ready)
            return Promise.resolve();
        return (dir.loading ??= this.#loadDirectory(dir).then(() => {
            dir.ready = true;
        }, (error) => {
            dir.loading = undefined;
            throw error;
        }));
    }
    #applyDirectory(dir, doc) {
        dir.perm = doc.mode;
        dir.uid = doc.uid;
        dir.gid = doc.gid;
        dir.mtime = { sec: doc.mtime, nsec: doc.mtimeNsec };
        dir.ctime = { sec: doc.ctime, nsec: doc.ctimeNsec };
        dir.attrsKnown = true;
    }
    #nodeFromEntry(dir, entry) {
        const mtime = { sec: entry.mtime, nsec: entry.mtimeNsec };
        const ctime = { sec: entry.ctime, nsec: entry.ctimeNsec };
        if (entry.type === "directory") {
            const child = new DirectoryNode(dir, entry.name, entry.mode, entry.uid, entry.gid, mtime);
            child.ctime = ctime;
            return child;
        }
        if (entry.type === "symlink") {
            const link = new SymlinkNode(dir, entry.name, entry.target ?? "", entry.uid, entry.gid, mtime);
            link.ctime = ctime;
            link.perm = entry.mode;
            link.entry = entry;
            return link;
        }
        const file = new FileNode(dir, entry.name, entry.mode, entry.uid, entry.gid, mtime, false);
        file.ctime = ctime;
        file.size = entry.size ?? 0;
        file.sha256 = entry.sha256 ?? EMPTY_SHA256;
        file.entry = entry;
        return file;
    }
    #nodeFromDocument(dir, name, doc) {
        const mtime = { sec: doc.mtime, nsec: doc.mtimeNsec };
        if (doc.type === "symlink") {
            const link = new SymlinkNode(dir, name, doc.target, doc.uid, doc.gid, mtime);
            link.ctime = { sec: doc.ctime, nsec: doc.ctimeNsec };
            link.perm = doc.mode;
            link.entry = this.#entryOf(link);
            return link;
        }
        const file = new FileNode(dir, name, doc.mode, doc.uid, doc.gid, mtime, false);
        this.#applyFile(file, doc);
        return file;
    }
    async #loadDirectory(dir) {
        const key = this.#indexKey(dir);
        const preread = dir === this.root ? this.#rootDocument : undefined;
        this.#rootDocument = undefined;
        const raw = preread ?? (await this.store.getMetadata(key));
        const doc = raw ? parseDirectoryDocument(key, raw) : undefined;
        const listing = this.#reconcile ? await this.store.listMetadata(this.#directoryPath(dir)) : undefined;
        if (!doc && !listing)
            throw new FSError("ENOENT", `FragmentedFS: ${key} is missing`);
        if (doc && !dir.attrsKnown)
            this.#applyDirectory(dir, doc);
        dir.attrsKnown = true;
        const entries = new Map((doc?.entries ?? []).map((entry) => [entry.name, entry]));
        const children = new Map();
        let repair = !doc;
        if (!listing) {
            for (const entry of entries.values())
                children.set(entry.name, this.#nodeFromEntry(dir, entry));
        }
        else {
            // The folder listing is the truth about what exists; the directory
            // document only summarizes it, and may be behind after a crash.
            const unindexed = [];
            for (const item of listing) {
                if (!isEntryName(item.name.endsWith(DOCUMENT_SUFFIX) && !item.directory ? item.name.slice(0, -DOCUMENT_SUFFIX.length) : item.name))
                    continue;
                if (item.directory) {
                    const entry = entries.get(item.name);
                    if (entry?.type === "directory") {
                        children.set(item.name, this.#nodeFromEntry(dir, entry));
                    }
                    else {
                        repair = true;
                        children.set(item.name, new DirectoryNode(dir, item.name, 0o755, 0, 0, this.#now(), false));
                    }
                }
                else if (item.name.endsWith(DOCUMENT_SUFFIX) && item.name !== DIRECTORY_DOCUMENT) {
                    const name = item.name.slice(0, -DOCUMENT_SUFFIX.length);
                    const entry = entries.get(name);
                    if (entry && entry.type !== "directory")
                        children.set(name, this.#nodeFromEntry(dir, entry));
                    else
                        unindexed.push(name);
                }
            }
            const base = this.#directoryPath(dir);
            await forEachLimit(unindexed, 8, async (name) => {
                const entryKey = documentKey(base, name);
                const bytes = await this.store.getMetadata(entryKey);
                if (!bytes)
                    return;
                children.set(name, this.#nodeFromDocument(dir, name, parseEntryDocument(entryKey, bytes)));
            });
            if (unindexed.length > 0 || entries.size !== children.size)
                repair = true;
        }
        dir.children = children;
        dir.sorted = undefined;
        if (repair && this.#writable)
            this.#markIndex(dir);
    }
    /** What a directory of unknown attributes (found by listing) turns out to have. */
    async #ensureAttributes(node) {
        if (node.kind === "directory" && !node.attrsKnown)
            await this.#ensureLoaded(node);
    }
    #applyFile(file, doc) {
        file.perm = doc.mode;
        file.uid = doc.uid;
        file.gid = doc.gid;
        file.mtime = { sec: doc.mtime, nsec: doc.mtimeNsec };
        file.ctime = { sec: doc.ctime, nsec: doc.ctimeNsec };
        file.size = doc.size;
        file.sha256 = doc.sha256;
        let offset = 0;
        file.fragments = doc.fragments.map((fragment) => {
            const loaded = {
                hole: fragment.hole === true,
                blob: fragment.blob,
                size: fragment.size,
                sha256: fragment.sha256,
                offset,
                dirty: false,
            };
            offset += fragment.size;
            return loaded;
        });
        file.hasher = undefined;
        file.hashed = 0;
        file.entry = this.#entryOf(file);
        file.ready = true;
    }
    #ensureFile(file) {
        if (file.ready)
            return Promise.resolve();
        return (file.loading ??= this.#loadFile(file).then(() => undefined, (error) => {
            file.loading = undefined;
            throw error;
        }));
    }
    async #loadFile(file) {
        let key = this.#entryKey(file);
        let raw = await this.store.getMetadata(key);
        if (!raw) {
            // It may have been renamed while this was waiting.
            const current = this.#entryKey(file);
            if (current !== key)
                raw = await this.store.getMetadata((key = current));
        }
        if (!raw)
            throw new FSError("ENOENT", `FragmentedFS: ${key} is missing`);
        const doc = parseEntryDocument(key, raw);
        if (doc.type !== "file")
            throw new FSError("EIO", `FragmentedFS: ${key} is not a file document`);
        this.#applyFile(file, doc);
    }
    // ---- documents ---------------------------------------------------------------
    #entryOf(node) {
        const entry = {
            name: node.name,
            type: node.kind,
            mode: node.perm,
            uid: node.uid,
            gid: node.gid,
            mtime: node.mtime.sec,
            mtimeNsec: node.mtime.nsec,
            ctime: node.ctime.sec,
            ctimeNsec: node.ctime.nsec,
            metadata: entryDocumentPath(node.name, node.kind),
        };
        if (node.kind === "file") {
            entry.size = node.size;
            entry.sha256 = node.sha256;
        }
        else {
            entry.target = node.target;
        }
        return entry;
    }
    #directoryEntry(node) {
        return {
            name: node.name,
            type: "directory",
            mode: node.perm,
            uid: node.uid,
            gid: node.gid,
            mtime: node.mtime.sec,
            mtimeNsec: node.mtime.nsec,
            ctime: node.ctime.sec,
            ctimeNsec: node.ctime.nsec,
            metadata: entryDocumentPath(node.name, "directory"),
        };
    }
    #fileDocument(file) {
        const fragments = file.fragments.map((fragment, index) => fragment.hole
            ? { index, size: fragment.size, hole: true }
            : { index, blob: fragment.blob, size: fragment.size, sha256: fragment.sha256 });
        return {
            format: FORMAT,
            type: "file",
            name: file.name,
            size: file.size,
            sha256: file.sha256,
            mode: file.perm,
            uid: file.uid,
            gid: file.gid,
            mtime: file.mtime.sec,
            mtimeNsec: file.mtime.nsec,
            ctime: file.ctime.sec,
            ctimeNsec: file.ctime.nsec,
            fragments,
        };
    }
    #symlinkDocument(link) {
        return {
            format: FORMAT,
            type: "symlink",
            name: link.name,
            target: link.target,
            mode: link.perm,
            uid: link.uid,
            gid: link.gid,
            mtime: link.mtime.sec,
            mtimeNsec: link.mtime.nsec,
            ctime: link.ctime.sec,
            ctimeNsec: link.ctime.nsec,
        };
    }
    #directoryDocument(dir) {
        const entries = [];
        for (const child of this.#sorted(dir)) {
            if (child.kind === "file" && child.pending)
                continue;
            if (child.kind === "directory")
                entries.push(this.#directoryEntry(child));
            else if (child.entry)
                entries.push(child.entry);
        }
        const doc = {
            format: FORMAT,
            type: "directory",
            name: dir.name,
            mode: dir.perm,
            uid: dir.uid,
            gid: dir.gid,
            mtime: dir.mtime.sec,
            mtimeNsec: dir.mtime.nsec,
            ctime: dir.ctime.sec,
            ctimeNsec: dir.ctime.nsec,
            entries,
        };
        if (dir === this.root)
            doc.maxFragmentBytes = this.maxFragmentBytes;
        return doc;
    }
    #sorted(dir) {
        return (dir.sorted ??= [...dir.children.values()].sort(byName));
    }
    async #writeIndex(dir) {
        if (dir.unlinked)
            return;
        const revision = dir.revision;
        for (const child of dir.children.values())
            await this.#ensureAttributes(child);
        await this.store.putMetadata(this.#indexKey(dir), printDocument(this.#directoryDocument(dir)));
        if (dir.revision === revision)
            this.#dirtyDirectories.delete(dir);
    }
    /** Notes that `dir`'s document is behind and writes it soon. */
    #markIndex(dir) {
        if (dir.unlinked || !this.#writable)
            return;
        dir.revision += 1;
        this.#dirtyDirectories.add(dir);
        if (dir.timer || this.#closed)
            return;
        const delay = Math.max(this.#indexDelay, dir.children.size);
        dir.timer = setTimeout(() => {
            dir.timer = undefined;
            this.#names.run(() => this.#writeIndex(dir)).catch((error) => this.#fail(error));
        }, delay);
        dir.timer.unref?.();
    }
    #fail(error) {
        this.#failure ??= error;
    }
    #touch(dir) {
        dir.mtime = dir.ctime = this.#now();
        this.#markIndex(dir);
    }
    // ---- fragments ---------------------------------------------------------------
    /** A fragment's bytes, checked against the document that describes them. */
    async #fetch(fragment) {
        const id = fragment.blob;
        if (this.store.getBlobStream)
            return this.#stream(fragment, id);
        const data = await this.store.getBlob(id);
        if (!data)
            throw new FSError("EIO", `FragmentedFS: blob ${id} is missing`);
        if (data.byteLength !== fragment.size) {
            throw new FSError("EIO", `FragmentedFS: blob ${id} is ${data.byteLength} bytes, not ${fragment.size}`);
        }
        if (this.#verify && (await sha256Hex(data)) !== fragment.sha256) {
            throw new FSError("EIO", `FragmentedFS: blob ${id} does not match its SHA-256`);
        }
        return data;
    }
    /** Fetches a blob as it arrives, for `#range`; resolves to it once it is whole and checked. */
    async #stream(fragment, id) {
        const blob = new StreamingBlob(fragment.size);
        this.#streams.set(id, blob);
        try {
            const stream = await this.store.getBlobStream(id);
            if (!stream)
                throw new FSError("EIO", `FragmentedFS: blob ${id} is missing`);
            const reader = stream.getReader();
            for (;;) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                if (!blob.add(value)) {
                    await reader.cancel().catch(() => { });
                    throw new FSError("EIO", `FragmentedFS: blob ${id} is longer than ${fragment.size} bytes`);
                }
            }
            if (blob.filled !== fragment.size) {
                throw new FSError("EIO", `FragmentedFS: blob ${id} is ${blob.filled} bytes, not ${fragment.size}`);
            }
            if (this.#verify && (await sha256Hex(blob.bytes)) !== fragment.sha256) {
                throw new FSError("EIO", `FragmentedFS: blob ${id} does not match its SHA-256`);
            }
            return blob.bytes;
        }
        catch (error) {
            blob.fail(error);
            throw error;
        }
        finally {
            this.#streams.delete(id);
        }
    }
    /**
     * A data fragment with bytes `from` to `to` in place, without waiting for the rest when the store can stream it. Those bytes
     * may not be checked yet: a read that reaches the fragment's end waits for the whole blob and its hash, so a reader
     * that goes through a file sees an error rather than its end if a blob was wrong.
     */
    async #range(fragment, to) {
        if (fragment.buf || !this.store.getBlobStream || to >= fragment.size)
            return this.#data(fragment);
        const id = fragment.blob;
        const held = this.#cache.peek(id);
        if (held)
            return held;
        this.#cache.prefetch(id, () => this.#fetch(fragment));
        const arriving = this.#streams.get(id);
        if (!arriving)
            return this.#data(fragment);
        await arriving.until(to);
        return arriving.bytes;
    }
    /** The bytes of a data fragment: its private buffer if it has one, else the verified blob. */
    async #data(fragment) {
        if (fragment.buf)
            return fragment.buf.subarray(0, fragment.size);
        return this.#cache.get(fragment.blob, () => this.#fetch(fragment));
    }
    #findFragment(file, position) {
        let low = 0;
        let high = file.fragments.length - 1;
        while (low <= high) {
            const middle = (low + high) >> 1;
            const fragment = file.fragments[middle];
            if (position < fragment.offset)
                high = middle - 1;
            else if (position >= fragment.offset + fragment.size)
                low = middle + 1;
            else
                return middle;
        }
        return -1;
    }
    #reindex(file, from) {
        let offset = from === 0 ? 0 : file.fragments[from - 1].offset + file.fragments[from - 1].size;
        for (let i = from; i < file.fragments.length; i++) {
            const fragment = file.fragments[i];
            fragment.offset = offset;
            offset += fragment.size;
        }
    }
    #adjustDirty(file, delta) {
        file.dirtyBytes += delta;
        this.#dirtyBytes += delta;
    }
    /** Gives a data fragment a private buffer and marks it changed. */
    async #modify(file, fragment) {
        if (!fragment.buf)
            fragment.buf = (await this.#data(fragment)).slice();
        if (!fragment.dirty) {
            fragment.dirty = true;
            if (fragment.blob) {
                file.obsolete.push(fragment.blob);
                fragment.blob = undefined;
            }
            fragment.sha256 = undefined;
            this.#adjustDirty(file, fragment.size);
        }
        file.contentDirty = true;
        this.#dirtyFiles.add(file);
    }
    #grow(file, fragment, size) {
        const buf = fragment.buf;
        if (buf.length < size) {
            const bigger = new Uint8Array(Math.max(size, Math.min(this.maxFragmentBytes, Math.max(buf.length * 2, 64 * 1024))));
            bigger.set(buf.subarray(0, fragment.size));
            fragment.buf = bigger;
        }
        this.#adjustDirty(file, size - fragment.size);
        fragment.size = size;
    }
    /** Forgets a fragment that is no longer part of the file. */
    #drop(file, fragment) {
        if (fragment.blob)
            file.obsolete.push(fragment.blob);
        if (fragment.dirty)
            this.#adjustDirty(file, -fragment.size);
    }
    /** Makes the zeros of a hole into data fragments, aligned to the cap, covering [start, end). */
    #materialize(file, index, start, end) {
        const hole = file.fragments[index];
        const cap = this.maxFragmentBytes;
        const from = Math.max(hole.offset, Math.floor(start / cap) * cap);
        const to = Math.min(hole.offset + hole.size, Math.ceil(end / cap) * cap);
        const pieces = [];
        if (from > hole.offset)
            pieces.push({ hole: true, size: from - hole.offset, offset: hole.offset, dirty: false });
        for (let at = from; at < to; at += cap) {
            const size = Math.min(cap, to - at);
            pieces.push({ hole: false, size, offset: at, buf: new Uint8Array(size), dirty: true });
            this.#adjustDirty(file, size);
        }
        if (to < hole.offset + hole.size) {
            pieces.push({ hole: true, size: hole.offset + hole.size - to, offset: to, dirty: false });
        }
        file.fragments.splice(index, 1, ...pieces);
        file.contentDirty = true;
        this.#dirtyFiles.add(file);
    }
    #extend(file, size) {
        const added = size - file.size;
        const last = file.fragments[file.fragments.length - 1];
        if (last?.hole)
            last.size += added;
        else
            file.fragments.push({ hole: true, size: added, offset: file.size, dirty: false });
        file.size = size;
        file.hasher = undefined;
        file.contentDirty = true;
        this.#dirtyFiles.add(file);
    }
    async #truncate(file, size) {
        if (size > file.size)
            return this.#extend(file, size);
        if (size === file.size)
            return;
        const index = this.#findFragment(file, size);
        const cut = file.fragments[index];
        for (let i = index + 1; i < file.fragments.length; i++)
            this.#drop(file, file.fragments[i]);
        file.fragments.length = index + 1;
        if (size === cut.offset) {
            this.#drop(file, cut);
            file.fragments.pop();
        }
        else if (cut.hole) {
            cut.size = size - cut.offset;
        }
        else {
            await this.#modify(file, cut);
            this.#adjustDirty(file, size - cut.offset - cut.size);
            cut.size = size - cut.offset;
        }
        file.size = size;
        file.hasher = size === 0 ? createHasher() : undefined;
        file.hashed = 0;
        file.contentDirty = true;
        this.#dirtyFiles.add(file);
    }
    async #applyWrite(file, offset, data) {
        const cap = this.maxFragmentBytes;
        const end = offset + data.length;
        if (offset > file.size)
            this.#extend(file, offset);
        const appendOnly = offset === file.size && file.hasher !== undefined && file.hashed === file.size;
        if (!appendOnly)
            file.hasher = undefined;
        let done = 0;
        let position = offset;
        while (done < data.length && position < file.size) {
            let index = this.#findFragment(file, position);
            let fragment = file.fragments[index];
            if (fragment.hole) {
                this.#materialize(file, index, position, Math.min(end, fragment.offset + fragment.size));
                index = this.#findFragment(file, position);
                fragment = file.fragments[index];
            }
            await this.#modify(file, fragment);
            const count = Math.min(fragment.offset + fragment.size - position, data.length - done);
            fragment.buf.set(data.subarray(done, done + count), position - fragment.offset);
            done += count;
            position += count;
        }
        while (done < data.length) {
            let last = file.fragments[file.fragments.length - 1];
            if (!last || last.hole || last.size >= cap) {
                last = { hole: false, size: 0, offset: file.size, buf: new Uint8Array(0), dirty: true };
                file.fragments.push(last);
            }
            else {
                await this.#modify(file, last);
            }
            const count = Math.min(cap - last.size, data.length - done);
            this.#grow(file, last, last.size + count);
            last.buf.set(data.subarray(done, done + count), last.size - count);
            file.size += count;
            done += count;
            position += count;
        }
        file.contentDirty = true;
        this.#dirtyFiles.add(file);
        if (appendOnly) {
            file.hasher.update(data);
            file.hashed += data.length;
        }
        file.mtime = file.ctime = this.#now();
    }
    /** Cuts data fragments over the cap (the cap was lowered since they were written) into pieces. */
    #splitOversized(file) {
        const cap = this.maxFragmentBytes;
        for (let i = 0; i < file.fragments.length; i++) {
            const fragment = file.fragments[i];
            if (fragment.hole || fragment.size <= cap || !fragment.dirty)
                continue;
            const pieces = [];
            for (let at = 0; at < fragment.size; at += cap) {
                const size = Math.min(cap, fragment.size - at);
                pieces.push({ hole: false, size, offset: fragment.offset + at, buf: fragment.buf.subarray(at, at + size), dirty: true });
            }
            if (fragment.blob)
                file.obsolete.push(fragment.blob);
            file.fragments.splice(i, 1, ...pieces);
            i += pieces.length - 1;
        }
    }
    async #fileHash(file) {
        if (file.size === 0)
            return EMPTY_SHA256;
        if (file.hasher && file.hashed === file.size)
            return file.hasher.digestHex();
        const hasher = createHasher();
        for (const fragment of file.fragments) {
            if (fragment.hole)
                updateZeros(hasher, fragment.size);
            else
                hasher.update(await this.#data(fragment));
        }
        file.hasher = hasher;
        file.hashed = file.size;
        return hasher.digestHex();
    }
    // ---- committing --------------------------------------------------------------
    #commit(file) {
        return file.lock.write(() => this.#commitLocked(file));
    }
    async #commitLocked(file) {
        if (file.unlinked || file.retired)
            return;
        if (!file.pending && !file.contentDirty && !file.attrDirty) {
            this.#dirtyFiles.delete(file);
            return;
        }
        this.#assertWritable();
        await this.#ensureFile(file);
        const written = [];
        if (file.contentDirty) {
            this.#splitOversized(file);
            for (const fragment of file.fragments)
                if (fragment.dirty)
                    written.push(fragment);
            await forEachLimit(written, this.#concurrency, async (fragment) => {
                const data = fragment.buf.subarray(0, fragment.size);
                fragment.blob ??= this.#newId();
                fragment.sha256 = await sha256Hex(data);
                await this.store.putBlob(fragment.blob, data);
            });
            file.sha256 = await this.#fileHash(file);
        }
        const document = printDocument(this.#fileDocument(file));
        const stored = await this.#names.run(async () => {
            if (file.unlinked)
                return false;
            await this.store.putMetadata(this.#entryKey(file), document);
            file.pending = false;
            file.entry = this.#entryOf(file);
            this.#markIndex(file.parent);
            return true;
        });
        if (!stored)
            return;
        for (const fragment of written) {
            const bytes = fragment.buf;
            this.#cache.set(fragment.blob, bytes.length === fragment.size ? bytes : bytes.slice(0, fragment.size));
            fragment.buf = undefined;
            fragment.dirty = false;
        }
        this.#adjustDirty(file, -file.dirtyBytes);
        file.contentDirty = false;
        file.attrDirty = false;
        this.#dirtyFiles.delete(file);
        const old = file.obsolete.splice(0);
        await forEachLimit(old, this.#concurrency, async (id) => {
            this.#cache.delete(id);
            await this.store.deleteBlob(id).catch(() => { }); // an orphan is garbage, not damage
        });
    }
    /** Deletes the blobs of a file that has been unlinked and is no longer open. */
    async #retire(file) {
        await file.lock.write(async () => {
            if (!file.unlinked || file.opens > 0 || file.retired)
                return;
            file.retired = true;
            const blobs = [...file.obsolete, ...file.fragments.flatMap((fragment) => (fragment.blob ? [fragment.blob] : []))];
            file.obsolete = [];
            this.#adjustDirty(file, -file.dirtyBytes);
            file.fragments = [];
            file.contentDirty = file.attrDirty = false;
            this.#dirtyFiles.delete(file);
            await forEachLimit(blobs, this.#concurrency, async (id) => {
                this.#cache.delete(id);
                await this.store.deleteBlob(id).catch(() => { });
            });
        });
    }
    async #spill() {
        for (const file of [...this.#dirtyFiles]) {
            if (this.#dirtyBytes <= this.#maxDirty / 2)
                break;
            await this.#commit(file);
        }
    }
    async sync() {
        await this.ready();
        for (let round = 0; round < 4; round++) {
            for (const file of [...this.#dirtyFiles])
                await this.#commit(file);
            for (const dir of [...this.#dirtyDirectories]) {
                if (dir.timer) {
                    clearTimeout(dir.timer);
                    dir.timer = undefined;
                }
                await this.#names.run(() => this.#writeIndex(dir));
            }
            if (this.#dirtyFiles.size === 0 && this.#dirtyDirectories.size === 0)
                break;
        }
        const failure = this.#failure;
        if (failure !== undefined) {
            this.#failure = undefined;
            throw failure;
        }
    }
    async close() {
        if (this.#closed)
            return;
        try {
            if (this.#started)
                await this.sync();
        }
        finally {
            this.#closed = true;
            for (const dir of this.#dirtyDirectories)
                if (dir.timer)
                    clearTimeout(dir.timer);
            this.#cache.clear();
            await this.store.close?.();
        }
    }
    // ---- FS: reading ---------------------------------------------------------------
    #attributes(node) {
        const type = node.kind === "file" ? S_IFREG : node.kind === "directory" ? S_IFDIR : S_IFLNK;
        const size = node.kind === "file" ? node.size : node.kind === "symlink" ? utf8.encode(node.target).byteLength : 4096;
        return {
            mode: type | node.perm,
            size: BigInt(size),
            uid: node.uid,
            gid: node.gid,
            nlink: node.kind === "directory" ? 2 : node.unlinked ? 0 : 1,
            blockSize: 4096,
            blocks: BigInt(Math.ceil(size / 512)),
            mtime: toTimestamp(node.mtime),
            atime: toTimestamp(node.mtime),
            ctime: toTimestamp(node.ctime),
        };
    }
    async lookup(parent, name) {
        await this.ready();
        const dir = this.#directory(parent);
        await this.#ensureLoaded(dir);
        return dir.children.get(name);
    }
    async getattr(node) {
        await this.ready();
        await this.#ensureAttributes(node);
        return this.#attributes(node);
    }
    async readlink(node) {
        await this.ready();
        if (node.kind !== "symlink")
            throw new FSError("EINVAL");
        return node.target;
    }
    async opendir(node) {
        await this.ready();
        const dir = this.#directory(node);
        await this.#ensureLoaded(dir);
        return { node: dir, writable: false, released: false };
    }
    async readdir(node) {
        await this.ready();
        const dir = this.#directory(node);
        await this.#ensureLoaded(dir);
        return this.#sorted(dir).map((child) => ({ name: child.name, node: child }));
    }
    async releasedir() { }
    async open(node, flags) {
        await this.ready();
        const file = this.#file(node);
        const writable = (flags & O_ACCMODE) !== 0;
        if (writable || flags & O_TRUNC)
            this.#assertWritable();
        if (file.retired)
            throw new FSError("ENOENT");
        await this.#ensureFile(file);
        file.opens += 1;
        const handle = { node: file, writable, released: false };
        if (flags & O_TRUNC && writable) {
            try {
                await file.lock.write(async () => {
                    await this.#truncate(file, 0);
                    file.mtime = file.ctime = this.#now();
                });
            }
            catch (error) {
                file.opens -= 1;
                throw error;
            }
        }
        return handle;
    }
    async read(node, _handle, offset, length) {
        await this.ready();
        const file = this.#file(node);
        return file.lock.read(async () => {
            await this.#ensureFile(file);
            const start = Number(offset);
            if (!Number.isSafeInteger(start))
                throw new FSError("EINVAL");
            if (start >= file.size || length <= 0)
                return new Uint8Array(0);
            const end = Math.min(file.size, start + length);
            const out = new Uint8Array(end - start);
            let index = this.#findFragment(file, start);
            for (let position = start; position < end; index++) {
                const fragment = file.fragments[index];
                const stop = Math.min(fragment.offset + fragment.size, end);
                if (!fragment.hole) {
                    // The next fragment is on its way by the time a reader going through this one gets there.
                    const next = file.fragments[index + 1];
                    if (next && !next.hole && !next.buf && stop - fragment.offset >= fragment.size >> 1) {
                        this.#cache.prefetch(next.blob, () => this.#fetch(next));
                    }
                    const data = await this.#range(fragment, stop - fragment.offset);
                    out.set(data.subarray(position - fragment.offset, stop - fragment.offset), position - start);
                }
                position = stop;
            }
            return out;
        });
    }
    async statfs() {
        await this.ready();
        const blocks = this.#capacity / 4096n;
        return { blockSize: 4096, fragmentSize: 4096, blocks, blocksFree: blocks, blocksAvailable: blocks, files: 1n << 32n, filesFree: 1n << 31n, nameLength: MAX_NAME_BYTES };
    }
    // ---- FS: changing --------------------------------------------------------------
    async create(parent, name, flags, context) {
        await this.ready();
        this.#assertWritable();
        this.#validateName(name);
        const dir = this.#directory(parent);
        const file = await this.#names.run(async () => {
            await this.#ensureLoaded(dir);
            if (dir.children.has(name))
                throw new FSError("EEXIST");
            this.#checkConflict(dir, name, "file");
            const created = new FileNode(dir, name, context.mode & 0o7777, context.uid, context.gid, this.#now(), true);
            created.hasher = createHasher();
            created.opens = 1;
            dir.children.set(name, created);
            dir.sorted = undefined;
            this.#dirtyFiles.add(created);
            this.#touch(dir);
            return created;
        });
        return { node: file, handle: { node: file, writable: (flags & O_ACCMODE) !== 0, released: false } };
    }
    async write(node, handle, offset, data) {
        await this.ready();
        const file = this.#file(node);
        if (!handle.writable)
            throw new FSError("EBADF");
        this.#assertWritable();
        const start = Number(offset);
        if (!Number.isSafeInteger(start) || start + data.length > Number.MAX_SAFE_INTEGER)
            throw new FSError("EFBIG");
        if (data.length === 0)
            return 0;
        await file.lock.write(async () => {
            await this.#ensureFile(file);
            await this.#applyWrite(file, start, data);
        });
        if (this.#dirtyBytes > this.#maxDirty)
            await (this.#spilling ??= this.#spill().finally(() => (this.#spilling = undefined)));
        return data.length;
    }
    async setattr(node, set) {
        await this.ready();
        this.#assertWritable();
        const now = this.#now();
        const apply = () => {
            if (set.mode !== undefined)
                node.perm = set.mode & 0o7777;
            if (set.uid !== undefined)
                node.uid = set.uid;
            if (set.gid !== undefined)
                node.gid = set.gid;
            if (set.mtime !== undefined)
                node.mtime = set.mtime === "now" ? now : fromTimestamp(set.mtime);
            node.ctime = set.ctime ? fromTimestamp(set.ctime) : now;
        };
        if (node.kind === "directory") {
            await this.#ensureAttributes(node);
            apply();
            this.#markIndex(node);
            if (node.parent)
                this.#markIndex(node.parent);
        }
        else if (node.kind === "symlink") {
            apply();
            if (!node.unlinked) {
                await this.#names.run(() => this.store.putMetadata(this.#entryKey(node), printDocument(this.#symlinkDocument(node))));
                node.entry = this.#entryOf(node);
                this.#markIndex(node.parent);
            }
        }
        else {
            const file = node;
            await file.lock.write(async () => {
                await this.#ensureFile(file);
                if (set.size !== undefined) {
                    const size = Number(set.size);
                    if (!Number.isSafeInteger(size))
                        throw new FSError("EFBIG");
                    await this.#truncate(file, size);
                    if (set.mtime === undefined)
                        file.mtime = now;
                }
                apply();
                file.attrDirty = true;
                this.#dirtyFiles.add(file);
                // Nothing will flush a file nobody has open.
                if (file.opens === 0)
                    await this.#commitLocked(file);
            });
        }
        return this.#attributes(node);
    }
    async mkdir(parent, name, context) {
        await this.ready();
        this.#assertWritable();
        this.#validateName(name);
        const dir = this.#directory(parent);
        return this.#names.run(async () => {
            await this.#ensureLoaded(dir);
            if (dir.children.has(name))
                throw new FSError("EEXIST");
            this.#checkConflict(dir, name, "directory");
            const made = new DirectoryNode(dir, name, context.mode & 0o7777, context.uid, context.gid, this.#now());
            made.ready = true;
            await this.#writeIndex(made);
            dir.children.set(name, made);
            dir.sorted = undefined;
            this.#touch(dir);
            return made;
        });
    }
    async symlink(parent, name, target, context) {
        await this.ready();
        this.#assertWritable();
        this.#validateName(name);
        const dir = this.#directory(parent);
        return this.#names.run(async () => {
            await this.#ensureLoaded(dir);
            if (dir.children.has(name))
                throw new FSError("EEXIST");
            this.#checkConflict(dir, name, "symlink");
            const link = new SymlinkNode(dir, name, target, context.uid, context.gid, this.#now());
            await this.store.putMetadata(documentKey(this.#directoryPath(dir), name), printDocument(this.#symlinkDocument(link)));
            link.entry = this.#entryOf(link);
            dir.children.set(name, link);
            dir.sorted = undefined;
            this.#touch(dir);
            return link;
        });
    }
    async unlink(parent, name) {
        await this.ready();
        this.#assertWritable();
        const dir = this.#directory(parent);
        const removed = await this.#names.run(async () => {
            await this.#ensureLoaded(dir);
            const node = dir.children.get(name);
            if (!node)
                throw new FSError("ENOENT");
            if (node.kind === "directory")
                throw new FSError("EISDIR");
            // The blobs have to be known before the document that lists them goes.
            if (node.kind === "file" && !node.pending)
                await this.#ensureFile(node).catch(() => { });
            if (!(node.kind === "file" && node.pending))
                await this.store.deleteMetadata(this.#entryKey(node));
            dir.children.delete(name);
            dir.sorted = undefined;
            node.parent = undefined;
            node.unlinked = true;
            this.#touch(dir);
            return node;
        });
        if (removed.kind === "file")
            this.#retire(removed).catch((error) => this.#fail(error));
    }
    async rmdir(parent, name) {
        await this.ready();
        this.#assertWritable();
        const dir = this.#directory(parent);
        await this.#names.run(async () => {
            await this.#ensureLoaded(dir);
            const node = dir.children.get(name);
            if (!node)
                throw new FSError("ENOENT");
            if (node.kind !== "directory")
                throw new FSError("ENOTDIR");
            await this.#ensureLoaded(node);
            if (node.children.size > 0)
                throw new FSError("ENOTEMPTY");
            await this.#removeDirectory(node);
            dir.children.delete(name);
            dir.sorted = undefined;
            this.#touch(dir);
        });
    }
    async #removeDirectory(node) {
        const path = this.#directoryPath(node);
        await this.store.deleteMetadata(directoryKey(path));
        await this.store.removeMetadataDirectory?.(path);
        if (node.timer)
            clearTimeout(node.timer);
        node.timer = undefined;
        this.#dirtyDirectories.delete(node);
        node.parent = undefined;
        node.unlinked = true;
    }
    async rename(oldParent, oldName, newParent, newName) {
        await this.ready();
        this.#assertWritable();
        this.#validateName(newName);
        const from = this.#directory(oldParent);
        const to = this.#directory(newParent);
        const replaced = await this.#names.run(async () => {
            await this.#ensureLoaded(from);
            if (to !== from)
                await this.#ensureLoaded(to);
            const node = from.children.get(oldName);
            if (!node)
                throw new FSError("ENOENT");
            const target = to.children.get(newName);
            if (target === node)
                return undefined;
            if (node.kind === "directory") {
                for (let at = to; at; at = at.parent) {
                    if (at === node)
                        throw new FSError("EINVAL", "a directory cannot move into itself");
                }
            }
            if (target) {
                if (node.kind === "directory") {
                    if (target.kind !== "directory")
                        throw new FSError("ENOTDIR");
                    await this.#ensureLoaded(target);
                    if (target.children.size > 0)
                        throw new FSError("ENOTEMPTY");
                }
                else if (target.kind === "directory") {
                    throw new FSError("EISDIR");
                }
            }
            this.#checkConflict(to, newName, node.kind, target);
            if (node.kind === "directory") {
                const source = this.#directoryPath(node);
                if (target?.kind === "directory")
                    await this.#removeDirectory(target);
                const destination = (to === this.root ? "" : this.#directoryPath(to) + "/") + newName;
                await this.#moveDirectory(source, destination);
            }
            else if (!(node.kind === "file" && node.pending)) {
                // The committed document moves (a file's keeps its new name inside it);
                // anything not yet committed is written under the new name later.
                const oldKey = this.#entryKey(node);
                const newKey = documentKey(this.#directoryPath(to), newName);
                const bytes = await this.store.getMetadata(oldKey);
                if (!bytes)
                    throw new FSError("EIO", `FragmentedFS: ${oldKey} is missing`);
                const document = JSON.parse(new TextDecoder().decode(bytes));
                document.name = newName;
                await this.store.putMetadata(newKey, printDocument(document));
                await this.store.deleteMetadata(oldKey);
            }
            from.children.delete(oldName);
            node.parent = to;
            node.name = newName;
            to.children.set(newName, node);
            from.sorted = to.sorted = undefined;
            if (node.kind !== "directory" && node.entry)
                node.entry = { ...node.entry, name: newName, metadata: entryDocumentPath(newName, node.kind) };
            if (target && target.kind !== "directory") {
                target.parent = undefined;
                target.unlinked = true;
            }
            this.#touch(from);
            if (to !== from)
                this.#touch(to);
            if (node.kind === "directory")
                this.#markIndex(node);
            return target;
        });
        if (replaced?.kind === "file")
            this.#retire(replaced).catch((error) => this.#fail(error));
    }
    /** Moves a metadata folder, by the store's own rename when it has one. */
    async #moveDirectory(from, to) {
        if (this.store.renameMetadataDirectory) {
            await this.store.renameMetadataDirectory(from, to);
            return;
        }
        const list = this.store.listMetadata;
        if (!list)
            throw new FSError("EOPNOTSUPP", "this store cannot rename a directory");
        const copy = async (source, target) => {
            for (const item of (await list.call(this.store, source)) ?? []) {
                const sourceKey = (source === "" ? "" : source + "/") + item.name;
                const targetKey = (target === "" ? "" : target + "/") + item.name;
                if (item.directory) {
                    await copy(sourceKey, targetKey);
                }
                else {
                    const bytes = await this.store.getMetadata(sourceKey);
                    if (bytes)
                        await this.store.putMetadata(targetKey, bytes);
                }
            }
        };
        const remove = async (source) => {
            for (const item of (await list.call(this.store, source)) ?? []) {
                const sourceKey = (source === "" ? "" : source + "/") + item.name;
                if (item.directory)
                    await remove(sourceKey);
                else
                    await this.store.deleteMetadata(sourceKey);
            }
            await this.store.removeMetadataDirectory?.(source);
        };
        await copy(from, to);
        await remove(from);
    }
    async flush(node) {
        await this.ready();
        if (node.kind === "file")
            await this.#commit(node);
    }
    async fsync(node, _handle, dataOnly) {
        await this.ready();
        if (node.kind === "file") {
            await this.#commit(node);
            const parent = node.parent;
            if (!dataOnly && parent && this.#dirtyDirectories.has(parent)) {
                if (parent.timer) {
                    clearTimeout(parent.timer);
                    parent.timer = undefined;
                }
                await this.#names.run(() => this.#writeIndex(parent));
            }
        }
        else if (node.kind === "directory" && this.#dirtyDirectories.has(node)) {
            await this.#names.run(() => this.#writeIndex(node));
        }
    }
    async release(node, handle) {
        await this.ready();
        if (handle.released || node.kind !== "file")
            return;
        handle.released = true;
        node.opens -= 1;
        try {
            if (node.contentDirty || node.attrDirty || node.pending)
                await this.#commit(node);
        }
        finally {
            if (node.unlinked && node.opens === 0)
                this.#retire(node).catch((error) => this.#fail(error));
        }
    }
    async destroy() {
        await this.close();
    }
}
