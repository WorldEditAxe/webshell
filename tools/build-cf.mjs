#!/usr/bin/env node
// tools/build-cf.mjs: assembles cf-dist/, the static assets for Cloudflare Workers (wrangler.jsonc, cf/worker.js), from dist/
// (npm run build) and public/. Files are hard-linked, not copied. Each FragmentedFS blob goes up once: as blobs/ID.gz where
// tools/tar-to-ffs.mjs made a gzip copy (blobs.gz/ID), else as blobs/ID; the Worker serves both at blobs/ID.
import { readdirSync, statSync, mkdirSync, rmSync, linkSync, copyFileSync, writeFileSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
const here = join(dirname(new URL(import.meta.url).pathname), "..");
const out = join(here, "cf-dist"), LIMIT = 20000, MAX = 25 * 1024 * 1024;
rmSync(out, { recursive: true, force: true });
let files = 0;
function put(src, rel) {
  const dst = join(out, rel);
  if (statSync(src).size > MAX) throw new Error(`${rel} is over Cloudflare's 25 MiB per-file limit`);
  mkdirSync(dirname(dst), { recursive: true });
  try { linkSync(src, dst); } catch { copyFileSync(src, dst); }
  files++;
}
function walk(root, dir = root) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name), rel = relative(root, p), parts = rel.split(sep);
    if (statSync(p).isDirectory()) {
      if (parts.at(-1) === "blobs.gz") continue;          // taken with blobs/ below
      if (parts.at(-1) === "blobs" && parts.at(-2)?.endsWith(".ffs")) { blobs(p, rel); continue; }
      walk(root, p);
    } else put(p, rel);
  }
}
function blobs(dir, rel) {
  const gzdir = join(dirname(dir), "blobs.gz");
  for (const id of readdirSync(dir)) {
    const gz = join(gzdir, id);
    let has = false; try { has = statSync(gz).isFile(); } catch {}
    if (has) put(gz, join(rel, `${id}.gz`)); else put(join(dir, id), join(rel, id));
  }
}
walk(join(here, "public"));
walk(join(here, "dist"));
writeFileSync(join(out, "_headers"), [
  "/assets/*", "  Cache-Control: public, max-age=31536000, immutable",
  "/sw.js", "  Cache-Control: no-cache", "",
].join("\n"));
console.log(`cf-dist/: ${files} files${files > LIMIT ? ` — over the free plan's ${LIMIT} (Workers Paid allows 100,000)` : ` (free plan limit ${LIMIT})`}`);
