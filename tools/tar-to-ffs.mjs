#!/usr/bin/env node
// tools/tar-to-ffs.mjs <root.tar.gz> <store>: a root filesystem's tar.gz -> a FragmentedFS store (vendor/fragmentedfs,
// github.com/Spark-Linux/fragmentedfs): <store>/blobs/ (the contents, in pieces of at most 4 MiB, named by random hex) and
// <store>/metadata.pack.* (every file's and directory's document in one file), which the page reads over plain HTTP
// (src/lib/ffsroot.ts) and streams into Nanite on a root's first start.
//
// Owners, modes, times and symlinks are kept (the tar is read here, so a non-root build loses nothing). FragmentedFS has no
// hard links: the second and later names of a file are left out of the store and listed in <store>/hardlinks.json
// ({ "path": "target", ... }), and the page restores them as hard links. Devices, FIFOs and sockets are skipped (Nanite
// provides /dev).
import { createReadStream } from "node:fs";
import { mkdir, rm, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createGunzip, gzipSync, constants } from "node:zlib";
import { readFile } from "node:fs/promises";
import { fragmentedFS, nodeDirectoryFragmentStore, packMetadata, metadataSegmentName } from "fragmentedfs";

const [src, out, ...rest] = process.argv.slice(2);
if (!src || !out) { console.error("usage: tar-to-ffs.mjs <root.tar.gz> <store> [--max-mb N]"); process.exit(2); }
const maxMB = Number(rest[rest.indexOf("--max-mb") + 1]) || 4;

const O_WRONLY = 1, O_CREAT = 0o100, O_EXCL = 0o200;
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
const store = nodeDirectoryFragmentStore(out);
const fs = await fragmentedFS(store, { maxFragmentMB: maxMB, indexDelayMs: 2000 });

// ---- tar reading (ustar, GNU long names 'L'/'K', pax 'x'; 'g' ignored) ----
async function* entries(stream) {
  let buf = Buffer.alloc(0), longName = null, longLink = null, pax = null;
  const it = stream[Symbol.asyncIterator]();
  async function need(n) {
    while (buf.length < n) { const { value, done } = await it.next(); if (done) return false; buf = buf.length ? Buffer.concat([buf, value]) : value; }
    return true;
  }
  const str = (b, o, n) => { const s = b.subarray(o, o + n); const z = s.indexOf(0); return (z < 0 ? s : s.subarray(0, z)).toString("utf8"); };
  const num = (b, o, n) => {
    if (b[o] & 0x80) { let v = 0n; for (let i = 1; i < n; i++) v = (v << 8n) | BigInt(b[o + i]); return Number(v); }
    const s = str(b, o, n).trim(); return s ? parseInt(s, 8) : 0;
  };
  for (;;) {
    if (!(await need(512))) return;
    const h = buf.subarray(0, 512);
    if (h.every((x) => x === 0)) return;
    const size = num(h, 124, 12), type = String.fromCharCode(h[156] || 48);
    const padded = Math.ceil(size / 512) * 512;
    if (!(await need(512 + padded))) throw new Error("truncated tar");
    const data = buf.subarray(512, 512 + size);
    buf = buf.subarray(512 + padded);
    if (type === "L") { longName = str(data, 0, size); continue; }
    if (type === "K") { longLink = str(data, 0, size); continue; }
    if (type === "x") { pax = {}; const t = data.toString("utf8"); let i = 0;
      while (i < t.length) { const sp = t.indexOf(" ", i); const len = parseInt(t.slice(i, sp), 10); const kv = t.slice(sp + 1, i + len - 1); const eq = kv.indexOf("="); pax[kv.slice(0, eq)] = kv.slice(eq + 1); i += len; }
      continue; }
    if (type === "g") continue;
    const prefix = str(h, 345, 155);
    let name = longName ?? pax?.path ?? (prefix ? `${prefix}/${str(h, 0, 100)}` : str(h, 0, 100));
    const link = longLink ?? pax?.linkpath ?? str(h, 157, 100);
    const e = { name, type, size: pax?.size ? Number(pax.size) : size, data: Buffer.from(data), link,
      mode: num(h, 100, 8) & 0o7777, uid: pax?.uid ? Number(pax.uid) : num(h, 108, 8), gid: pax?.gid ? Number(pax.gid) : num(h, 116, 8),
      mtime: pax?.mtime ? Number(pax.mtime) : num(h, 136, 12) };
    longName = longLink = pax = null;
    yield e;
  }
}

