# FragmentedFS

A filesystem split into many small files. Where a guest sees one large tree,
the store holds two folders: `blobs/`, the contents in pieces named by random
hex strings and capped at a size you choose, and `metadata/`, one JSON document
per file (its name, the SHA-256 of the whole file, its fragments in assembly
order, the SHA-256 of each) and one per directory that describes it and
enumerates what it holds. The format is in `docs/FORMAT.md`.

It is a library with no dependencies, for Node and browsers, and an `FS`
backend for [browser-linux](../kernel)'s virtio-fs and virtio-9p devices: a
guest mounts a FragmentedFS like any other share. Why split a filesystem:

- host a big image on a static web server or CDN with a per-file size limit, and
  let a browser fetch only the pieces a guest touches;
- keep a filesystem in IndexedDB or OPFS in pieces that never need a gigabyte of
  contiguous memory;
- move, upload and cache it as small immutable objects (a blob never changes, so
  it can be cached forever and resumed);
- verify it: every fragment and every file carries a SHA-256.

    npm install && npm run build           # dist/
    npm test                               # 34 tests, no other repository needed

## Use

    import { fragmentedFS, nodeDirectoryFragmentStore, packDirectory } from "fragmentedfs";

    // Split a host directory into blobs/ and metadata/ (4 MB blobs by default).
    const fs = await fragmentedFS(nodeDirectoryFragmentStore("/srv/disk"), { maxFragmentMB: 4 });
    await packDirectory("/path/to/rootfs", fs);
    await fs.close();

`fragmentedFS` returns an `FS`: `lookup`, `getattr`, `create`, `read`, `write`,
`readdir`, `rename` and the rest of the contract in `src/contract.ts`, so
anything that serves an `FS` serves a FragmentedFS. In browser-linux:

    import { bootMachine, fragmentedFSDevice } from "browser-linux";

    await bootMachine({ cpus: 2, initcpio, plugins: [
      fragmentedFSDevice(nodeDirectoryFragmentStore("/srv/disk"), { tag: "disk" }),  // mount -t 9p -o trans=virtio disk /mnt
      // or, over virtio-fs:  { tag: "disk", transport: "virtio-fs" }              // mount -t virtiofs disk /mnt
    ]});

The command line does the same without code:

    fragmentedfs pack <directory> <store> [--max-mb N]    split a directory (default 4 MB blobs)
    fragmentedfs unpack <store> <directory>               assemble a store back into a directory
    fragmentedfs verify <store> [--against <directory>]   check every blob and document, and that the store is that directory
                        [--remove-orphans]                  delete blobs no document uses

### In a browser

    import { fragmentedFS, httpFragmentStore } from "fragmentedfs";
    const fs = await fragmentedFS(httpFragmentStore("https://example.com/disk/"));   // read-only, plain static files

`httpFragmentStore` needs only `GET <base>/metadata/<path>` and
`GET <base>/blobs/<id>` (with CORS if the page is on another origin); there is
no manifest, since the directory documents are the index. Listing a directory
fetches its one document; opening a file fetches its document and then one
request per fragment, each verified and cached.

## API

    fragmentedFS(store, options?)       Promise<FragmentedFileSystem>   opens the store, starting an empty
                                                                         filesystem in a writable store that has none
    lazyFragmentedFS(store, options?)   FragmentedFileSystem            at once; the first operation opens the store
                                                                         (for building a device before the store is read)

A `FragmentedFileSystem` is an `FS` and also has:

    fs.ready()              resolves once the store is open
    fs.sync()               write every changed file and directory document now
    fs.close()              sync, then close the store (a device calls it on shutdown)
    fs.maxFragmentBytes     the cap in bytes
    fs.store

### Options

| Option | Default | Meaning |
|---|---|---|
| `maxFragmentMB` | 4 | The largest blob, in megabytes (1 MB = 1 MiB); may be fractional. Applies to what is written from now on; existing blobs read as they are, and one over the cap is cut when it is next changed. |
| `readOnly` | false | Every change fails with EROFS. Also the case whenever the store is read-only. |
| `verify` | true | Check a blob's size and SHA-256 against its document each time it is fetched; a mismatch is EIO, never wrong bytes. |
| `cacheMB` | 64 | Verified blobs kept for rereading, least recently used out first. |
| `maxDirtyMB` | 64 | Written data held in memory before files are committed early. |
| `indexDelayMs` | 200 | How long a changed directory document waits before it is written (see below). |
| `concurrency` | 4 | Blobs transferred at once for one file. |
| `blobIdBytes` | 16 | Random bytes in a blob's name. |
| `uid`, `gid` | 0 | Owner of the root of a new filesystem. |
| `capacityGB` | 256 | The size `statfs` reports; there is no limit but the store's. |

### Stores

A `FragmentStore` is everything the filesystem asks of storage: documents under
`metadata/` by relative path, blobs under `blobs/` by id. Put replaces
atomically; delete of nothing is not an error; listing and renaming a folder are
optional. Every method returns a promise.

    nodeDirectoryFragmentStore(directory, { readOnly?, durable? })   host directory (Node)
    fsFragmentStore(backing: FS, { readOnly?, durable? })            blobs/ and metadata/ inside any FS
    httpFragmentStore(baseUrl, { fetch?, headers? })                 read-only, plain static files
    memoryFragmentStore()                                            two Maps, for tests

