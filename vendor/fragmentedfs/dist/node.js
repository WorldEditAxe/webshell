// SPDX-License-Identifier: MIT
//
// FragmentedFS on a host directory, for Node (and other runtimes with
// `process.getBuiltinModule`): a store that keeps `blobs/` and `metadata/` in a
// folder, and `packDirectory` / `unpackDirectory`, which split a host
// directory into a filesystem and assemble one back. The `node:` builtins are
// looked up when these are called, so nothing here imports them statically and
// a browser bundle stays free of them.
import { FSError } from "./contract.js";
import { directoryKey, documentKey, parseDirectoryDocument, parseEntryDocument } from "./format.js";
import { createHasher, randomHex } from "./sha256.js";
import { withMetadataPack } from "./pack.js";
import { forEachLimit } from "./sync.js";
function builtin(id) {
    const process = globalThis.process;
    const module = process?.getBuiltinModule?.(id);
    if (!module)
        throw new Error(`FragmentedFS on a host directory needs ${id}, which this runtime does not provide`);
    return module;
}
const KNOWN_ERRORS = new Set([
    "EPERM", "ENOENT", "EIO", "ENXIO", "EBADF", "EAGAIN", "ENOMEM", "EACCES", "EBUSY", "EEXIST",
    "EXDEV", "ENOTDIR", "EISDIR", "EINVAL", "ETXTBSY", "EFBIG", "ENOSPC", "ESPIPE", "EROFS",
    "EMLINK", "ERANGE", "ENAMETOOLONG", "ENOSYS", "ENOTEMPTY", "ELOOP", "ENODATA", "EOVERFLOW",
    "EOPNOTSUPP", "ESTALE", "EDQUOT",
]);
/** Maps a Node system error onto the FSError a guest should see. */
function translate(error) {
    const code = error?.code;
    if (typeof code === "string") {
        if (KNOWN_ERRORS.has(code))
            throw new FSError(code, error.message);
        if (code === "ENOTSUP")
            throw new FSError("EOPNOTSUPP");
    }
    throw error;
}
const absent = (error) => {
    const code = error?.code;
    return code === "ENOENT" || code === "ENOTDIR";
};
const TEMPORARY = /\.tmp-[0-9a-f]{8}$/;
const CHUNK = 1 << 20;
/**
 * Keeps a FragmentedFS in the `blobs` and `metadata` folders of a host
 * directory. Anything that serves the directory over HTTP serves the same
 * filesystem to `httpFragmentStore`.
 */
