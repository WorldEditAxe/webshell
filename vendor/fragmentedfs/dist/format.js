// SPDX-License-Identifier: MIT
//
// The on-disk format of FragmentedFS (docs/FRAGMENTED-FS.md).
//
//   blobs/<hex>                              file contents, at most a configured size each
//   metadata/<path>.json                     one document per file or symlink
//   metadata/<dir>/.fragmentedfs-dir.json    one document per directory (the root's included)
//
// Everything here is parsing, checking and printing of those documents; it
// never touches a store.
import { FSError } from "./contract.js";
export const FORMAT = "fragmentedfs/1";
/** The reserved name of the document that describes and enumerates a directory. */
export const DIRECTORY_NAME = ".fragmentedfs-dir";
export const DOCUMENT_SUFFIX = ".json";
export const DIRECTORY_DOCUMENT = DIRECTORY_NAME + DOCUMENT_SUFFIX;
/** A blob name is hex, so it can never climb out of the blobs folder. */
const BLOB_ID = /^[0-9a-f]{1,128}$/;
const SHA256 = /^[0-9a-f]{64}$/;
export const isBlobId = (value) => typeof value === "string" && BLOB_ID.test(value);
export const isSha256 = (value) => typeof value === "string" && SHA256.test(value);
/**
 * Whether a directory entry's name can be one: a single path component that
 * cannot climb out of its folder, short enough to carry `.json`, and not the
 * reserved name. Names in a store's documents are not trusted before this.
 */
