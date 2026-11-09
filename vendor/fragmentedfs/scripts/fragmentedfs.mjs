#!/usr/bin/env node
// Splits a directory into a FragmentedFS store, assembles one back, and checks
// one against its own documents (README.md). Run it after `npm run build`
// (installed as the `fragmentedfs` command).
//
//   node scripts/fragmentedfs.mjs pack <directory> <store> [--max-mb N]
//   node scripts/fragmentedfs.mjs unpack <store> <directory>
//   node scripts/fragmentedfs.mjs verify <store> [--against <directory>] [--remove-orphans]
//   node scripts/fragmentedfs.mjs pack-metadata <store> [--segment-mb N]
//
// `<store>` is a directory that holds (or will hold) `blobs/` and `metadata/`;
// serve it with any static web server and `httpFragmentStore` reads it.
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_SEGMENT_BYTES,
  compareDirectory,
  compareMetadata,
  fragmentedFS,
  metadataSegmentName,
  nodeDirectoryFragmentStore,
  packDirectory,
  packMetadata,
  unpackDirectory,
  verifyFragmentedFS,
} from "../dist/index.js";

const usage = `usage:
  fragmentedfs.mjs pack <directory> <store> [--max-mb N]   split a directory into blobs and metadata (default 4 MB blobs)
  fragmentedfs.mjs unpack <store> <directory>              assemble a store back into a directory
  fragmentedfs.mjs verify <store> [--against <directory>]  check every blob and document, and that the store is that directory
                          [--remove-orphans]               delete blobs no document uses
  fragmentedfs.mjs pack-metadata <store> [--segment-mb N]  replace metadata/ with binary metadata.pack.<n> files
                                                           of at most N MiB (default 8); the store becomes read-only`;

const args = process.argv.slice(2);
// Removes `name` (and its value) from the arguments and returns the value, or true for a bare flag.
function take(name, takesValue) {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const taken = args.splice(at, takesValue ? 2 : 1);
  return takesValue ? taken[1] : true;
}
const maxMb = take("--max-mb", true);
const segmentMb = take("--segment-mb", true);
const removeOrphans = take("--remove-orphans", false);
const against = take("--against", true);
const [command, first, second] = args;
const fail = (message) => {
  console.error(`${message}\n\n${usage}`);
  process.exit(2);
};

const megabytes = (bytes) => (bytes / (1024 * 1024)).toFixed(1);

// A long run says where it is, on stderr, every ten seconds.
function progress(what) {
  const started = Date.now();
  let files = 0;
  let bytes = 0;
  let last = started;
  return (size = 0) => {
    files += 1;
    bytes += size;
    const now = Date.now();
    if (now - last >= 10_000) {
      last = now;
      const seconds = (now - started) / 1000;
      console.error(`${what}: ${files} files${bytes ? `, ${megabytes(bytes)} MB` : ""}, ${seconds.toFixed(0)} s`);
    }
  };
}

if (command === "pack") {
  if (!first || !second) fail("pack needs a directory and a store");
  const options = maxMb === undefined ? {} : { maxFragmentMB: Number(maxMb) };
  if (maxMb !== undefined && !(Number(maxMb) > 0)) fail("--max-mb must be a positive number");
  await mkdir(second, { recursive: true });
  const fs = await fragmentedFS(nodeDirectoryFragmentStore(second), options);
  const started = Date.now();
  const tick = progress("packed");
  const result = await packDirectory(first, fs, { onFile: (_path, size) => tick(size) });
  await fs.close();
  console.log(
    `${result.files} files, ${result.directories} directories, ${result.symlinks} symlinks, ` +
      `${megabytes(result.bytes)} MB in ${((Date.now() - started) / 1000).toFixed(1)} s, ` +
      `blobs of at most ${megabytes(fs.maxFragmentBytes)} MB` +
      (result.skipped ? `; skipped ${result.skipped} devices, pipes and sockets` : ""),
  );
} else if (command === "unpack") {
  if (!first || !second) fail("unpack needs a store and a directory");
  await mkdir(second, { recursive: true });
  const fs = await fragmentedFS(nodeDirectoryFragmentStore(first, { readOnly: true }), { readOnly: true });
  const result = await unpackDirectory(fs, second);
  await fs.close();
  console.log(`${result.files} files, ${result.directories} directories, ${result.symlinks} symlinks, ${megabytes(result.bytes)} MB`);
} else if (command === "pack-metadata") {
  if (!first) fail("pack-metadata needs a store");
  if (segmentMb !== undefined && !(Number(segmentMb) > 0)) fail("--segment-mb must be a positive number");
  // This store settles on what it finds at its first read, so it goes on reading the documents while the pack appears.
  const before = nodeDirectoryFragmentStore(first, { readOnly: true });
  const packed = await packMetadata(before, {
    maxSegmentBytes: segmentMb === undefined ? DEFAULT_SEGMENT_BYTES : Math.floor(Number(segmentMb) * 1024 * 1024),
  });
  // A segment left by an earlier, longer pack goes; each new one appears whole.
  for (const name of await readdir(first)) {
    if (/^metadata\.pack\.\d+$/.test(name) && Number(name.slice("metadata.pack.".length)) >= packed.segments.length) {
      await rm(join(first, name));
    }
  }
  for (const [index, segment] of packed.segments.entries()) {
    const target = join(first, metadataSegmentName(index));
    await writeFile(`${target}.tmp`, segment);
    await rename(`${target}.tmp`, target);
  }
  // The documents go only once the pack has given every one of them back.
  const compared = await compareMetadata(before, nodeDirectoryFragmentStore(first, { readOnly: true }));
  await rm(join(first, "metadata"), { recursive: true, force: true });
  console.log(
    `${packed.documents} documents, ${megabytes(packed.jsonBytes)} MB of JSON -> ${megabytes(packed.bytes)} MB in ` +
      `${packed.segments.length} segment${packed.segments.length === 1 ? "" : "s"}; ${compared} compared with the originals`,
  );
} else if (command === "verify") {
  if (!first) fail("verify needs a store");
  const store = nodeDirectoryFragmentStore(first, { readOnly: !removeOrphans });
  const report = await verifyFragmentedFS(store, { removeOrphans: Boolean(removeOrphans) });
  console.log(
    `${report.files} files, ${report.directories} directories, ${report.symlinks} symlinks, ` +
      `${report.fragments} fragments, ${megabytes(report.bytes)} MB`,
  );
  for (const error of report.errors) console.error(`ERROR ${error}`);
  if (report.orphans.length) {
    console.log(`${report.orphans.length} blobs no document refers to${removeOrphans ? " (deleted)" : " (--remove-orphans deletes them)"}`);
  }
  let different = 0;
  if (against) {
    const tick = progress("compared");
    const compared = await compareDirectory(against, store, { onFile: () => tick() });
    console.log(
      `compared with ${against}: ${compared.files} files (${megabytes(compared.bytes)} MB hashed again), ` +
        `${compared.directories} directories, ${compared.symlinks} symlinks: ` +
        (compared.mismatches.length ? `${compared.mismatches.length} differences` : "identical"),
    );
    for (const difference of compared.mismatches.slice(0, 50)) console.error(`DIFFERENT ${difference}`);
    if (compared.mismatches.length > 50) console.error(`... and ${compared.mismatches.length - 50} more`);
    different = compared.mismatches.length;
  }
  process.exit(report.errors.length || different ? 1 : 0);
} else {
  fail(command ? `unknown command ${command}` : "no command");
}
