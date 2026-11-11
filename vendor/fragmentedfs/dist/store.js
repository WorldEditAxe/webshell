// SPDX-License-Identifier: MIT
//
// Where a FragmentedFS keeps its two folders. A `FragmentStore` is the whole
// storage contract: documents under `metadata/` and blobs under `blobs/`.
// Any `FS` backend (a host directory, OPFS, IndexedDB, an HTTP tree) can hold
// them through `fsFragmentStore`; `nodeDirectoryFragmentStore` (node.ts) keeps
// them in a host directory; `httpFragmentStore` reads them straight from a
// static web server with no manifest, and `memoryFragmentStore` keeps them in
// maps.
import { FSError, errnoOf } from "./contract.js";
import { withMetadataPack } from "./pack.js";
import { randomHex } from "./sha256.js";
import { Mutex } from "./sync.js";
const O_RDWR = 0o2;
const O_CREAT = 0o100;
const O_EXCL = 0o200;
const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const FILE_CONTEXT = { mode: 0o644, uid: 0, gid: 0 };
const DIRECTORY_CONTEXT = { mode: 0o755, uid: 0, gid: 0 };
const TEMPORARY = /\.tmp-[0-9a-f]{8}$/;
const segments = (key) => (key === "" ? [] : key.split("/"));
// By name and errno, not class: the backend is not necessarily written against this copy of FSError.
const failedWith = (error, code) => errnoOf(error) === new FSError(code).errno;
/**
 * Keeps a FragmentedFS in the `blobs` and `metadata` folders of any `FS`
 * backend, creating them when the first thing is written.
 *
 * @example
 * ```ts
 * const store = fsFragmentStore(fileSystemAccessFS(await navigator.storage.getDirectory()));
 * const fs = await fragmentedFS(store, { maxFragmentMB: 4 });
 * ```
 */
