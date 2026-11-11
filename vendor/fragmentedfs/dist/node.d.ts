import { type FS } from "./contract.ts";
import type { FragmentStore } from "./store.ts";
import type { CopyFileSystemResult } from "./tools.ts";
export interface NodeDirectoryFragmentStoreOptions {
    /** Never write. */
    readOnly?: boolean;
    /** `fsync` every document and blob as it is written (slow, but survives power loss). */
    durable?: boolean;
}
/**
 * Keeps a FragmentedFS in the `blobs` and `metadata` folders of a host
 * directory. Anything that serves the directory over HTTP serves the same
 * filesystem to `httpFragmentStore`.
 */
export declare function nodeDirectoryFragmentStore(directory: string, options?: NodeDirectoryFragmentStoreOptions): FragmentStore;
export interface PackDirectoryOptions {
    /** Called after each file with its path (no leading slash) and size. */
    onFile?(path: string, size: number): void;
}
/**
 * Splits a host directory into a filesystem: every file is cut into
 * fragments, every directory and symlink gets its documents. Modes, owners
 * and modification times are carried over. `destination` is not synced; call
 * its `sync()` (or `close()`) when this resolves.
 */
export declare function packDirectory<TNode extends object, THandle>(directory: string, destination: FS<TNode, THandle>, options?: PackDirectoryOptions): Promise<CopyFileSystemResult>;
/**
 * Assembles a filesystem into a host directory (created if need be, and
 * empty): the inverse of `packDirectory`. Owners are restored where the
 * process may; everything else is exact.
 */
export declare function unpackDirectory<TNode extends object, THandle>(source: FS<TNode, THandle>, directory: string): Promise<CopyFileSystemResult>;
export interface CompareDirectoryOptions {
    /** Called for each file as it is checked, with its path (no leading slash). */
    onFile?(path: string): void;
    /** Files hashed at once. Default 4. */
    concurrency?: number;
    /** Also compare modification times. Default true. */
    times?: boolean;
    /**
     * How far apart two modification times may be, in nanoseconds. Default 0:
     * `packDirectory` carries times exactly, but `unpackDirectory` sets them
     * through Node's `lutimes`, which takes floating-point seconds and so rounds
     * below a microsecond; allow 1000 when comparing an unpacked directory.
     */
    timeToleranceNs?: number;
}
export interface CompareDirectoryReport {
    directories: number;
    files: number;
    symlinks: number;
    /** Bytes in the files hashed. */
    bytes: number;
    /** Every difference found, one line each; empty when the store is exactly the directory. */
    mismatches: string[];
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
export declare function compareDirectory(directory: string, store: FragmentStore, options?: CompareDirectoryOptions): Promise<CompareDirectoryReport>;
