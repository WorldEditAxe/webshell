// node server.mjs [port]: serves the built page (dist/, from npm run build), the root images and VS Code (public/), and builds
// root filesystems from Docker images on request (/api/docker, below).
import http from "node:http";
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { spawn } from "node:child_process";
const here = path.dirname(new URL(import.meta.url).pathname);
const ROOTS = ["dist", "public"].map((d) => path.join(here, d));
const PORT = +(process.argv[2] ?? process.env.PORT ?? 8090);
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".woff2": "font/woff2", ".woff": "font/woff", ".svg": "image/svg+xml", ".json": "application/json", ".gz": "application/gzip",
  ".wasm": "application/wasm", ".ttf": "font/ttf", ".png": "image/png", ".ico": "image/x-icon", ".map": "application/json", ".txt": "text/plain", ".webmanifest": "application/manifest+json" };

function sendFile(req, res, file, st, immutable, extra = {}) {
  const since = Date.parse(req.headers["if-modified-since"] ?? "");
  if (!immutable && since && Math.floor(st.mtimeMs / 1000) * 1000 <= since) { res.writeHead(304).end(); return; }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream", "Content-Length": st.size,
    "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache", "Last-Modified": st.mtime.toUTCString(), ...extra });
  if (req.method === "HEAD") res.end(); else fs.createReadStream(file).pipe(res);
}

// ---- Root filesystems from Docker images ----------------------------------------------------------------------------------
// POST /api/docker?image=NAME starts building (or reports) a root from a Docker Hub image: docker pull (linux/amd64), docker
// export, tools/export-rootfs.py (drops /dev), gzip, into cache/docker/KEY.tar.gz. GET /api/docker?image=NAME reports
// { state: "queued" | "pulling" | "exporting" | "ready" | "error", url?, size?, error? }; the file is GET /api/docker/KEY.tar.gz.
// The site is public: names are checked, one image builds at a time, images over 2 GB are refused, at most 6 roots are kept,
// and a pulled image is removed again once exported (if it was not on this machine before).
const CACHE = path.join(here, "cache", "docker");
fs.mkdirSync(CACHE, { recursive: true });
const MAX_IMAGE = 2e9, KEEP = 6;
const IMAGE_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*){0,2}(?::[\w][\w.-]{0,127})?$/;
const jobs = new Map();
let chain = Promise.resolve();
const keyOf = (image) => image.replace(/[^a-z0-9._-]/g, "_");
const run = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
  const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
  let out = "", err = "";
  p.stdout.on("data", (d) => { out += d; }); p.stderr.on("data", (d) => { err += d; });
  p.on("error", reject);
  p.on("close", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(err.trim().split("\n").pop() || `${cmd} exited ${code}`))));
});
function evict() {
  const files = fs.readdirSync(CACHE).filter((f) => f.endsWith(".tar.gz")).map((f) => ({ f, t: fs.statSync(path.join(CACHE, f)).mtimeMs }));
  files.sort((a, b) => b.t - a.t).slice(KEEP).forEach(({ f }) => fs.rmSync(path.join(CACHE, f), { force: true }));
}
async function build(image, job) {
  const key = keyOf(image), out = path.join(CACHE, `${key}.tar.gz`);
  const had = await run("docker", ["image", "inspect", image]).then(() => true, () => false);
  job.state = "pulling";
  await run("docker", ["pull", "-q", "--platform", "linux/amd64", image]);
  let c = null;
  try {
    const size = +(await run("docker", ["image", "inspect", "--format", "{{.Size}}", image]));
    if (size > MAX_IMAGE) throw new Error(`the image is ${(size / 1e9).toFixed(1)} GB; at most ${MAX_IMAGE / 1e9} GB here`);
    job.state = "exporting";
    c = await run("docker", ["create", "--platform", "linux/amd64", image, "/bin/true"]);
    await new Promise((resolve, reject) => {
      const exp = spawn("docker", ["export", c], { stdio: ["ignore", "pipe", "ignore"] });
      const flt = spawn("python3", ["-I", path.join(here, "tools", "export-rootfs.py")], { stdio: ["pipe", "pipe", "ignore"] });
      const gz = spawn("gzip", ["-6"], { stdio: ["pipe", fs.openSync(`${out}.part`, "w"), "ignore"] });
      exp.stdout.pipe(flt.stdin); flt.stdout.pipe(gz.stdin);
      let left = 3; const done = (code) => { if (code !== 0) reject(new Error("docker export failed")); else if (--left === 0) resolve(); };
      exp.on("close", done); flt.on("close", done); gz.on("close", done);
    });
    fs.renameSync(`${out}.part`, out);
    job.size = fs.statSync(out).size;
    evict();
  } finally {
    fs.rmSync(`${out}.part`, { force: true });
    if (c) await run("docker", ["rm", "-f", c]).catch(() => {});
    if (!had) await run("docker", ["rmi", image]).catch(() => {});
  }
}
function dockerStatus(image, start) {
  if (!IMAGE_RE.test(image) || image.length > 200) return { state: "error", error: "not a Docker image name (like alpine:3.22 or library/debian:trixie)" };
  if (!image.includes(":")) image += ":latest";
  const key = keyOf(image), file = path.join(CACHE, `${key}.tar.gz`);
  let job = jobs.get(image);
  if ((!job || job.state === "error") && fs.existsSync(file)) return { state: "ready", url: `api/docker/${key}.tar.gz`, size: fs.statSync(file).size, image };
  if (!job || (start && job.state === "error")) {
    if (!start) return { state: "none", image };
    job = { state: "queued" }; jobs.set(image, job);
    chain = chain.then(() => build(image, job).then(() => { job.state = "ready"; }, (e) => { job.state = "error"; job.error = e.message; }));
  }
  return { ...job, image, ...(job.state === "ready" ? { url: `api/docker/${key}.tar.gz` } : {}) };
}

