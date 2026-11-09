// A root filesystem published as a FragmentedFS store (github.com/Spark-Linux/fragmentedfs, vendored in vendor/fragmentedfs;
// built by tools/tar-to-ffs.mjs): <base>/metadata.pack.0 (every file's and directory's document, one request), <base>/blobs/<id>
// (the contents in pieces of at most 4 MiB, each checked against its SHA-256 as it arrives) and <base>/hardlinks.json.
// Nanite takes a root as a tar stream (loadTarStream), so the store is walked and written out as one: directories first,
// then each file from its blobs, several files fetched ahead at once. Blobs never change (a new version gets new names), so
// the service worker keeps them: an interrupted first start resumes where it stopped, and a root fetched once starts offline.
import { fragmentedFS, httpFragmentStore, type FragmentedFileSystem, type FragmentedNode } from "fragmentedfs";

const S_IFMT = 0o170000, S_IFDIR = 0o040000, S_IFLNK = 0o120000, S_IFREG = 0o100000;
const AHEAD = 24;          // files fetched ahead of the one being written
const enc = new TextEncoder();

type Entry = { path: string; type: "5" | "0" | "2" | "1"; mode: number; uid: number; gid: number; mtime: number; size: number; link?: string; node?: FragmentedNode };

/** The store at `base` as a tar stream for Nanite, and its exact length in bytes. */
/** `download` is what actually crosses the network (gzipped blobs + metadata, from <base>/stats.json): the tar is ~2.7x bigger. */
export async function ffsTar(base: string): Promise<{ body: ReadableStream<Uint8Array>; total: number; files: number; download: number }> {
  const url = new URL(base, location.href);
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  const fs = await fragmentedFS(httpFragmentStore(url), { readOnly: true, concurrency: 4, cacheMB: 16 });
  const json = (name: string) => fetch(new URL(name, url)).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  const [hard, stats]: [Record<string, string>, { sent?: number }] = await Promise.all([json("hardlinks.json"), json("stats.json")]);

  // The tree, in tar order: a directory before what it holds.
  const list: Entry[] = [];
  async function walk(dir: FragmentedNode, prefix: string): Promise<void> {
    const h = await fs.opendir!(dir, 0);
    const kids: { name: string; node: FragmentedNode }[] = [];
    for await (const e of await fs.readdir!(dir, h)) if (e.name !== "." && e.name !== "..") kids.push(e);
    await fs.releasedir?.(dir, h);
    kids.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const { name, node } of kids) {
      const a = await fs.getattr(node), path = prefix + name, t = a.mode & S_IFMT;
      const base = { path, mode: a.mode & 0o7777, uid: a.uid ?? 0, gid: a.gid ?? 0, mtime: Number(a.mtime?.seconds ?? 0n) };
      if (t === S_IFDIR) { list.push({ ...base, type: "5", size: 0 }); await walk(node, `${path}/`); }
      else if (t === S_IFLNK) list.push({ ...base, type: "2", size: 0, link: await fs.readlink!(node) });
      else if (t === S_IFREG) list.push({ ...base, type: "0", size: Number(a.size), node });
    }
  }
  await walk(fs.root, "");
  for (const [path, target] of Object.entries(hard)) list.push({ path, type: "1", mode: 0o644, uid: 0, gid: 0, mtime: 0, size: 0, link: target });

  const headers = list.map(header);
  const total = headers.reduce((n, h, i) => n + h.length + pad(list[i]!.size) + list[i]!.size, 0) + 1024;
  const files = list.filter((e) => e.type === "0");

  // Each file's contents, fetched AHEAD files in advance (the store verifies every blob).
  const pending = new Map<Entry, Promise<Uint8Array>>();
  let next = 0;
  const fetchAhead = () => { while (next < files.length && pending.size < AHEAD) { const e = files[next++]!; pending.set(e, readAll(fs, e)); } };
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(ctl) {
      if (i === list.length) { ctl.enqueue(new Uint8Array(1024)); ctl.close(); await fs.close().catch(() => {}); return; }
      const e = list[i]!, h = headers[i]!; i++;
      ctl.enqueue(h);
      if (e.type === "0" && e.size) {
        fetchAhead();
        const data = await pending.get(e)!; pending.delete(e); fetchAhead();
        ctl.enqueue(data);
        if (pad(e.size)) ctl.enqueue(new Uint8Array(pad(e.size)));
      } else if (e.type === "0") { pending.delete(e); }
    },
    async cancel() { await fs.close().catch(() => {}); },
  }, { highWaterMark: 4 });
  return { body, total, files: files.length, download: stats.sent ?? total };
}

async function readAll(fs: FragmentedFileSystem, e: Entry): Promise<Uint8Array> {
  if (!e.size) return new Uint8Array(0);
  const h = await fs.open!(e.node!, 0);
  try {
    const out = new Uint8Array(e.size);
    for (let at = 0; at < e.size; ) {
      const part = await fs.read!(e.node!, h, BigInt(at), e.size - at);
      if (!part.byteLength) throw new Error(`/${e.path} is shorter than its document says`);
      out.set(part, at); at += part.byteLength;
    }
    return out;
  } finally { await fs.release?.(e.node!, h); }
}

const pad = (n: number) => (512 - (n % 512)) % 512;
/** GNU tar headers for one entry: a ././@LongLink record first for a name or link over 100 bytes. */
function header(e: Entry): Uint8Array {
  const name = enc.encode(e.type === "5" ? `${e.path}/` : e.path), link = enc.encode(e.link ?? "");
  const parts: Uint8Array[] = [];
  if (name.length > 100) parts.push(...longLink("L", name));
  if (link.length > 100) parts.push(...longLink("K", link));
  parts.push(block(name.subarray(0, 100), e.type, e.size, e.mode, e.uid, e.gid, e.mtime, link.subarray(0, 100)));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0; for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
function longLink(type: "L" | "K", value: Uint8Array): Uint8Array[] {
  const data = new Uint8Array(value.length + 1 + pad(value.length + 1)); data.set(value);
  return [block(enc.encode("././@LongLink"), type, value.length + 1, 0o644, 0, 0, 0, new Uint8Array(0)), data];
}
function block(name: Uint8Array, type: string, size: number, mode: number, uid: number, gid: number, mtime: number, link: Uint8Array): Uint8Array {
  const h = new Uint8Array(512), oct = (o: number, n: number, v: number) => h.set(enc.encode(v.toString(8).padStart(n - 1, "0") + "\0"), o);
  h.set(name, 0); oct(100, 8, mode); oct(108, 8, uid); oct(116, 8, gid); oct(124, 12, size); oct(136, 12, mtime);
  h.fill(32, 148, 156); h[156] = type.charCodeAt(0); h.set(link, 157);
  h.set(enc.encode("ustar  \0"), 257);   // GNU tar's magic: the L / K records are GNU's
  let sum = 0; for (const b of h) sum += b;
  h.set(enc.encode(sum.toString(8).padStart(6, "0") + "\0 "), 148);
  return h;
}

/** Drops the store's blobs from the service worker's cache once the root is on its disk (they would double its size there). */
export async function forgetFfsCache(base: string): Promise<void> {
  try {
    const prefix = new URL(base, location.href).href, cache = await caches.open("nanite-roots");
    for (const req of await cache.keys()) if (req.url.startsWith(prefix)) await cache.delete(req);
  } catch {}
}
