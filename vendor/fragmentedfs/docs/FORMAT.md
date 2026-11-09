# The FragmentedFS format

A store is two folders:

    blobs/       file contents, in pieces: one file per piece, named by a random
                 hex string, no bigger than the configured size
    metadata/    one JSON document per file or symlink, and one per directory

`/example/sample1.apk` is described by `metadata/example/sample1.apk.json`;
the directory `/example` by `metadata/example/.fragmentedfs-dir.json`; the root
by `metadata/.fragmentedfs-dir.json`.

## File documents

    {
      "format": "fragmentedfs/1",
      "type": "file",
      "name": "sample1.apk",
      "size": 5000,
      "sha256": "6a2f…",
      "mode": 420, "uid": 0, "gid": 0,
      "mtime": 1726000000, "mtimeNsec": 0, "ctime": 1726000000, "ctimeNsec": 0,
      "fragments": [
        { "index": 0, "blob": "9f2c61d0b7e44a35a1f0c3d2e8b97a14", "size": 1024, "sha256": "ab12…" },
        { "index": 1, "blob": "03d5e7a9c4b8461f9e2d7a60c1b3f5e8", "size": 1024, "sha256": "c4e9…" },
        { "index": 2, "hole": true, "size": 2048 },
        { "index": 3, "blob": "5be0cd19a54ff53a3c6ef372bb67ae85", "size": 904, "sha256": "e1f0…" }
      ]
    }

| Field | Meaning |
|---|---|
| `name` | The file's name, as its directory lists it. Where the two disagree the document's location wins. |
| `size` | Bytes; the fragments' sizes add up to it. |
| `sha256` | Lowercase hex SHA-256 of the whole file (of the empty file, `e3b0c442…b855`). |
| `mode` | Permission bits only, decimal. |
| `uid`, `gid` | Owner. |
| `mtime`, `mtimeNsec` | Modification time: seconds since the epoch, and nanoseconds within the second. `ctime` likewise. |
| `fragments` | The file is these concatenated in `index` order. Indexes are 0, 1, 2, ... without gaps. |

A fragment with a `blob` names a file in `blobs/` of exactly `size` bytes whose
SHA-256 is the fragment's `sha256`. A fragment with `"hole": true` is `size`
zero bytes with no blob and no hash, so sparse files cost nothing. An empty
file has no fragments.

Blob names are lowercase hex, 1 to 128 digits (32 by default, from 16 random
bytes), so a name in a document can never climb out of `blobs/`. A blob is
written once and never changed; a change to a file writes new blobs under new
names and then a new document. A blob can therefore be cached forever and
fetched by anything that has the document.

## Symlink documents

    { "format": "fragmentedfs/1", "type": "symlink", "name": "latest", "target": "sample1.apk",
      "mode": 511, "uid": 0, "gid": 0, "mtime": …, "mtimeNsec": …, "ctime": …, "ctimeNsec": … }

## Directory documents

    {
      "format": "fragmentedfs/1",
      "type": "directory",
      "name": "example",
      "mode": 493, "uid": 0, "gid": 0, "mtime": …, "mtimeNsec": …, "ctime": …, "ctimeNsec": …,
      "entries": [
        { "name": "deep", "type": "directory", "mode": 493, "uid": 0, "gid": 0, …,
          "metadata": "deep/.fragmentedfs-dir.json" },
        { "name": "latest", "type": "symlink", "target": "sample1.apk", …, "metadata": "latest.json" },
        { "name": "sample1.apk", "type": "file", "size": 5000, "sha256": "6a2f…", "mode": 420, …,
          "metadata": "sample1.apk.json" }
      ]
    }

It describes the directory and enumerates what it holds, each entry with enough
of its own document (type, size, whole-file hash, mode, owner, times, a
symlink's target) to list the directory without opening anything else, and
`metadata`, where its own document is, relative to this directory's folder. The
root's also has `"maxFragmentBytes"`, the cap in force when it was last written.
Entries are sorted by name and unique.

A directory document only summarizes. A file's own document is the truth about
that file, and where a store can be listed, the folder listing is the truth
about which entries exist. A writer is free to write directory documents some
time after the entries they list (FragmentedFS does); a reader that can list a
folder reconciles the two.

## Names

- `.fragmentedfs-dir` is reserved in every directory: it is the name of the
  directory document, minus `.json`.
- A file or symlink `x` and a directory `x.json` cannot share a directory; both
  would be `metadata/.../x.json`. Every other `.json` name, `package.json`
  included, is ordinary (`package.json` is `package.json.json`).
- A name is a single path component of at most 250 UTF-8 bytes (the 255-byte
  limit of common filesystems, less `.json`), not `.` or `..`, with no `/` or
  NUL. Readers refuse a document whose entries break this.

## Validation

A reader checks, and refuses a document that fails with EIO: it is a JSON
object with `"format": "fragmentedfs/1"`; every number is a whole number in
range; blob names are hex and hashes are 64 lowercase hex digits; fragment
indexes are 0, 1, 2, ...; the sizes add up; a directory lists each name once.
Blobs are checked when fetched: their length against `size`, their SHA-256
against the fragment's.

## Metadata packs

A published store can hold its metadata as one binary file instead of the
`metadata/` folder, so that it is not one file per document. `fragmentedfs
pack-metadata <store> [--segment-mb N]` writes it and removes `metadata/` once
every document has been read back and compared. Readers (`httpFragmentStore`,
`nodeDirectoryFragmentStore`, `fsFragmentStore`) look for `metadata.pack.0` first
and return the same documents. A store with a pack is read-only.

The pack is cut into `metadata.pack.0`, `metadata.pack.1`, ... of at most N MiB
(default 8) by bytes alone: they are concatenated to read it. Numbers are LEB128,
strings a length and UTF-8, hashes 32 raw bytes.

    "FFMP" | version 1 (byte) | segments | body length | SHA-256 of the body | body

The body is the root directory, with its children inside it:

    directory:  attributes | maxFragmentBytes + 1, or 0 | entry count | entries
    entry:      tag: type (0 file, 1 directory, 2 symlink), +4 if attributes follow
                [the entry's attributes, when they differ from its document's] | the document
    file:       attributes | size | SHA-256 | fragment count | fragments
    fragment:   flags (1 hole, 2 same SHA-256 as the file) | size
                [unless a hole: blob name's length in digits | its digits as bytes, an odd one padded with 0
                 | SHA-256, unless flag 2]
    symlink:    attributes | target
    attributes: name | mode | uid | gid | mtime | mtimeNsec | ctime | ctimeNsec

A directory's entries are not written again: an entry's `size`, `sha256`, `target`
and `metadata` come from the document it stands for. A store where they disagree is
refused when packing. A reader refuses a pack with the wrong magic or version, a
wrong hash or length, a missing segment, a bad name, or bytes after the last document.
