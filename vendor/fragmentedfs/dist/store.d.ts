import type { FS } from "./contract.ts";
/** One name in a metadata folder: a `.json` document, or a sub-folder. */
export interface MetadataListing {
    name: string;
    directory: boolean;
}
/**
 * Metadata keys are relative, `/`-separated paths below the metadata folder
 * ("" is the folder itself); blob ids are the hex names in the blobs folder.
 * `put*` replaces what is there and must not leave a half-written document
 * behind; `delete*` of something that is not there is not an error.
 */
export interface FragmentStore {
    /** False when the store can only be read. */
    readonly writable: boolean;
    /** `undefined` when there is no such document. */
    getMetadata(key: string): Promise<Uint8Array | undefined>;
    putMetadata(key: string, data: Uint8Array): Promise<void>;
    deleteMetadata(key: string): Promise<void>;
    /**
     * What a metadata folder holds, or `undefined` when there is no such folder.
     * Optional: without it a store is trusted to be exactly what its directory
     * documents say.
     */
    listMetadata?(directory: string): Promise<MetadataListing[] | undefined>;
    /** Moves a whole metadata folder; `to` does not exist. */
    renameMetadataDirectory?(from: string, to: string): Promise<void>;
    /** Removes a metadata folder whose documents are already deleted. */
    removeMetadataDirectory?(directory: string): Promise<void>;
    /** `undefined` when there is no such blob. */
    getBlob(id: string): Promise<Uint8Array | undefined>;
    /**
     * The same blob as it arrives, so that a reader need not wait for all of it. Optional; a store that has it lets a read of
     * a few bytes of a fragment return as soon as they are here.
     */
    getBlobStream?(id: string): Promise<ReadableStream<Uint8Array> | undefined>;
    putBlob(id: string, data: Uint8Array): Promise<void>;
    deleteBlob(id: string): Promise<void>;
    /** Every blob id; optional, needed only to find orphans. */
    listBlobs?(): Promise<string[]>;
    close?(): Promise<void>;
}
export interface FsFragmentStoreOptions {
    /** Never write, whatever the backend allows. */
    readOnly?: boolean;
    /** `fsync` every document and blob as it is written (slow, but survives power loss). */
    durable?: boolean;
}
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
export declare function fsFragmentStore<TNode extends object, THandle>(backing: FS<TNode, THandle>, options?: FsFragmentStoreOptions): FragmentStore;
export interface HttpFragmentStoreOptions {
    fetch?: typeof fetch;
    headers?: Record<string, string>;
}
/**
 * Reads a FragmentedFS published as plain static files: `<baseUrl>/blobs/<hex>`, and
 * `<baseUrl>/metadata.pack.<n>` (pack.ts) or `<baseUrl>/metadata/...`. Read-only, and it needs no
 * manifest: directory documents enumerate everything. The server must allow the page's origin (CORS).
 */
export declare function httpFragmentStore(baseUrl: string | URL, options?: HttpFragmentStoreOptions): FragmentStore;
export interface MemoryFragmentStore extends FragmentStore {
    /** The documents by key and the blobs by id, for inspecting or corrupting in tests. */
    readonly metadata: Map<string, Uint8Array>;
    readonly blobs: Map<string, Uint8Array>;
}
/** A store held in two maps; nothing outlives it. */
export declare function memoryFragmentStore(): MemoryFragmentStore;
