// SPDX-License-Identifier: MIT
//
// Tools around a FragmentedFS: splitting an existing filesystem into one,
// assembling one back, and checking a store against its own documents.
import { FSError } from "./contract.js";
import { DIRECTORY_DOCUMENT, DOCUMENT_SUFFIX, directoryKey, documentKey, parseDirectoryDocument, parseEntryDocument, } from "./format.js";
import { createHasher, sha256Hex, updateZeros } from "./sha256.js";
const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;
const O_RDONLY = 0;
const O_WRONLY = 1;
const O_CREAT = 0o100;
const O_EXCL = 0o200;
async function entriesOf(fs, node) {
    if (!fs.readdir)
        throw new FSError("EOPNOTSUPP", "the source cannot list directories");
    const handle = await fs.opendir?.(node, 0);
    try {
        const out = [];
        for await (const entry of await fs.readdir(node, handle))
            out.push(entry);
        return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    }
    finally {
        if (handle !== undefined)
            await fs.releasedir?.(node, handle);
    }
}
/**
 * Copies a whole filesystem into another through their `FS` contracts: split a
 * big tree into a FragmentedFS (`source` any backend, `destination` a
 * `fragmentedFS`), or assemble a FragmentedFS back into a host directory.
 * Modes, owners and modification times are carried over. The destination is
 * not synced; call its `sync()` (or `close()`) when this resolves.
 */
export async function copyFileSystem(source, destination, options = {}) {
    const chunk = options.chunkBytes ?? 1 << 20;
    const result = { directories: 0, files: 0, symlinks: 0, bytes: 0, skipped: 0 };
    if (!destination.create || !destination.write || !destination.mkdir) {
        throw new FSError("EROFS", "the destination cannot be written");
    }
    async function copyDirectory(from, to, path) {
        for (const entry of await entriesOf(source, from)) {
            const attributes = await source.getattr(entry.node);
            const context = { mode: attributes.mode, uid: attributes.uid ?? 0, gid: attributes.gid ?? 0 };
            const name = path === "" ? entry.name : `${path}/${entry.name}`;
            let made;
            switch (attributes.mode & S_IFMT) {
                case S_IFDIR: {
                    made = await destination.mkdir(to, entry.name, context);
                    result.directories += 1;
                    await copyDirectory(entry.node, made, name);
                    break;
                }
                case S_IFLNK: {
                    if (!source.readlink || !destination.symlink) {
                        result.skipped += 1;
                        continue;
                    }
                    made = await destination.symlink(to, entry.name, await source.readlink(entry.node), context);
                    result.symlinks += 1;
                    break;
                }
                case S_IFREG: {
                    const input = await source.open(entry.node, O_RDONLY);
                    try {
                        const created = await destination.create(to, entry.name, O_WRONLY | O_CREAT | O_EXCL, context);
                        made = created.node;
                        try {
                            const size = attributes.size;
                            for (let at = 0n; at < size;) {
                                const data = await source.read(entry.node, input, at, Number(size - at < BigInt(chunk) ? size - at : BigInt(chunk)));
                                if (data.byteLength === 0)
                                    throw new FSError("EIO", `${name} is shorter than it says`);
                                let written = 0;
                                while (written < data.byteLength) {
                                    written += await destination.write(created.node, created.handle, at + BigInt(written), data.subarray(written));
                                }
                                at += BigInt(data.byteLength);
                                result.bytes += data.byteLength;
                            }
                            await destination.flush?.(created.node, created.handle);
                        }
                        finally {
                            await destination.release?.(created.node, created.handle);
                        }
                    }
                    finally {
                        await source.release?.(entry.node, input);
                    }
                    result.files += 1;
                    options.onFile?.(name, Number(attributes.size));
                    break;
                }
                default:
                    result.skipped += 1;
                    continue;
            }
            if (destination.setattr && made && (attributes.mode & S_IFMT) !== S_IFLNK) {
                await destination.setattr(made, {
                    mode: attributes.mode & 0o7777,
                    uid: attributes.uid,
                    gid: attributes.gid,
                    mtime: attributes.mtime,
                });
            }
        }
    }
    await copyDirectory(source.root, destination.root, "");
    return result;
}
/**
 * Checks a store against its own documents without going through the
 * filesystem: every directory document and file document parses, every
 * fragment exists with the size and SHA-256 its document gives, the fragments
 * add up to the file's size and SHA-256, and every blob is used.
 */
export async function verifyFragmentedFS(store, options = {}) {
    const report = { directories: 0, files: 0, symlinks: 0, fragments: 0, bytes: 0, errors: [], orphans: [] };
    const used = new Set();
    const problem = (message) => {
        report.errors.push(message);
    };
    const attempt = async (what, run) => {
        try {
            await run();
        }
        catch (error) {
            problem(error instanceof Error ? error.message : `${what}: ${String(error)}`);
        }
    };
    async function checkFile(directory, name, path) {
        const key = documentKey(directory, name);
        const raw = await store.getMetadata(key);
        if (!raw)
            return problem(`${key} is listed but missing`);
        const doc = parseEntryDocument(key, raw);
        if (doc.name !== name)
            problem(`${key} says it is named ${doc.name}`);
        if (doc.type === "symlink") {
            report.symlinks += 1;
            return;
        }
        report.files += 1;
        options.onFile?.(path);
        const whole = createHasher();
        for (const fragment of doc.fragments) {
            report.fragments += 1;
            if (fragment.hole) {
                updateZeros(whole, fragment.size);
                continue;
            }
            used.add(fragment.blob);
            const data = await store.getBlob(fragment.blob);
            if (!data) {
                problem(`${path}: blob ${fragment.blob} is missing`);
                continue;
            }
            if (data.byteLength !== fragment.size) {
                problem(`${path}: blob ${fragment.blob} is ${data.byteLength} bytes, not ${fragment.size}`);
            }
            if ((await sha256Hex(data)) !== fragment.sha256)
                problem(`${path}: blob ${fragment.blob} does not match its SHA-256`);
            whole.update(data);
        }
        report.bytes += doc.size;
        if (whole.digestHex() !== doc.sha256)
            problem(`${path}: the fragments do not add up to the file's SHA-256`);
    }
    async function checkDirectory(directory) {
        const key = directoryKey(directory);
        const raw = await store.getMetadata(key);
        if (!raw)
            return problem(`${key} is missing`);
        const doc = parseDirectoryDocument(key, raw);
        report.directories += 1;
        if (store.listMetadata) {
            const listed = (await store.listMetadata(directory)) ?? [];
            const names = new Set(doc.entries.map((entry) => entry.name));
            for (const item of listed) {
                const name = item.directory ? item.name : item.name.endsWith(DOCUMENT_SUFFIX) ? item.name.slice(0, -DOCUMENT_SUFFIX.length) : undefined;
                if (name === undefined || item.name === DIRECTORY_DOCUMENT)
                    continue;
                if (!names.has(name))
                    problem(`${directory === "" ? "" : directory + "/"}${item.name} is not in its directory document`);
            }
        }
        for (const entry of doc.entries) {
            const path = directory === "" ? entry.name : `${directory}/${entry.name}`;
            if (entry.type === "directory")
                await attempt(path, () => checkDirectory(path));
            else
                await attempt(path, () => checkFile(directory, entry.name, path));
        }
    }
    await attempt("/", () => checkDirectory(""));
    if (store.listBlobs) {
        for (const id of await store.listBlobs()) {
            if (used.has(id))
                continue;
            report.orphans.push(id);
            if (options.removeOrphans && store.writable)
                await store.deleteBlob(id);
        }
    }
    return report;
}