`fsFragmentStore` keeps the two folders in any other `FS` backend (browser-linux
has OPFS, IndexedDB and a read-only HTTP tree). Documents are written to a
temporary name and renamed into place where the backend can rename; the
backend's namespace changes go one at a time, since backends are not promised
to be atomic against each other. A backend that refuses changes with EROFS
instead of leaving its write methods out needs `{ readOnly: true }`. A store of
your own implements `FragmentStore` from `src/store.ts`.

### Tools

    packDirectory(directory, fs)           host directory -> filesystem (Node)
    unpackDirectory(fs, directory)         filesystem -> host directory (Node)
    copyFileSystem(source, destination)    any FS to any FS, carrying modes, owners, times and symlinks
    verifyFragmentedFS(store, options?)    check a store against its own documents
    compareDirectory(directory, store)     check a store against the directory it was made from

`verifyFragmentedFS` reads the store directly, not through the filesystem: every
document parses; every blob exists with the size and SHA-256 its document gives;
the fragments hash to the file's SHA-256; directory documents agree with the
folders; and, where the store can list blobs, none is unused. Unused blobs are
garbage, not damage: they are reported, and deleted with `removeOrphans`.

`compareDirectory` says more than that: a store can be consistent with itself and
still not be the directory it was made from. It walks the store's documents and
the host directory together and reports every entry in one and not the other, a
different type, and for each file its size, mode, owner and modification time
and its SHA-256, computed again from the host file (not trusted from anywhere).
A symlink's target and a directory's mode and owner are compared too.
`packDirectory` carries times to the nanosecond; `unpackDirectory` sets them
through Node's `lutimes`, which takes floating-point seconds and rounds below a
microsecond, so compare an unpacked directory with `timeToleranceNs: 1000`.

## How writes work

Reads go straight to the fragment that holds the offset. Writes are held in
memory per fragment and committed when the file is flushed (every `close(2)`),
`fsync`ed, released, or when `maxDirtyMB` is exceeded. A commit writes each
changed fragment as a **new** blob under a new random name, then replaces the
file's document, then deletes the blobs the document no longer names. The
document is the commit point: a crash before it leaves the old file intact (plus
unused new blobs for `verify` to find); after it, the new one. Appending to a
file therefore rewrites only its last fragment, an overwrite in the middle
rewrites only the fragments it touches, and renaming a file or directory moves a
document and no blob at all.

The whole-file hash is maintained incrementally while a file is only appended
to (the common case: a download, a build output, a `cp`). Any other change to a
file means rereading its fragments at the next commit to hash them: a small
edit to a large file costs a pass over the file per commit, which is the price
of a whole-file hash in the document.

Directory documents are written **behind**: a burst of creations rewrites a
document once, `indexDelayMs` after the first of them (a directory with
thousands of entries waits longer, one millisecond each, so extracting a big
archive is not quadratic), and `fsync`, `sync()` and `close()` write them at
once. They only summarize: a file's own document is the truth about it. When a
writable store can list its folders, opening a directory reconciles its
document with the listing, so a crash between a file's commit and its directory's
write loses nothing: the file is found, the removed one is not, and the
document is repaired. A store that cannot list (HTTP, or a backend without
`readdir`) is trusted to be what its directory documents say.

An unlinked file that is still open stays readable and writable, and its blobs
are deleted when the last handle closes.

## Limits

- No hard links (`link` is not offered; `ln` fails): a hard link would share a
  document, and documents mirror paths.
- No devices, FIFOs, sockets or extended attributes.
- A directory is one document, rewritten whole: a directory of hundreds of
  thousands of entries makes for a document of tens of megabytes.
- Two filesystems must not write one store at once. Any number may read it.
- A directory's `mtime` in its parent's listing is as of the parent's last
  write; the directory's own document has the current one.
- Names: `.fragmentedfs-dir` is reserved, a file `x` and a directory `x.json`
  cannot share a directory, and a name is at most 250 bytes (`docs/FORMAT.md`).

## Tests

`npm test` builds and runs 34 tests against nothing but this repository:
`test/filesystem.test.mjs` (the format and cap; hashes of fragments and files;
random reads and writes against a plain buffer, reopened; sparse files,
truncate, a lowered cap; rename and unlink while open; corruption, hostile
documents, a crash before directory documents; read-only; a concurrent storm;
split and assemble) and `test/stores.test.mjs` (the two folders on disk; pack and
unpack a host directory; `compareDirectory`; the command line; plain static HTTP, where a listing is
one request; any `FS` backend, with and without `rename` and `readdir`; keys that
cannot escape; lazy opening).

The integration with browser-linux's devices is tested in that repository
(`kernel/package/test/fragmentedfs*.test.mjs`): a guest mounts a store over
virtio-9p and virtio-fs, and `recipes/tests/fragmentedfs.mjs` has an Alpine
guest write into it with `dd`, `cp`, `mv`, `ln`, `truncate` and `tar`.
`recipes/scripts/fragment-repo.sh` converts the whole apk package repository into
a FragmentedFS this way (7.5 GB, checked with `compareDirectory`).
