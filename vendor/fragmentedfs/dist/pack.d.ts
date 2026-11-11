import type { FragmentStore, MetadataListing } from "./store.ts";
export declare const DEFAULT_SEGMENT_BYTES: number;
/** The name of a segment, in the folder that holds `blobs/`. */
export declare const metadataSegmentName: (index: number) => string;
export interface PackedMetadata {
    /** The segments, in order; written as `metadataSegmentName(index)`. */
    segments: Uint8Array[];
    documents: number;
    /** Their size as JSON documents, for comparison. */
    jsonBytes: number;
    bytes: number;
}
/** Packs every document a store's directory tree reaches. Nothing is written. */
export declare function packMetadata(store: FragmentStore, options?: {
    maxSegmentBytes?: number;
}): Promise<PackedMetadata>;
export interface MetadataPack {
    get(key: string): Uint8Array | undefined;
    list(directory: string): MetadataListing[] | undefined;
}
/** Reads a pack through `read`, which fetches a file beside `blobs/`; `undefined` when the store has none. */
export declare function loadMetadataPack(read: (name: string) => Promise<Uint8Array | undefined>): Promise<MetadataPack | undefined>;
/**
 * Throws unless two stores hold the same documents: how a pack is checked against the documents it replaces, before they go.
 * Returns how many it compared.
 */
export declare function compareMetadata(a: FragmentStore, b: FragmentStore): Promise<number>;
/**
 * Reads the documents from a pack when the store has one, and `store`'s own otherwise. `read` fetches a
 * file beside `blobs/`. Whether there is a pack is settled once, at the first read.
 */
export declare function withMetadataPack(store: FragmentStore, read: (name: string) => Promise<Uint8Array | undefined>): FragmentStore;