export function isEntryName(name) {
    return (name.length > 0 &&
        name !== "." &&
        name !== ".." &&
        name !== DIRECTORY_NAME &&
        !name.includes("/") &&
        !name.includes("\0") &&
        new TextEncoder().encode(name).byteLength <= 250);
}
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
function corrupt(what, why) {
    throw new FSError("EIO", `FragmentedFS: ${what}: ${why}`);
}
const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
function count(what, doc, field, maximum = Number.MAX_SAFE_INTEGER) {
    const value = doc[field];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
        corrupt(what, `"${field}" is not a whole number in range`);
    }
    return value;
}
function text(what, doc, field) {
    const value = doc[field];
    if (typeof value !== "string")
        corrupt(what, `"${field}" is not a string`);
    return value;
}
function parseJson(what, bytes) {
    let value;
    try {
        value = JSON.parse(decoder.decode(bytes));
    }
    catch {
        corrupt(what, "not valid JSON");
    }
    if (!isObject(value))
        corrupt(what, "not a JSON object");
    const format = value.format;
    if (typeof format !== "string" || !format.startsWith("fragmentedfs/")) {
        corrupt(what, "not a FragmentedFS document");
    }
    if (format !== FORMAT)
        corrupt(what, `unsupported format ${format}`);
    return value;
}
function common(what, doc) {
    return {
        name: text(what, doc, "name"),
        mode: count(what, doc, "mode", 0o7777),
        uid: count(what, doc, "uid", 0xffffffff),
        gid: count(what, doc, "gid", 0xffffffff),
        mtime: count(what, doc, "mtime"),
        mtimeNsec: count(what, doc, "mtimeNsec", 999_999_999),
        ctime: count(what, doc, "ctime"),
        ctimeNsec: count(what, doc, "ctimeNsec", 999_999_999),
    };
}
/** Reads a file or symlink document; `what` names it in error messages. */
export function parseEntryDocument(what, bytes) {
    const doc = parseJson(what, bytes);
    const attributes = common(what, doc);
    if (doc.type === "symlink") {
        return { format: FORMAT, type: "symlink", ...attributes, target: text(what, doc, "target") };
    }
    if (doc.type !== "file")
        corrupt(what, `unexpected type ${String(doc.type)}`);
    const size = count(what, doc, "size");
    const sha256 = doc.sha256;
    if (!isSha256(sha256))
        corrupt(what, '"sha256" is not a SHA-256 digest');
    if (!Array.isArray(doc.fragments))
        corrupt(what, '"fragments" is not a list');
    const fragments = [];
    for (const item of doc.fragments) {
        if (!isObject(item))
            corrupt(what, "a fragment is not an object");
        const fragment = {
            index: count(what, item, "index"),
            size: count(what, item, "size"),
        };
        if (fragment.size === 0)
            corrupt(what, "a fragment is empty");
        if (item.hole === true) {
            fragment.hole = true;
            if (item.blob !== undefined || item.sha256 !== undefined)
                corrupt(what, "a hole has a blob");
        }
        else {
            if (!isBlobId(item.blob))
                corrupt(what, "a fragment's blob is not a hex name");
            if (!isSha256(item.sha256))
                corrupt(what, "a fragment's sha256 is not a SHA-256 digest");
            fragment.blob = item.blob;
            fragment.sha256 = item.sha256;
        }
        fragments.push(fragment);
    }
    // The assembly order is the `index` order; the list is normally already in it.
    fragments.sort((a, b) => a.index - b.index);
    let total = 0;
    fragments.forEach((fragment, position) => {
        if (fragment.index !== position)
            corrupt(what, "fragment indexes are not 0, 1, 2, ...");
        total += fragment.size;
    });
    if (total !== size)
        corrupt(what, `fragments add up to ${total} bytes, not ${size}`);
    return { format: FORMAT, type: "file", ...attributes, size, sha256, fragments };
}
export function parseDirectoryDocument(what, bytes) {
    const doc = parseJson(what, bytes);
    if (doc.type !== "directory")
        corrupt(what, `unexpected type ${String(doc.type)}`);
    if (!Array.isArray(doc.entries))
        corrupt(what, '"entries" is not a list');
    const entries = [];
    const seen = new Set();
    for (const item of doc.entries) {
        if (!isObject(item))
            corrupt(what, "an entry is not an object");
        const attributes = common(what, item);
        if (!isEntryName(attributes.name))
            corrupt(what, `"${attributes.name}" is not a usable name`);
        if (seen.has(attributes.name))
            corrupt(what, `"${attributes.name}" is listed twice`);
        seen.add(attributes.name);
        const type = item.type;
        if (type !== "file" && type !== "directory" && type !== "symlink") {
            corrupt(what, `entry "${attributes.name}" has type ${String(type)}`);
        }
        const entry = { ...attributes, type, metadata: text(what, item, "metadata") };
        if (type === "file") {
            entry.size = count(what, item, "size");
            if (!isSha256(item.sha256))
                corrupt(what, `entry "${attributes.name}" has no sha256`);
            entry.sha256 = item.sha256;
        }
        else if (type === "symlink") {
            entry.target = text(what, item, "target");
        }
        entries.push(entry);
    }
    const directory = {
        format: FORMAT,
        type: "directory",
        ...common(what, doc),
        entries,
    };
    if (doc.maxFragmentBytes !== undefined) {
        directory.maxFragmentBytes = count(what, doc, "maxFragmentBytes");
    }
    return directory;
}
/**
 * Prints a document: one key per line, and the entry and fragment lists one
 * object per line, so a store full of them stays readable and diffs well.
 */
export function printDocument(doc) {
    const lines = [];
    const entries = Object.entries(doc);
    entries.forEach(([key, value], position) => {
        const comma = position === entries.length - 1 ? "" : ",";
        if (Array.isArray(value) && value.length > 0 && value.every(isObject)) {
            lines.push(`  ${JSON.stringify(key)}: [`);
            value.forEach((item, at) => {
                lines.push(`    ${JSON.stringify(item)}${at === value.length - 1 ? "" : ","}`);
            });
            lines.push(`  ]${comma}`);
        }
        else {
            lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(value)}${comma}`);
        }
    });
    return encoder.encode(`{\n${lines.join("\n")}\n}\n`);
}
/** The metadata key of the document for entry `name` of the directory at `directory`. */
export function documentKey(directory, name) {
    return (directory === "" ? "" : directory + "/") + name + DOCUMENT_SUFFIX;
}
/** The metadata key of the directory document of the directory at `directory`. */
export function directoryKey(directory) {
    return (directory === "" ? "" : directory + "/") + DIRECTORY_DOCUMENT;
}
/** Where, relative to its directory's metadata folder, an entry's document is. */
export function entryDocumentPath(name, type) {
    return type === "directory" ? `${name}/${DIRECTORY_DOCUMENT}` : name + DOCUMENT_SUFFIX;
}
