#!/usr/bin/env node
// tools/build-single.mjs (npm run single): the whole webshell in one file, single/nanite-webshell.html (and dist/, after
// npm run build, for the page's Offline HTML link). Opened from disk or
// any host, it needs nothing else but the network for the Wisp relay (the machine's internet) and Alpine's package mirrors.
//
// Inside, besides the page (vite.single.config.ts: scripts, styles and fonts inlined): Nanite (nanite.js, nanite.wasm,
// vkernel.wasm from packages.sparkpowered.org) and a minimal root, Alpine's minirootfs, with a short /etc/motd (basic commands,
// apk, ssh). Each is gzipped and base64 encoded (the page inflates them with DecompressionStream). Downloads are kept in
// cache/single/, along with libcurl.js (playit.gg's API). Left out: what a single file cannot run: VS Code for the Web and the
// Web Browser tab (both need a service worker and files served beside the page) and Docker roots (built by server.mjs); and the
// other built-in roots (the root here is the minimal one).
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync, constants } from "node:zlib";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";

const here = join(dirname(new URL(import.meta.url).pathname), "..");
const cache = join(here, "cache", "single"), out = join(here, "single");
const PKG = process.env.NANITE_PKG ?? "https://packages.sparkpowered.org", ALPINE = "https://dl-cdn.alpinelinux.org/alpine/v3.22/releases/x86_64";
await mkdir(cache, { recursive: true });

async function get(url, file, fresh = false) {
  const p = join(cache, file);
  if (!fresh && existsSync(p)) return readFile(p);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  const b = Buffer.from(await r.arrayBuffer());
  await writeFile(p, b);
  return b;
}

// Nanite: always the current upstream build.
const lib = `${PKG}/lib/nanitevisor`;
const nanite = { js: await get(`${lib}/nanite.js`, "nanite.js", true), wasm: await get(`${lib}/nanite.wasm`, "nanite.wasm", true), vkernel: await get(`${lib}/vkernel.wasm`, "vkernel.wasm", true) };

// Alpine's minirootfs, checked against its published SHA-256.
const yaml = await (await fetch(`${ALPINE}/latest-releases.yaml`)).text();
const name = yaml.match(/file: (alpine-minirootfs-[\d.]+-x86_64\.tar\.gz)/)?.[1];
if (!name) throw new Error("no minirootfs in latest-releases.yaml");
const rootGz = await get(`${ALPINE}/${name}`, name);
const want = (await (await fetch(`${ALPINE}/${name}.sha256`)).text()).split(/\s/)[0];
if (createHash("sha256").update(rootGz).digest("hex") !== want) throw new Error(`${name}: SHA-256 mismatch`);
const version = name.match(/minirootfs-([\d.]+)-/)[1];