export function fsFragmentStore(backing, options = {}) {
    const writable = !options.readOnly && !!backing.create && !!backing.write && !!backing.unlink;
    const folders = new Map();
    // A backend's namespace changes (create, unlink, rename, ...) are not
    // promised to be atomic against each other: IndexedDB's rewrite a directory
    // record read-modify-write. They go one at a time; data writes do not.
    const names = new Mutex();
    const exclusive = (change) => names.run(async () => change());
    const forget = (path) => {
        for (const key of [...folders.keys()]) {
            if (key === path || key.startsWith(path + "/"))
                folders.delete(key);
        }
    };
    function assertWritable() {
        if (!writable)
            throw new FSError("EROFS");
    }
    async function folder(path, create) {
        let node = backing.root;
        let key = "";
        for (const segment of path) {
            key = key === "" ? segment : key + "/" + segment;
            const known = folders.get(key);
            if (known) {
                node = known;
                continue;
            }
            let next = await backing.lookup(node, segment);
            if (!next) {
                if (!create)
                    return undefined;
                if (!backing.mkdir)
                    throw new FSError("EROFS");
                try {
                    next = await exclusive(() => backing.mkdir(node, segment, DIRECTORY_CONTEXT));
                }
                catch (error) {
                    // Another writer made it first.
                    if (!failedWith(error, "EEXIST"))
                        throw error;
                    next = await backing.lookup(node, segment);
                    if (!next)
                        throw error;
                }
            }
            folders.set(key, next);
            node = next;
        }
        return node;
    }
    async function read(path, name) {
        const parent = await folder(path, false);
        if (!parent)
            return undefined;
        const node = await backing.lookup(parent, name);
        if (!node)
            return undefined;
        if (!backing.open || !backing.read)
            throw new FSError("EOPNOTSUPP");
        const handle = await backing.open(node, 0);
        try {
            const size = Number((await backing.getattr(node, handle)).size);
            const data = new Uint8Array(size);
            let filled = 0;
            while (filled < size) {
                const chunk = await backing.read(node, handle, BigInt(filled), Math.min(size - filled, 8 << 20));
                if (chunk.byteLength === 0)
                    break;
                data.set(chunk, filled);
                filled += chunk.byteLength;
            }
            if (filled !== size)
                throw new FSError("EIO", `${name} is shorter than it says`);
            return data;
        }
        finally {
            await backing.release?.(node, handle);
        }
    }
    async function create(parent, name, data) {
        const { node, handle } = await exclusive(() => backing.create(parent, name, O_RDWR | O_CREAT | O_EXCL, FILE_CONTEXT));
        try {
            for (let at = 0; at < data.byteLength;) {
                const wrote = await backing.write(node, handle, BigInt(at), data.subarray(at, at + (1 << 20)));
                if (wrote <= 0)
                    throw new FSError("EIO", `short write to ${name}`);
                at += wrote;
            }
            await backing.flush?.(node, handle);
            if (options.durable)
                await backing.fsync?.(node, handle, false);
        }
        catch (error) {
            await Promise.resolve(backing.release?.(node, handle)).catch(() => { });
            await exclusive(() => backing.unlink?.(parent, name)).catch(() => { });
            throw error;
        }
        await backing.release?.(node, handle);
    }
    async function write(path, name, data, atomic) {
        assertWritable();
        const parent = (await folder(path, true));
        if (atomic && backing.rename) {
            const temporary = `${name}.tmp-${randomHex(4)}`;
            await create(parent, temporary, data);
            try {
                await exclusive(() => backing.rename(parent, temporary, parent, name));
            }
            catch (error) {
                await exclusive(() => backing.unlink(parent, temporary)).catch(() => { });
                throw error;
            }
            return;
        }
        try {
            await create(parent, name, data);
        }
        catch (error) {
            if (!failedWith(error, "EEXIST"))
                throw error;
            await exclusive(() => backing.unlink(parent, name));
            await create(parent, name, data);
        }
    }
    async function remove(path, name) {
        assertWritable();
        const parent = await folder(path, false);
        if (!parent)
            return;
        try {
            await exclusive(() => backing.unlink(parent, name));
        }
        catch (error) {
            if (!failedWith(error, "ENOENT"))
                throw error;
        }
    }
    async function list(path) {
        const parent = await folder(path, false);
        if (!parent || !backing.readdir)
            return undefined;
        const handle = await backing.opendir?.(parent, 0);
        try {
            const out = [];
            for await (const entry of await backing.readdir(parent, handle)) {
                if (TEMPORARY.test(entry.name))
                    continue;
                const attributes = await backing.getattr(entry.node);
                out.push({ name: entry.name, directory: (attributes.mode & S_IFMT) === S_IFDIR });
            }
            return out;
        }
        finally {
            if (handle !== undefined)
                await backing.releasedir?.(parent, handle);
        }
    }
    const metadataPath = (key) => {
        const parts = segments(key);
        const name = parts.pop();
        return { path: ["metadata", ...parts], name };
    };
    const store = {
        writable,
        async getMetadata(key) {
            const { path, name } = metadataPath(key);
            return read(path, name);
        },
        async putMetadata(key, data) {
            const { path, name } = metadataPath(key);
            return write(path, name, data, true);
        },
        async deleteMetadata(key) {
            const { path, name } = metadataPath(key);
            return remove(path, name);
        },
        listMetadata: backing.readdir ? (directory) => list(["metadata", ...segments(directory)]) : undefined,
        async renameMetadataDirectory(from, to) {
            assertWritable();
            if (!backing.rename)
                throw new FSError("EOPNOTSUPP");
            const source = metadataPath(from);
            const target = metadataPath(to);
            const oldParent = await folder(source.path, false);
            if (!oldParent)
                throw new FSError("ENOENT");
            const newParent = (await folder(target.path, true));
            await exclusive(() => backing.rename(oldParent, source.name, newParent, target.name));
            forget(["metadata", ...segments(from)].join("/"));
        },
        async removeMetadataDirectory(directory) {
            assertWritable();
            const { path, name } = metadataPath(directory);
            const parent = await folder(path, false);
            if (!parent || !backing.rmdir)
                return;
            try {
                await exclusive(() => backing.rmdir(parent, name));
            }
            catch {
                // Not empty (a stray temporary file, say): leaving the folder is harmless.
            }
            forget(["metadata", ...segments(directory)].join("/"));
        },
        getBlob: (id) => read(["blobs"], id),
        putBlob: (id, data) => write(["blobs"], id, data, false),
        deleteBlob: (id) => remove(["blobs"], id),
        async listBlobs() {
            return (await list(["blobs"]))?.filter((entry) => !entry.directory).map((entry) => entry.name) ?? [];
        },
        async close() {
            await backing.destroy?.();
        },
    };
    if (!backing.readdir) {
        delete store.listMetadata;
        delete store.listBlobs;
    }
    return withMetadataPack(store, (name) => read([], name));
}
/**
 * Reads a FragmentedFS published as plain static files: `<baseUrl>/blobs/<hex>`, and
 * `<baseUrl>/metadata.pack.<n>` (pack.ts) or `<baseUrl>/metadata/...`. Read-only, and it needs no
 * manifest: directory documents enumerate everything. The server must allow the page's origin (CORS).
 */