export function nodeDirectoryFragmentStore(directory, options = {}) {
    const fs = builtin("node:fs/promises");
    const path = builtin("node:path");
    const base = path.resolve(directory);
    const metadataBase = path.join(base, "metadata");
    const blobBase = path.join(base, "blobs");
    const writable = !options.readOnly;
    /** A key's host path; every segment is a plain name, so no key leaves its folder. */
    function locate(root, key) {
        const parts = key === "" ? [] : key.split("/");
        for (const part of parts) {
            if (part === "" || part === "." || part === ".." || part.includes("\0") || part.includes("\\")) {
                throw new FSError("EINVAL", `${JSON.stringify(key)} is not a usable path`);
            }
        }
        return path.join(root, ...parts);
    }
    function assertWritable() {
        if (!writable)
            throw new FSError("EROFS");
    }
    async function read(target) {
        try {
            const bytes = await fs.readFile(target);
            return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        }
        catch (error) {
            if (absent(error))
                return undefined;
            return translate(error);
        }
    }
    /** Writes beside the target and renames over it, so a reader never sees half a file. */
    async function write(target, data) {
        assertWritable();
        try {
            await fs.mkdir(path.dirname(target), { recursive: true });
            const temporary = `${target}.tmp-${randomHex(4)}`;
            const file = await fs.open(temporary, "wx", 0o644);
            try {
                for (let at = 0; at < data.byteLength;) {
                    const { bytesWritten } = await file.write(data, at, Math.min(data.byteLength - at, CHUNK), at);
                    if (bytesWritten <= 0)
                        throw new FSError("EIO", `short write to ${temporary}`);
                    at += bytesWritten;
                }
                if (options.durable)
                    await file.sync();
            }
            catch (error) {
                await file.close().catch(() => { });
                await fs.unlink(temporary).catch(() => { });
                throw error;
            }
            await file.close();
            try {
                await fs.rename(temporary, target);
            }
            catch (error) {
                await fs.unlink(temporary).catch(() => { });
                throw error;
            }
        }
        catch (error) {
            if (error instanceof FSError)
                throw error;
            translate(error);
        }
    }
    async function remove(target) {
        assertWritable();
        try {
            await fs.unlink(target);
        }
        catch (error) {
            if (!absent(error))
                translate(error);
        }
    }
    async function list(folder) {
        try {
            const out = [];
            for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
                if (TEMPORARY.test(entry.name))
                    continue;
                if (entry.isDirectory())
                    out.push({ name: entry.name, directory: true });
                else if (entry.isFile())
                    out.push({ name: entry.name, directory: false });
            }
            return out;
        }
        catch (error) {
            if (absent(error))
                return undefined;
            return translate(error);
        }
    }
    const store = {
        writable,
        // async, so that a bad key is a rejected promise like any other failure
        getMetadata: async (key) => read(locate(metadataBase, key)),
        putMetadata: async (key, data) => write(locate(metadataBase, key), data),
        deleteMetadata: async (key) => remove(locate(metadataBase, key)),
        listMetadata: async (directory) => list(locate(metadataBase, directory)),
        async renameMetadataDirectory(from, to) {
            assertWritable();
            try {
                const target = locate(metadataBase, to);
                await fs.mkdir(path.dirname(target), { recursive: true });
                await fs.rename(locate(metadataBase, from), target);
            }
            catch (error) {
                translate(error);
            }
        },
        async removeMetadataDirectory(directory) {
            assertWritable();
            // Not empty (a stray temporary file, say): leaving the folder is harmless.
            await fs.rmdir(locate(metadataBase, directory)).catch(() => { });
        },
        getBlob: async (id) => read(locate(blobBase, id)),
        putBlob: async (id, data) => write(locate(blobBase, id), data),
        deleteBlob: async (id) => remove(locate(blobBase, id)),
        async listBlobs() {
            return ((await list(blobBase)) ?? []).filter((entry) => !entry.directory).map((entry) => entry.name);
        },
    };
    return withMetadataPack(store, (name) => read(locate(base, name)));
}
const O_WRONLY = 1;
const O_CREAT = 0o100;
const O_EXCL = 0o200;
const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;
const timestamp = (ns) => ({ seconds: ns / 1000000000n, nanoseconds: Number(ns % 1000000000n) });
/**
 * Splits a host directory into a filesystem: every file is cut into
 * fragments, every directory and symlink gets its documents. Modes, owners
 * and modification times are carried over. `destination` is not synced; call
 * its `sync()` (or `close()`) when this resolves.
 */
