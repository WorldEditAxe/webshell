export declare const FORMAT = "fragmentedfs/1";
/** The reserved name of the document that describes and enumerates a directory. */
export declare const DIRECTORY_NAME = ".fragmentedfs-dir";
export declare const DOCUMENT_SUFFIX = ".json";
export declare const DIRECTORY_DOCUMENT: string;
export declare const isBlobId: (value: unknown) => value is string;
export declare const isSha256: (value: unknown) => value is string;
/**
 * Whether a directory entry's name can be one: a single path component that
 * cannot climb out of its folder, short enough to carry `.json`, and not the
 * reserved name. Names in a store's documents are not trusted before this.
 */
export declare function isEntryName(name: string): boolean;
export type EntryType = "file" | "directory" | "symlink";
/** One piece of a file. A hole is `size` zero bytes with no blob behind them. */
export interface FragmentDoc {
    /** Position in the assembly order, from 0. */
    index: number;
    /** The blob holding the bytes; absent for a hole. */
    blob?: string;
    size: number;
    /** SHA-256 of the blob's bytes; absent for a hole. */
    sha256?: string;
    hole?: true;
}
interface CommonDoc {
    format: typeof FORMAT;
    /** The entry's own name, as the directory lists it. */
    name: string;
    /** Permission bits. */
    mode: number;
    uid: number;
    gid: number;
    mtime: number;
    mtimeNsec: number;
    ctime: number;
    ctimeNsec: number;
}
export interface FileDoc extends CommonDoc {
    type: "file";
    size: number;
    /** SHA-256 of the whole file. */
    sha256: string;
    fragments: FragmentDoc[];
}
export interface SymlinkDoc extends CommonDoc {
    type: "symlink";
    target: string;
}
/** What a directory document says about one of its entries. */
export interface EntryDoc {
    name: string;
    type: EntryType;
    mode: number;
    uid: number;
    gid: number;
    mtime: number;
    mtimeNsec: number;
    ctime: number;
    ctimeNsec: number;
    /** Files only. */
    size?: number;
    /** Files only: the whole-file hash, as in the file's own document. */
    sha256?: string;
    /** Symlinks only. */
    target?: string;
    /** Where the entry's own document is, relative to this directory's metadata folder. */
    metadata: string;
}
export interface DirectoryDoc extends CommonDoc {
    type: "directory";
    /** Written by the root only: the fragment cap in force at the last write. */
    maxFragmentBytes?: number;
    entries: EntryDoc[];
}
/** Reads a file or symlink document; `what` names it in error messages. */
export declare function parseEntryDocument(what: string, bytes: Uint8Array): FileDoc | SymlinkDoc;
export declare function parseDirectoryDocument(what: string, bytes: Uint8Array): DirectoryDoc;
/**
 * Prints a document: one key per line, and the entry and fragment lists one
 * object per line, so a store full of them stays readable and diffs well.
 */
export declare function printDocument(doc: object): Uint8Array;
/** The metadata key of the document for entry `name` of the directory at `directory`. */
export declare function documentKey(directory: string, name: string): string;
/** The metadata key of the directory document of the directory at `directory`. */
export declare function directoryKey(directory: string): string;
/** Where, relative to its directory's metadata folder, an entry's document is. */
export declare function entryDocumentPath(name: string, type: EntryType): string;
export {};