export function httpFragmentStore(baseUrl, options = {}) {
    const base = new URL(baseUrl);
    if (!base.pathname.endsWith("/"))
        base.pathname += "/";
    const request = options.fetch ?? globalThis.fetch.bind(globalThis);
    async function open(path) {
        const url = new URL(path.split("/").map(encodeURIComponent).join("/"), base);
        const response = await request(url, { headers: options.headers });
        if (response.status === 404 || response.status === 410)
            return undefined;
        if (response.status === 401 || response.status === 403)
            throw new FSError("EACCES", `${url} was refused`);
        if (!response.ok)
            throw new FSError("EIO", `${url} answered ${response.status}`);
        return response;
    }
    async function get(path) {
        const response = await open(path);
        return response && new Uint8Array(await response.arrayBuffer());
    }
    const refuse = () => {
        throw new FSError("EROFS");
    };
    return withMetadataPack({
        writable: false,
        getMetadata: (key) => get(`metadata/${key}`),
        putMetadata: refuse,
        deleteMetadata: refuse,
        getBlob: (id) => get(`blobs/${id}`),
        async getBlobStream(id) {
            const response = await open(`blobs/${id}`);
            if (!response)
                return undefined;
            return response.body ?? new Blob([await response.arrayBuffer()]).stream();
        },
        putBlob: refuse,
        deleteBlob: refuse,
    }, get);
}
/** A store held in two maps; nothing outlives it. */
export function memoryFragmentStore() {
    const metadata = new Map();
    const blobs = new Map();
    const copy = (data) => data.slice();
    return {
        writable: true,
        metadata,
        blobs,
        async getMetadata(key) {
            const found = metadata.get(key);
            return found && copy(found);
        },
        async putMetadata(key, data) {
            metadata.set(key, copy(data));
        },
        async deleteMetadata(key) {
            metadata.delete(key);
        },
        async listMetadata(directory) {
            const prefix = directory === "" ? "" : directory + "/";
            const names = new Map();
            for (const key of metadata.keys()) {
                if (!key.startsWith(prefix))
                    continue;
                const rest = key.slice(prefix.length);
                const slash = rest.indexOf("/");
                if (slash < 0)
                    names.set(rest, false);
                else
                    names.set(rest.slice(0, slash), true);
            }
            if (names.size === 0 && directory !== "")
                return undefined;
            return [...names].map(([name, isDirectory]) => ({ name, directory: isDirectory }));
        },
        async renameMetadataDirectory(from, to) {
            for (const [key, value] of [...metadata]) {
                if (!key.startsWith(from + "/"))
                    continue;
                metadata.delete(key);
                metadata.set(to + key.slice(from.length), value);
            }
        },
        async removeMetadataDirectory() { },
        async getBlob(id) {
            const found = blobs.get(id);
            return found && copy(found);
        },
        async putBlob(id, data) {
            blobs.set(id, copy(data));
        },
        async deleteBlob(id) {
            blobs.delete(id);
        },
        async listBlobs() {
            return [...blobs.keys()];
        },
    };
}