export async function packDirectory(directory, destination, options = {}) {
    const fs = builtin("node:fs/promises");
    const path = builtin("node:path");
    const result = { directories: 0, files: 0, symlinks: 0, bytes: 0, skipped: 0 };
    if (!destination.create || !destination.write || !destination.mkdir || !destination.symlink) {
        throw new FSError("EROFS", "the destination cannot be written");
    }
    async function walk(folder, parent, prefix) {
        const entries = (await fs.readdir(folder, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        for (const entry of entries) {
            const host = path.join(folder, entry.name);
            const stats = await fs.lstat(host, { bigint: true });
            const name = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
            const context = { mode: Number(stats.mode), uid: Number(stats.uid), gid: Number(stats.gid) };
            let made;
            if (stats.isDirectory()) {
                made = await destination.mkdir(parent, entry.name, context);
                result.directories += 1;
                await walk(host, made, name);
            }
            else if (stats.isSymbolicLink()) {
                made = await destination.symlink(parent, entry.name, await fs.readlink(host), context);
                result.symlinks += 1;
                continue;
            }
            else if (stats.isFile()) {
                const input = await fs.open(host, "r");
                try {
                    const created = await destination.create(parent, entry.name, O_WRONLY | O_CREAT | O_EXCL, context);
                    made = created.node;
                    try {
                        const buffer = new Uint8Array(CHUNK);
                        for (let at = 0;;) {
                            const { bytesRead } = await input.read(buffer, 0, CHUNK, at);
                            if (bytesRead === 0)
                                break;
                            const chunk = buffer.subarray(0, bytesRead);
                            for (let done = 0; done < chunk.byteLength;) {
                                done += await destination.write(created.node, created.handle, BigInt(at + done), chunk.subarray(done));
                            }
                            at += bytesRead;
                            result.bytes += bytesRead;
                        }
                        await destination.flush?.(created.node, created.handle);
                    }
                    finally {
                        await destination.release?.(created.node, created.handle);
                    }
                }
                finally {
                    await input.close();
                }
                result.files += 1;
                options.onFile?.(name, Number(stats.size));
            }
            else {
                result.skipped += 1;
                continue;
            }
            await destination.setattr?.(made, {
                mode: Number(stats.mode) & 0o7777,
                uid: Number(stats.uid),
                gid: Number(stats.gid),
                mtime: timestamp(stats.mtimeNs),
            });
        }
    }
    const top = path.resolve(directory);
    await walk(top, destination.root, "");
    const stats = await fs.lstat(top, { bigint: true });
    await destination.setattr?.(destination.root, {
        mode: Number(stats.mode) & 0o7777,
        uid: Number(stats.uid),
        gid: Number(stats.gid),
        mtime: timestamp(stats.mtimeNs),
    });
    return result;
}
/**
 * Assembles a filesystem into a host directory (created if need be, and
 * empty): the inverse of `packDirectory`. Owners are restored where the
 * process may; everything else is exact.
 */
export async function unpackDirectory(source, directory) {
    const fs = builtin("node:fs/promises");
    const path = builtin("node:path");
    const result = { directories: 0, files: 0, symlinks: 0, bytes: 0, skipped: 0 };
    if (!source.readdir || !source.open || !source.read)
        throw new FSError("EOPNOTSUPP", "the source cannot be read");
    async function finish(host, attributes, link = false) {
        await fs.lchown(host, attributes.uid ?? 0, attributes.gid ?? 0).catch(() => { }); // only root may
        if (!link)
            await fs.chmod(host, attributes.mode & 0o7777);
        const mtime = Number(attributes.mtime?.seconds ?? 0n) + (attributes.mtime?.nanoseconds ?? 0) / 1e9;
        await fs.lutimes(host, mtime, mtime).catch(() => { });
    }
    async function walk(parent, folder) {
        const handle = await source.opendir?.(parent, 0);
        const entries = [];
        try {
            for await (const entry of await source.readdir(parent, handle))
                entries.push(entry);
        }
        finally {
            if (handle !== undefined)
                await source.releasedir?.(parent, handle);
        }
        entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        for (const entry of entries) {
            const host = path.join(folder, entry.name);
            const attributes = await source.getattr(entry.node);
            switch (attributes.mode & S_IFMT) {
                case S_IFDIR:
                    await fs.mkdir(host, { mode: 0o700 });
                    result.directories += 1;
                    await walk(entry.node, host);
                    await finish(host, attributes);
                    break;
                case S_IFLNK:
                    await fs.symlink(await source.readlink(entry.node), host);
                    result.symlinks += 1;
                    await finish(host, attributes, true);
                    break;
                case S_IFREG: {
                    const input = await source.open(entry.node, 0);
                    try {
                        const output = await fs.open(host, "wx", 0o600);
                        try {
                            const size = attributes.size;
                            for (let at = 0n; at < size;) {
                                const data = await source.read(entry.node, input, at, Number(size - at < BigInt(CHUNK) ? size - at : BigInt(CHUNK)));
                                if (data.byteLength === 0)
                                    throw new FSError("EIO", `${host} is shorter than its document says`);
                                for (let done = 0; done < data.byteLength;) {
                                    const { bytesWritten } = await output.write(data, done, data.byteLength - done, Number(at) + done);
                                    done += bytesWritten;
                                }
                                at += BigInt(data.byteLength);
                                result.bytes += data.byteLength;
                            }
                        }
                        finally {
                            await output.close();
                        }
                    }
                    finally {
                        await source.release?.(entry.node, input);
                    }
                    result.files += 1;
                    await finish(host, attributes);
                    break;
                }
                default:
                    result.skipped += 1;
            }
        }
    }
    const target = path.resolve(directory);
    await fs.mkdir(target, { recursive: true });
    await walk(source.root, target);
    await finish(target, await source.getattr(source.root));
    return result;
}
/**
 * Checks that a store is a faithful copy of a host directory, without going
 * through the filesystem: every entry of the directory is in the store and
 * every entry of the store is in the directory, with the same type; each file
 * has the size, SHA-256 (the host file is hashed again here, not trusted),
 * mode, owner and modification time its document gives; each symlink the same
 * target; each directory the same mode and owner. `verifyFragmentedFS` says a
 * store is consistent with itself; this says it is consistent with its source.
 */
export async function compareDirectory(directory, store, options = {}) {
    const fs = builtin("node:fs/promises");
    const path = builtin("node:path");
    const report = { directories: 0, files: 0, symlinks: 0, bytes: 0, mismatches: [] };
    const differ = (message) => {
        report.mismatches.push(message);
    };
    const compareTimes = options.times ?? true;
    const mode = (where, stats, doc) => {
        if ((Number(stats.mode) & 0o7777) !== doc.mode)
            differ(`${where}: mode ${(Number(stats.mode) & 0o7777).toString(8)} in the directory, ${doc.mode.toString(8)} in the store`);
        if (Number(stats.uid) !== doc.uid || Number(stats.gid) !== doc.gid)
            differ(`${where}: owner ${stats.uid}:${stats.gid} in the directory, ${doc.uid}:${doc.gid} in the store`);
    };
    const tolerance = BigInt(options.timeToleranceNs ?? 0);
    const time = (where, stats, doc) => {
        if (!compareTimes)
            return;
        const apart = stats.mtimeNs - (BigInt(doc.mtime) * 1000000000n + BigInt(doc.mtimeNsec));
        if ((apart < 0n ? -apart : apart) > tolerance)
            differ(`${where}: modification time differs`);
    };
    async function hash(host) {
        const hasher = createHasher();
        const input = await fs.open(host, "r");
        try {
            const buffer = new Uint8Array(CHUNK);
            let size = 0;
            for (;;) {
                const { bytesRead } = await input.read(buffer, 0, CHUNK, size);
                if (bytesRead === 0)
                    break;
                hasher.update(buffer.subarray(0, bytesRead));
                size += bytesRead;
            }
            return { sha256: hasher.digestHex(), size };
        }
        finally {
            await input.close();
        }
    }
    async function walk(folder, key, where) {
        const raw = await store.getMetadata(directoryKey(key));
        if (!raw)
            return differ(`${where || "/"}: the store has no directory document`);
        const doc = parseDirectoryDocument(directoryKey(key), raw);
        report.directories += 1;
        const entries = new Map(doc.entries.map((entry) => [entry.name, entry]));
        const host = await fs.readdir(folder, { withFileTypes: true });
        const seen = new Set();
        const files = [];
        for (const dirent of host.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
            const at = where === "" ? dirent.name : `${where}/${dirent.name}`;
            const hostPath = path.join(folder, dirent.name);
            const stats = await fs.lstat(hostPath, { bigint: true });
            const kind = stats.isDirectory() ? "directory" : stats.isSymbolicLink() ? "symlink" : stats.isFile() ? "file" : undefined;
            if (!kind)
                continue; // devices, FIFOs and sockets are not packed
            seen.add(dirent.name);
            const entry = entries.get(dirent.name);
            if (!entry) {
                differ(`${at}: in the directory, not in the store`);
                continue;
            }
            if (entry.type !== kind) {
                differ(`${at}: a ${kind} in the directory, a ${entry.type} in the store`);
                continue;
            }
            const documentPath = documentKey(key, dirent.name);
            if (kind === "directory") {
                const childKey = key === "" ? dirent.name : `${key}/${dirent.name}`;
                const child = await store.getMetadata(directoryKey(childKey));
                if (child) {
                    const childDoc = parseDirectoryDocument(directoryKey(childKey), child);
                    mode(at, stats, childDoc);
                    time(at, stats, childDoc);
                }
                await walk(hostPath, childKey, at);
            }
            else if (kind === "symlink") {
                report.symlinks += 1;
                const bytes = await store.getMetadata(documentPath);
                if (!bytes) {
                    differ(`${at}: the store has no document for it`);
                    continue;
                }
                const linkDoc = parseEntryDocument(documentPath, bytes);
                const target = await fs.readlink(hostPath);
                if (linkDoc.type !== "symlink" || linkDoc.target !== target)
                    differ(`${at}: points to ${target} in the directory, ${linkDoc.type === "symlink" ? linkDoc.target : "nothing"} in the store`);
            }
            else {
                files.push({ host: hostPath, name: dirent.name, at, stats });
            }
        }
        for (const name of entries.keys())
            if (!seen.has(name))
                differ(`${where === "" ? name : `${where}/${name}`}: in the store, not in the directory`);
        await forEachLimit(files, options.concurrency ?? 4, async (file) => {
            options.onFile?.(file.at);
            const documentPath = documentKey(key, file.name);
            const bytes = await store.getMetadata(documentPath);
            if (!bytes)
                return differ(`${file.at}: the store has no document for it`);
            const fileDoc = parseEntryDocument(documentPath, bytes);
            if (fileDoc.type !== "file")
                return differ(`${file.at}: a file in the directory, a ${fileDoc.type} in the store`);
            report.files += 1;
            const { sha256, size } = await hash(file.host);
            report.bytes += size;
            if (size !== fileDoc.size)
                differ(`${file.at}: ${size} bytes in the directory, ${fileDoc.size} in the store`);
            if (sha256 !== fileDoc.sha256)
                differ(`${file.at}: SHA-256 ${sha256} in the directory, ${fileDoc.sha256} in the store`);
            mode(file.at, file.stats, fileDoc);
            time(file.at, file.stats, fileDoc);
        });
    }
    const top = path.resolve(directory);
    const rootStats = await fs.lstat(top, { bigint: true });
    const rootRaw = await store.getMetadata(directoryKey(""));
    if (rootRaw)
        mode("/", rootStats, parseDirectoryDocument(directoryKey(""), rootRaw));
    await walk(top, "", "");
    return report;
}
