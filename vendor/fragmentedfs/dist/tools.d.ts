import type { FS } from "./contract.ts";
import type { FragmentStore } from "./store.ts";
export interface CopyFileSystemOptions {
    /** Bytes read and written at a time. Default 1 MiB. */
    chunkBytes?: number;
    /** Called after each file with its path (no leading slash) and size. */
    onFile?(path: string, size: number): void;
}
export interface CopyFileSystemResult {
    directories: number;
    files: number;
    symlinks: number;
    bytes: number;
    /** Devices, FIFOs and sockets, which a FragmentedFS cannot hold. */
    skipped: number;
}
/**
 * Copies a whole filesystem into another through their `FS` contracts: split a
 * big tree into a FragmentedFS (`source` any backend, `destination` a
 * `fragmentedFS`), or assemble a FragmentedFS back into a host directory.
 * Modes, owners and modification times are carried over. The destination is
 * not synced; call its `sync()` (or `close()`) when this resolves.
 */
export declare function copyFileSystem<SNode extends object, SHandle, DNode extends object, DHandle>(source: FS<SNode, SHandle>, destination: FS<DNode, DHandle>, options?: CopyFileSystemOptions): Promise<CopyFileSystemResult>;
export interface VerifyOptions {
    /** Delete blobs that no document refers to. */
    removeOrphans?: boolean;
    /** Called for each file as it is checked. */
    onFile?(path: string): void;
}
export interface VerifyReport {
    directories: number;
    files: number;
    symlinks: number;
    fragments: number;
    /** Bytes in the files checked, holes included. */
    bytes: number;
    /** Everything wrong that was found, one line each; empty when the store is sound. */
    errors: string[];
    /** Blobs no document refers to (after `removeOrphans`, the ones that were deleted). */
    orphans: string[];
}
/**
 * Checks a store against its own documents without going through the
 * filesystem: every directory document and file document parses, every
 * fragment exists with the size and SHA-256 its document gives, the fragments
 * add up to the file's size and SHA-256, and every blob is used.
 */
export declare function verifyFragmentedFS(store: FragmentStore, options?: VerifyOptions): Promise<VerifyReport>;