http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  let p = decodeURIComponent(u.pathname);
  if (p === "/api/docker") {
    const body = JSON.stringify(dockerStatus((u.searchParams.get("image") ?? "").trim().toLowerCase(), req.method === "POST"));
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(body); return;
  }
  if (p.startsWith("/api/docker/")) {
    const f = path.join(CACHE, path.basename(p)), st = fs.existsSync(f) ? fs.statSync(f) : null;
    if (!st?.isFile()) { res.writeHead(404).end("not found\n"); return; }
    sendFile(req, res, f, st, false); return;
  }
  if (p === "/") p = "/index.html";
  for (const root of ROOTS) {
    const f = path.join(root, path.normalize(p));
    if (!f.startsWith(root + path.sep)) continue;
    // A root's blob from a git checkout: only blobs.gz/ is kept, so it is sent from there (inflated for a client without gzip).
    if (/^\/roots\/[^/]+\.ffs\/blobs\/[0-9a-f]+$/.test(p) && !fs.existsSync(f)) {
      const gz = path.join(path.dirname(path.dirname(f)), "blobs.gz", path.basename(f));
      if (!fs.existsSync(gz)) continue;
      const head = { "Content-Type": "application/octet-stream", "Cache-Control": "public, max-age=31536000, immutable", "Vary": "Accept-Encoding" };
      if (/\bgzip\b/.test(req.headers["accept-encoding"] ?? "")) { sendFile(req, res, gz, fs.statSync(gz), true, { ...head, "Content-Encoding": "gzip" }); return; }
      res.writeHead(200, head);
      if (req.method === "HEAD") res.end(); else fs.createReadStream(gz).pipe(zlib.createGunzip()).pipe(res);
      return;
    }
    let st; try { st = fs.statSync(f); } catch { continue; }
    // A root's FragmentedFS blobs (tools/tar-to-ffs.mjs) never change; most have a gzip copy in blobs.gz/, sent compressed to
    // a browser that takes gzip (fetch inflates it before the page checks the blob's SHA-256).
    if (st.isFile() && /^\/roots\/[^/]+\.ffs\/blobs\/[0-9a-f]+$/.test(p)) {
      const gz = path.join(path.dirname(path.dirname(f)), "blobs.gz", path.basename(f)), gst = /\bgzip\b/.test(req.headers["accept-encoding"] ?? "") && fs.existsSync(gz) ? fs.statSync(gz) : null;
      if (gst) sendFile(req, res, gz, gst, true, { "Content-Type": "application/octet-stream", "Content-Encoding": "gzip", "Vary": "Accept-Encoding" });
      else sendFile(req, res, f, st, true, { "Vary": "Accept-Encoding" });
      return;
    }
    // Vite's assets/ have content hashes in their names: those never change.
    if (st.isFile()) { sendFile(req, res, f, st, p.startsWith("/assets/")); return; }
  }
  res.writeHead(404).end("not found\n");
}).listen(PORT, () => console.log(`http://localhost:${PORT}/`));