// The root's tar, with the motd and the script that shows it at a login shell (only in the first terminal; ~/.hidemotd hides it).
const MOTD = `Alpine Linux ${version} in your browser, on Nanite

Packages (apk)
  apk update                  refresh the package lists (run this first)
  apk upgrade                 update everything installed
  apk add <name>              install, e.g. apk add bash curl nano git
  apk del <name>              remove a package
  apk search <word>           find packages

SSH
  apk add openssh-client      then: ssh user@host
  ssh-keygen -t ed25519       make a key (~/.ssh/id_ed25519.pub)

Basic commands
  ls -la, cd, pwd, cat, less, cp, mv, rm, mkdir   files
  vi <file>                   edit (or apk add nano)
  wget -O- https://example.com                    fetch a page
  ps, top, free -m, df -h, uname -a               the system

Files stay in this browser. touch ~/.hidemotd hides this message.
`;
const PROFILE = `# The motd in the first terminal's login shell (others set MOTD_SHOWN), unless ~/.hidemotd exists.
case $- in *i*)
  if [ -z "$MOTD_SHOWN" ] && [ -r /etc/motd ] && [ ! -e "$HOME/.hidemotd" ]; then cat /etc/motd; fi ;;
esac
`;
function tarEntry(path, text, mode = 0o644) {
  const body = Buffer.from(text), h = Buffer.alloc(512), put = (o, v) => h.write(v, o, "latin1");
  put(0, path); put(100, mode.toString(8).padStart(7, "0") + "\0"); put(108, "0000000\0"); put(116, "0000000\0");
  put(124, body.length.toString(8).padStart(11, "0") + "\0"); put(136, Math.floor(Date.now() / 1000).toString(8).padStart(11, "0") + "\0");
  h.fill(32, 148, 156); h[156] = 48; put(257, "ustar\0"); put(263, "00");
  put(148, [...h].reduce((a, b) => a + b, 0).toString(8).padStart(6, "0") + "\0 ");
  return Buffer.concat([h, body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
}
// The minirootfs tar without its end-of-archive blocks, then our files (a later entry replaces the earlier /etc/motd), then the end.
let tar = gunzipSync(rootGz);
let end = tar.length;
while (end >= 512 && tar.subarray(end - 512, end).every((b) => b === 0)) end -= 512;
tar = Buffer.concat([tar.subarray(0, end), tarEntry("etc/motd", MOTD), tarEntry("etc/profile.d/00-motd.sh", PROFILE), Buffer.alloc(1024)]);

const gz = (b) => gzipSync(b, { level: constants.Z_BEST_COMPRESSION });
const assets = {
  naniteJs: gz(nanite.js).toString("base64"),
  naniteWasm: gz(nanite.wasm).toString("base64"),
  vkernelWasm: gz(nanite.vkernel).toString("base64"),
  root: gz(tar).toString("base64"),
  // playit.gg's API goes through libcurl.js (curl in WebAssembly, its wasm inside the module) over the Wisp relay.
  libcurl: gz(await readFile(join(here, "node_modules", "@mercuryworkshop", "libcurl-transport", "dist", "index.mjs"))).toString("base64"),
  rootName: `Alpine Linux ${version}`,
  // The disk is named after the image: a new image starts a fresh disk instead of mixing with the old one.
  rootDisk: `single-alpine-${version}-${createHash("sha256").update(tar).digest("hex").slice(0, 8)}`,
  rootBytes: tar.length,
};
await writeFile(join(cache, "assets.json"), JSON.stringify(assets));

// The page (vite.single.config.ts reads cache/single/assets.json), then everything inlined into one HTML file.
await rm(join(out, "build"), { recursive: true, force: true });
execFileSync(join(here, "node_modules", ".bin", "vite"), ["build", "--config", "vite.single.config.ts"], { cwd: here, stdio: "inherit" });
const build = join(out, "build");
let html = await readFile(join(build, "index.html"), "utf8");
const file = (ref) => readFile(join(build, ref.replace(/^\.?\//, "")), "utf8");
for (const m of [...html.matchAll(/<link rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g)]) {
  const css = await file(m[1]);
  html = html.replace(m[0], () => `<style>${css.replace(/<\/style/gi, "<\\/style")}</style>`);
}
for (const m of [...html.matchAll(/<script type="module"[^>]*src="([^"]+)"[^>]*><\/script>/g)]) {
  const js = await file(m[1]);
  html = html.replace(m[0], () => `<script type="module">${js.replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--")}</script>`);
}
html = html.replace(/<link rel="modulepreload"[^>]*>\n?/g, "");
const left = [...html.matchAll(/(?:src|href)="(?!data:|https?:|#)([^"]+)"/g)].map((m) => m[1]);
if (left.length) throw new Error(`not inlined: ${left.join(", ")}`);
const target = join(out, "nanite-webshell.html");
await writeFile(target, html);
// Beside the normal build's page too (its menu's Offline HTML link): server.mjs serves dist/, build-cf.mjs puts it in cf-dist/.
if (existsSync(join(here, "dist", "index.html"))) await writeFile(join(here, "dist", "nanite-webshell.html"), html);
await rm(build, { recursive: true, force: true });
console.log(`${target}: ${(html.length / 1e6).toFixed(1)} MB (${assets.rootName}, ${(assets.rootBytes / 1e6).toFixed(1)} MB unpacked)`);