const clean = (p) => p.replace(/^\.?\/+/, "").replace(/\/+$/, "");
const dirs = new Map([["", fs.root]]);
async function dirOf(path) {
  if (dirs.has(path)) return dirs.get(path);
  const i = path.lastIndexOf("/"), parent = await dirOf(i < 0 ? "" : path.slice(0, i)), name = path.slice(i + 1);
  const node = (await fs.lookup(parent, name)) ?? (await fs.mkdir(parent, name, { mode: 0o40755, uid: 0, gid: 0 }));
  dirs.set(path, node); return node;
}
const split = (p) => { const i = p.lastIndexOf("/"); return [i < 0 ? "" : p.slice(0, i), p.slice(i + 1)]; };
const times = (s) => ({ mtime: { seconds: BigInt(s), nanoseconds: 0 } });

const hardlinks = {}, dirTimes = [];
let files = 0, bytes = 0, symlinks = 0, skipped = 0;
for await (const e of entries(createReadStream(src).pipe(createGunzip()))) {
  const path = clean(e.name);
  if (!path) { await fs.setattr(fs.root, { mode: e.mode, uid: e.uid, gid: e.gid }); dirTimes.push([fs.root, e.mtime]); continue; }
  const [dir, name] = split(path);
  const ctx = { uid: e.uid, gid: e.gid };
  if (e.type === "5") {
    const parent = await dirOf(dir);
    let node = await fs.lookup(parent, name);
    if (!node) node = await fs.mkdir(parent, name, { mode: 0o40000 | e.mode, ...ctx });
    else await fs.setattr(node, { mode: e.mode, ...ctx });
    dirs.set(path, node); dirTimes.push([node, e.mtime]);
  } else if (e.type === "0" || e.type === "7") {
    const parent = await dirOf(dir);
    const { node, handle } = await fs.create(parent, name, O_WRONLY | O_CREAT | O_EXCL, { mode: 0o100000 | e.mode, ...ctx });
    if (e.data.length) await fs.write(node, handle, 0n, e.data);
    await fs.flush(node, handle); await fs.release(node, handle);
    await fs.setattr(node, { mode: e.mode, ...ctx, ...times(e.mtime) });
    files++; bytes += e.data.length;
  } else if (e.type === "2") {
    await fs.symlink(await dirOf(dir), name, e.link, { mode: 0o120777, ...ctx });
    symlinks++;
  } else if (e.type === "1") {
    hardlinks[path] = clean(e.link);
  } else skipped++;
  if ((files + symlinks) % 2000 === 0) process.stderr.write(`\r${files} files, ${(bytes / 1e6).toFixed(0)} MB`);
}
// Directory times last: creating entries changed them.
for (const [node, t] of dirTimes) await fs.setattr(node, times(t));
await fs.close();
process.stderr.write(`\r${files} files, ${symlinks} symlinks, ${Object.keys(hardlinks).length} hard links, ${skipped} skipped, ${(bytes / 1e6).toFixed(1)} MB\n`);

// One metadata pack instead of a document per file (FORMAT.md, "Metadata packs"): the page fetches it in one request.
const packed = await packMetadata(nodeDirectoryFragmentStore(out));
for (const [i, seg] of packed.segments.entries()) await writeFile(join(out, metadataSegmentName(i)), seg);
await rm(join(out, "metadata"), { recursive: true, force: true });
await writeFile(join(out, "hardlinks.json"), JSON.stringify(hardlinks));
// A gzip copy of each blob that compresses, in <store>/blobs.gz/<id> (beside blobs/, which FragmentedFS keeps to itself), which
// server.mjs sends to browsers that take gzip.
const ids = await readdir(join(out, "blobs"));
await mkdir(join(out, "blobs.gz"), { recursive: true });
let raw = 0, sent = 0;
for (const id of ids) {
  const b = await readFile(join(out, "blobs", id)), z = gzipSync(b, { level: constants.Z_BEST_COMPRESSION });
  raw += b.length;
  if (z.length < b.length * 0.9) { await writeFile(join(out, "blobs.gz", id), z); sent += z.length; } else sent += b.length;
}
console.log(`gzip: ${(raw / 1e6).toFixed(1)} MB of blobs travel as ${(sent / 1e6).toFixed(1)} MB`);
for (let i = 0; i < packed.segments.length; i++) sent += packed.segments[i].length;
// What the page downloads (shown on its progress bar instead of the tar's unpacked size).
await writeFile(join(out, "stats.json"), JSON.stringify({ raw, sent }));
const blobs = ids.length;
console.log(`${out}: ${blobs} blobs, ${packed.documents} documents, metadata pack ${(packed.bytes / 1e6).toFixed(2)} MB in ${packed.segments.length} segment(s)`);
