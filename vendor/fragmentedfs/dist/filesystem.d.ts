import type { FS } from "./contract.ts";
import { type EntryDoc } from "./format.ts";
import { type Hasher } from "./sha256.ts";
import type { FragmentStore } from "./store.ts";
import { RWLock } from "./sync.ts";
interface Time {
    sec: number;
    nsec: number;
}
/** A piece of a file: a blob, or a hole of zeros. */
interface Fragment {
    hole: boolean;
    /** The blob; unset for holes and for data that has not been written yet. */
    blob?: string;
    size: number;
    /** SHA-256 of the blob's bytes; unset for holes and unwritten data. */
    sha256?: string;
    /** Where the fragment starts in the file. */
    offset: number;
    /** The bytes, while the fragment is being changed: `buf.length >= size`. */
    buf?: Uint8Array;
    dirty: boolean;
}
declare class FileNode {
    readonly kind: "file";
    parent: DirectoryNode | undefined;
    name: string;
    perm: number;
    uid: number;
    gid: number;
    mtime: Time;
    ctime: Time;
    unlinked: boolean;
    retired: boolean;
    size: number;
    sha256: string;
    fragments: Fragment[];
    /** The fragment list has been read from the store (or the file is new). */
    ready: boolean;
    loading: Promise<void> | undefined;
    /** Created in memory and not yet written to the store. */
    pending: boolean;
    /** The last committed state, as the directory document lists it. */
    entry: EntryDoc | undefined;
    contentDirty: boolean;
    attrDirty: boolean;
    dirtyBytes: number;
    opens: number;
    /** Blobs no longer referenced once the next commit lands. */
    obsolete: string[];
    /** Hashes the file's bytes so far while it has only ever been appended to. */
    hasher: Hasher | undefined;
    hashed: number;
    readonly lock: RWLock;
    constructor(parent: DirectoryNode, name: string, perm: number, uid: number, gid: number, time: Time, pending: boolean);
}
declare class SymlinkNode {
    readonly kind: "symlink";
    parent: DirectoryNode | undefined;
    name: string;
    target: string;
    perm: number;
    uid: number;
    gid: number;
    mtime: Time;
    ctime: Time;
    unlinked: boolean;
    entry: EntryDoc | undefined;
    constructor(parent: DirectoryNode, name: string, target: string, uid: number, gid: number, time: Time);
}
declare class DirectoryNode {
    readonly kind: "directory";
    parent: DirectoryNode | undefined;
    name: string;
    perm: number;
    uid: number;
    gid: number;
    mtime: Time;
    ctime: Time;
    unlinked: boolean;
    /** Whether mode, owner and times are known (a folder found by listing has none until read). */
    attrsKnown: boolean;
    children: Map<string, FragmentedNode>;
    /** `children` in name order, until the next change. */
    sorted: FragmentedNode[] | undefined;
    ready: boolean;
    loading: Promise<void> | undefined;
    /** Bumped by every change the directory document has not recorded yet. */
    revision: number;
    timer: ReturnType<typeof setTimeout> | undefined;
    constructor(parent: DirectoryNode | undefined, name: string, perm: number, uid: number, gid: number, time: Time, attrsKnown?: boolean);
}
/** A file, directory or symlink of a FragmentedFS. Opaque outside this module. */
export type FragmentedNode = FileNode | DirectoryNode | SymlinkNode;
/** An open file or directory of a FragmentedFS. */
export interface FragmentedHandle {
    readonly node: FragmentedNode;
    readonly writable: boolean;
    released: boolean;
}
export interface FragmentedFSOptions {
    /**
     * The largest blob, in megabytes (1 MB = 1 MiB = 1048576 bytes); may be
     * fractional. Files are cut into fragments of at most this size. Changing it
     * affects what is written from now on; existing blobs are read as they are.
     * Default 4.
     */
    maxFragmentMB?: number;
    /** Refuse every change with EROFS, whatever the store allows. */
    readOnly?: boolean;
    /** Check each blob's size and SHA-256 against its document when it is read. Default true. */
    verify?: boolean;
    /** Megabytes of verified blobs kept for rereading. Default 64. */
    cacheMB?: number;
    /** Megabytes of written data held back before files are committed early. Default 64. */
    maxDirtyMB?: number;
    /**
     * How long a changed directory document waits before it is written, in
     * milliseconds, so a burst of creations rewrites it once. Default 200; a
     * directory with more entries than that waits one millisecond per entry.
     * Syncing, `fsync` and closing write them at once.
     */
    indexDelayMs?: number;
    /** Blobs read or written at the same time for one file. Default 4. */
    concurrency?: number;
    /** Length of a blob name in random bytes (twice that many hex digits). Default 16. */
    blobIdBytes?: number;
    /** Owner of the root directory when the store is empty. Default 0 and 0. */
    uid?: number;
    gid?: number;
    /** The size `statfs` reports, in gigabytes. Default 256. */
    capacityGB?: number;
    /** The clock, in milliseconds since the epoch; for tests. */
    now?: () => number;
    /** Where blob names come from; for tests. Must never repeat. */
    randomId?: () => string;
}
/** The `FS` a FragmentedFS presents, plus what it takes to keep it. */
export interface FragmentedFileSystem extends FS<FragmentedNode, FragmentedHandle> {
    flush(node: FragmentedNode, handle: FragmentedHandle): Promise<void>;
    fsync(node: FragmentedNode, handle: FragmentedHandle, dataOnly: boolean): Promise<void>;
    /** The largest blob this filesystem writes, in bytes. */
    readonly maxFragmentBytes: number;
    readonly store: FragmentStore;
    /** Resolves once the store is open (immediately for `fragmentedFS`; the first operation starts it for `lazyFragmentedFS`). */
    ready(): Promise<void>;
    /** Writes every changed file and directory document to the store. */
    sync(): Promise<void>;
    /** Syncs, then closes the store. */
    close(): Promise<void>;
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
export declare function fragmentedFS(store: FragmentStore, options?: FragmentedFSOptions): Promise<FragmentedFileSystem>;
/**
 * The same filesystem, handed back at once and opened by the first operation
 * that reaches it: for building a virtio device before the store has been
 * read. A store that turns out not to hold a FragmentedFS fails every
 * operation (EIO) instead of failing this call.
 */
export declare function lazyFragmentedFS(store: FragmentStore, options?: FragmentedFSOptions): FragmentedFileSystem;
export {};
