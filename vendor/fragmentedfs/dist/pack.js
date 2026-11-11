// SPDX-License-Identifier: MIT
//
// A published store's metadata as one binary file, cut into segments
// (docs/FORMAT.md): `metadata.pack.0`, `metadata.pack.1`, ... beside `blobs/`, in place of the
// `metadata/` folder. A store of ten thousand files has ten thousand documents, and static hosts count
// files. The documents are not kept as such: a directory's entries are the documents of what it holds, written once, and
// hashes and blob names are raw bytes. Readers get the same documents back; a packed store is read-only.
import { FSError } from "./contract.js";
import { DIRECTORY_DOCUMENT, DOCUMENT_SUFFIX, FORMAT, directoryKey, documentKey, entryDocumentPath, isEntryName, parseDirectoryDocument, parseEntryDocument, printDocument, } from "./format.js";
import { sha256Hex, toHex } from "./sha256.js";
const MAGIC = [0x46, 0x46, 0x4d, 0x50]; // "FFMP"
const VERSION = 1;
const SHA256_BYTES = 32;
const TYPES = ["file", "directory", "symlink"];
const ENTRY_HAS_OWN_ATTRIBUTES = 4;
const FRAGMENT_HOLE = 1;
const FRAGMENT_IS_WHOLE_FILE = 2;
export const DEFAULT_SEGMENT_BYTES = 8 * 1024 * 1024;
/** The name of a segment, in the folder that holds `blobs/`. */
export const metadataSegmentName = (index) => `metadata.pack.${index}`;
const corrupt = (why) => {
    throw new FSError("EIO", `FragmentedFS: the metadata pack ${why}`);
};
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
class Writer {
    #bytes = new Uint8Array(1 << 16);
    length = 0;
    #room(count) {
        if (this.length + count <= this.#bytes.length)
            return;
        const grown = new Uint8Array(Math.max(this.#bytes.length * 2, this.length + count));
        grown.set(this.#bytes.subarray(0, this.length));
        this.#bytes = grown;
    }
    byte(value) {
        this.#room(1);
        this.#bytes[this.length++] = value;
    }
    /** Numbers up to 2^53: by division, as bit operators stop at 32 bits. */
    number(value) {
        while (value >= 0x80) {
            this.byte((value % 0x80) | 0x80);
            value = Math.floor(value / 0x80);
        }
        this.byte(value);
    }
    raw(bytes) {
        this.#room(bytes.length);
        this.#bytes.set(bytes, this.length);
        this.length += bytes.length;
    }
    text(value) {
        const bytes = encoder.encode(value);
        this.number(bytes.length);
        this.raw(bytes);
    }
    hex(value) {
        const bytes = new Uint8Array(value.length >> 1);
        for (let at = 0; at < bytes.length; at++)
            bytes[at] = Number.parseInt(value.slice(at * 2, at * 2 + 2), 16);
        this.raw(bytes);
    }
    done() {
        return this.#bytes.subarray(0, this.length);
    }
}
class Reader {
    at = 0;
    #bytes;
    constructor(bytes) {
        this.#bytes = bytes;
    }
    get finished() {
        return this.at === this.#bytes.length;
    }
    byte() {
        if (this.at >= this.#bytes.length)
            corrupt("ends early");
        return this.#bytes[this.at++];
    }
    number() {
        let value = 0;
        for (let scale = 1;; scale *= 0x80) {
            const byte = this.byte();
            value += (byte & 0x7f) * scale;
            if (!Number.isSafeInteger(value))
                corrupt("holds a number out of range");
            if (byte < 0x80)
                return value;
        }
    }
    raw(count) {
        if (count > this.#bytes.length - this.at)
            corrupt("ends early");
        const out = this.#bytes.subarray(this.at, this.at + count);
        this.at += count;
        return out;
    }
    text() {
        const bytes = this.raw(this.number());
        try {
            return decoder.decode(bytes);
        }
        catch {
            return corrupt("holds a name that is not UTF-8");
        }
    }
    hex(byteCount) {
        return toHex(this.raw(byteCount));
    }
}
function writeAttributes(out, doc) {
    out.text(doc.name);
    out.number(doc.mode);
    out.number(doc.uid);
    out.number(doc.gid);
    out.number(doc.mtime);
    out.number(doc.mtimeNsec);
    out.number(doc.ctime);
    out.number(doc.ctimeNsec);
}
function readAttributes(input) {
    return {
        name: input.text(),
        mode: input.number(),
        uid: input.number(),
        gid: input.number(),
        mtime: input.number(),
        mtimeNsec: input.number(),
        ctime: input.number(),
        ctimeNsec: input.number(),
    };
}
const sameAttributes = (a, b) => a.mode === b.mode && a.uid === b.uid && a.gid === b.gid &&
    a.mtime === b.mtime && a.mtimeNsec === b.mtimeNsec && a.ctime === b.ctime && a.ctimeNsec === b.ctimeNsec;
function writeFile(out, doc) {
    writeAttributes(out, doc);
    out.number(doc.size);
    out.hex(doc.sha256);
    out.number(doc.fragments.length);
    for (const fragment of doc.fragments) {
        const whole = fragment.sha256 === doc.sha256;
        out.byte((fragment.hole ? FRAGMENT_HOLE : 0) | (whole ? FRAGMENT_IS_WHOLE_FILE : 0));
        out.number(fragment.size);
        if (fragment.hole)
            continue;
        // A blob name is any length of hex: its length in digits, then the digits as bytes, an odd one padded with a 0.
        out.number(fragment.blob.length);
        out.hex(fragment.blob.length % 2 ? `${fragment.blob}0` : fragment.blob);
        if (!whole)
            out.hex(fragment.sha256);
    }
}
function readFile(input) {
    const attributes = readAttributes(input);
    const size = input.number();
    const sha256 = input.hex(SHA256_BYTES);
    const count = input.number();
    const fragments = [];
    for (let index = 0; index < count; index++) {
        const flags = input.byte();
        const fragment = { index, size: input.number() };
        if (flags & FRAGMENT_HOLE) {
            fragment.hole = true;
        }
        else {
            const digits = input.number();
            if (digits === 0 || digits > 128)
                corrupt("holds a blob name of a bad length");
            fragment.blob = input.hex((digits + 1) >> 1).slice(0, digits);
            fragment.sha256 = flags & FRAGMENT_IS_WHOLE_FILE ? sha256 : input.hex(SHA256_BYTES);
        }
        fragments.push(fragment);
    }
    return { format: FORMAT, type: "file", ...attributes, size, sha256, fragments };
}
/** Packs every document a store's directory tree reaches. Nothing is written. */
export async function packMetadata(store, options = {}) {
    const maxSegmentBytes = options.maxSegmentBytes ?? DEFAULT_SEGMENT_BYTES;
    if (!(maxSegmentBytes >= 64))
        throw new FSError("EINVAL", "a segment must hold at least 64 bytes");
    const body = new Writer();
    let documents = 0;
    let jsonBytes = 0;
    async function load(key) {
        const raw = await store.getMetadata(key);
        if (!raw)
            throw new FSError("EIO", `FragmentedFS: ${key} is listed but missing`);
        documents += 1;
        jsonBytes += raw.byteLength;
        return raw;
    }
    async function writeDirectory(directory, doc) {
        writeAttributes(body, doc);
        body.number(doc.maxFragmentBytes === undefined ? 0 : doc.maxFragmentBytes + 1);
        body.number(doc.entries.length);
        for (const entry of doc.entries) {
            const what = directory === "" ? entry.name : `${directory}/${entry.name}`;
            const differ = (why) => new FSError("EIO", `FragmentedFS: ${what}: ${why}: the store is not consistent, so it cannot be packed`);
            if (entry.metadata !== entryDocumentPath(entry.name, entry.type))
                throw differ(`its document is at ${entry.metadata}`);
            const type = TYPES.indexOf(entry.type);
            if (entry.type === "directory") {
                const key = directoryKey(what);
                const child = parseDirectoryDocument(key, await load(key));
                if (child.name !== entry.name)
                    throw differ(`its document names ${child.name}`);
                body.byte(type | (sameAttributes(entry, child) ? 0 : ENTRY_HAS_OWN_ATTRIBUTES));
                if (!sameAttributes(entry, child))
                    writeAttributes(body, entry);
                await writeDirectory(what, child);
                continue;
            }
            const key = documentKey(directory, entry.name);
            const child = parseEntryDocument(key, await load(key));
            if (child.name !== entry.name)
                throw differ(`its document names ${child.name}`);
            if (child.type !== entry.type)
                throw differ(`its document says it is a ${child.type}`);
            body.byte(type | (sameAttributes(entry, child) ? 0 : ENTRY_HAS_OWN_ATTRIBUTES));
            if (!sameAttributes(entry, child))
                writeAttributes(body, entry);
            if (child.type === "symlink") {
                if (child.target !== entry.target)
                    throw differ("its target differs from its document's");
                writeAttributes(body, child);
                body.text(child.target);
            }
            else {
                if (child.size !== entry.size || child.sha256 !== entry.sha256)
                    throw differ("its size or hash differs from its document's");
                writeFile(body, child);
            }
        }
    }
    const rootKey = directoryKey("");
    await writeDirectory("", parseDirectoryDocument(rootKey, await load(rootKey)));
    const content = body.done();
    const hash = await sha256Hex(content);
    // The header says how many segments there are, and is part of the first: count until that settles.
    let count = 1;
    for (;;) {
        const header = new Writer();
        header.raw(new Uint8Array(MAGIC));
        header.byte(VERSION);
        header.number(count);
        header.number(content.length);
        header.hex(hash);
        const total = header.length + content.length;
        const needed = Math.max(1, Math.ceil(total / maxSegmentBytes));
        if (needed !== count) {
            count = needed;
            continue;
        }
        const whole = new Uint8Array(total);
        whole.set(header.done());
        whole.set(content, header.length);
        const segments = [];
        for (let at = 0; at < total || segments.length === 0; at += maxSegmentBytes) {
            segments.push(whole.subarray(at, at + maxSegmentBytes));
        }
        return { segments, documents, jsonBytes, bytes: total };
    }
}
/** Reads a pack through `read`, which fetches a file beside `blobs/`; `undefined` when the store has none. */
export async function loadMetadataPack(read) {
    const first = await read(metadataSegmentName(0));
    if (!first)
        return undefined;
    const header = new Reader(first);
    for (const byte of MAGIC)
        if (header.byte() !== byte)
            corrupt("is not one (a wrong first segment)");
    const version = header.byte();
    if (version !== VERSION)
        corrupt(`has version ${version}`);
    const count = header.number();
    const length = header.number();
    const hash = header.hex(SHA256_BYTES);
    if (count === 0)
        corrupt("has no segments");
    const rest = await Promise.all(Array.from({ length: count - 1 }, async (_, at) => {
        const segment = await read(metadataSegmentName(at + 1));
        return segment ?? corrupt(`has no segment ${at + 1}`);
    }));
    const content = new Uint8Array(length);
    let filled = 0;
    for (const part of [first.subarray(header.at), ...rest]) {
        if (filled + part.length > length)
            corrupt("is longer than it says");
        content.set(part, filled);
        filled += part.length;
    }
    if (filled !== length)
        corrupt("is shorter than it says");
    if ((await sha256Hex(content)) !== hash)
        corrupt("does not match its SHA-256");
    const input = new Reader(content);
    const documents = new Map();
    const listings = new Map();
    function checkedName(name) {
        if (!isEntryName(name))
            corrupt(`holds the unusable name ${JSON.stringify(name)}`);
        return name;
    }
    function readDirectory(parent) {
        const attributes = readAttributes(input);
        const directory = parent === null ? "" : parent === "" ? checkedName(attributes.name) : `${parent}/${checkedName(attributes.name)}`;
        const cap = input.number();
        const doc = { format: FORMAT, type: "directory", ...attributes, entries: [] };
        if (cap > 0)
            doc.maxFragmentBytes = cap - 1;
        documents.set(directoryKey(directory), doc);
        const listing = [{ name: DIRECTORY_DOCUMENT, directory: false }];
        listings.set(directory, listing);
        const count = input.number();
        for (let at = 0; at < count; at++) {
            const tag = input.byte();
            const type = TYPES[tag & 3];
            if (!type || tag & ~(3 | ENTRY_HAS_OWN_ATTRIBUTES))
                return corrupt("holds an unknown entry");
            const own = tag & ENTRY_HAS_OWN_ATTRIBUTES ? readAttributes(input) : undefined;
            let entry;
            if (type === "directory") {
                const child = readDirectory(directory);
                entry = { ...attributesOf(child), ...own, name: child.name, type, metadata: entryDocumentPath(child.name, type) };
                listing.push({ name: child.name, directory: true });
            }
            else {
                let child;
                if (type === "symlink") {
                    child = { format: FORMAT, type, ...readAttributes(input), target: input.text() };
                }
                else {
                    child = readFile(input);
                }
                checkedName(child.name);
                documents.set(documentKey(directory, child.name), child);
                listing.push({ name: child.name + DOCUMENT_SUFFIX, directory: false });
                entry = { ...attributesOf(child), ...own, name: child.name, type, metadata: entryDocumentPath(child.name, type) };
                if (child.type === "file") {
                    entry.size = child.size;
                    entry.sha256 = child.sha256;
                }
                else {
                    entry.target = child.target;
                }
            }
            doc.entries.push(entry);
        }
        return doc;
    }
    readDirectory(null);
    if (!input.finished)
        corrupt("has bytes after its last document");
    return {
        get(key) {
            const doc = documents.get(key);
            return doc && printDocument(doc);
        },
        list: (directory) => listings.get(directory),
    };
}
function attributesOf(doc) {
    const { name, mode, uid, gid, mtime, mtimeNsec, ctime, ctimeNsec } = doc;
    return { name, mode, uid, gid, mtime, mtimeNsec, ctime, ctimeNsec };
}
/**
 * Throws unless two stores hold the same documents: how a pack is checked against the documents it replaces, before they go.
 * Returns how many it compared.
 */
export async function compareMetadata(a, b) {
    let compared = 0;
    const differ = (key) => {
        throw new FSError("EIO", `FragmentedFS: ${key} differs between the two stores`);
    };
    const canonical = async (store, key, parse) => {
        const raw = await store.getMetadata(key);
        return raw ? JSON.stringify(parse(key, raw)) : differ(key);
    };
    async function walk(directory) {
        const key = directoryKey(directory);
        const left = await canonical(a, key, parseDirectoryDocument);
        if (left !== (await canonical(b, key, parseDirectoryDocument)))
            differ(key);
        compared += 1;
        for (const entry of JSON.parse(left).entries) {
            const path = directory === "" ? entry.name : `${directory}/${entry.name}`;
            if (entry.type === "directory") {
                await walk(path);
                continue;
            }
            const child = documentKey(directory, entry.name);
            if ((await canonical(a, child, parseEntryDocument)) !== (await canonical(b, child, parseEntryDocument)))
                differ(child);
            compared += 1;
        }
    }
    await walk("");
    return compared;
}
/**
 * Reads the documents from a pack when the store has one, and `store`'s own otherwise. `read` fetches a
 * file beside `blobs/`. Whether there is a pack is settled once, at the first read.
 */
export function withMetadataPack(store, read) {
    let loading;
    const pack = () => {
        loading ??= loadMetadataPack(read);
        // A failed read must not poison later attempts.
        loading.catch(() => (loading = undefined));
        return loading;
    };
    const refuseIfPacked = async () => {
        if (await pack())
            throw new FSError("EROFS", "FragmentedFS: a store with a metadata pack is read-only");
    };
    const wrapped = {
        ...store,
        async getMetadata(key) {
            const packed = await pack();
            return packed ? packed.get(key) : store.getMetadata(key);
        },
        async putMetadata(key, data) {
            await refuseIfPacked();
            return store.putMetadata(key, data);
        },
        async deleteMetadata(key) {
            await refuseIfPacked();
            return store.deleteMetadata(key);
        },
    };
    if (store.listMetadata) {
        wrapped.listMetadata = async (directory) => {
            const packed = await pack();
            return packed ? packed.list(directory) : store.listMetadata(directory);
        };
    }
    if (store.renameMetadataDirectory) {
        wrapped.renameMetadataDirectory = async (from, to) => {
            await refuseIfPacked();
            return store.renameMetadataDirectory(from, to);
        };
    }
    if (store.removeMetadataDirectory) {
        wrapped.removeMetadataDirectory = async (directory) => {
            await refuseIfPacked();
            return store.removeMetadataDirectory(directory);
        };
    }
    return wrapped;
}
