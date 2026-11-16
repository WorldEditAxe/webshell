#!/usr/bin/env node
// tools/build-single.mjs (npm run single): the whole webshell in one file, single/nanite-webshell.html (and dist/, after
// npm run build, for the page's Offline HTML link). Opened from disk or
// any host, it needs nothing else but the network for the Wisp relay (the machine's internet) and Alpine's package mirrors.
//
// Inside, besides the page (vite.single.config.ts: scripts, styles and fonts inlined): Nanite (nanite.js, nanite.wasm,
// vkernel.wasm from packages.sparkpowered.org) and a minimal root, Alpine's minirootfs, with a short /etc/motd (basic commands,
// apk, ssh). Each is gzipped (zopfli where pigz is installed) and written as 7-bit text (b7() below; the page inflates them
// with DecompressionStream). Downloads are kept in
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
const MOTD = `Welcome to Alpine Linux ${version}!

Packages (apk)
  apk update                  refresh the package lists (run this first)
  apk upgrade                 update everything installed
  apk add <name>              install, e.g. apk add bash curl nano git
  apk del <name>              remove a package
  apk search <word>           find packages

In your home directory
  ./install-ssh.sh            ssh, scp and sftp, and a key (./install-ssh.sh server: also sshd)
  ./install-desktop.sh        the XFCE desktop on the Display tab, then: startdesktop
  ~/disk                      a folder on your computer, once you choose one (the menu at the top right)

Basic commands
  ls -la, cd, pwd, cat, less, cp, mv, rm, mkdir   files
  vi <file>                   edit (or apk add nano)
  wget -O- https://example.com                    fetch a page
  ps, top, free -m, df -h, uname -a               the system

Everything is locally stored. Run "touch ~/.hidemotd" to hide this message.
`;
const PROFILE = `# A terminal's login shell starts in /: start it in the home directory (its scripts are there). Then the motd, in the first
# terminal's shell (others set MOTD_SHOWN), unless ~/.hidemotd exists.
case $- in *i*)
  [ "$PWD" = / ] && cd "$HOME"
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
// Scripts in root's home (demo/single/home: the XFCE desktop, ssh) and nanite-xkeys, the desktop's keyboard, built for musl
// (demo/single/rootfs/usr/local/bin; demo/single/README.md says how to rebuild it).
const extra = join(here, "demo", "single");
const scripts = await Promise.all(["install-desktop.sh", "install-ssh.sh"].map(async (f) => tarEntry(`root/${f}`, await readFile(join(extra, "home", f)), 0o755)));
tar = Buffer.concat([tar.subarray(0, end), tarEntry("etc/motd", MOTD), tarEntry("etc/profile.d/00-motd.sh", PROFILE), ...scripts,
  tarEntry("usr/local/bin/nanite-xkeys", await readFile(join(extra, "rootfs", "usr", "local", "bin", "nanite-xkeys")), 0o755), Buffer.alloc(1024)]);

// gzip, which the page inflates natively (DecompressionStream): with zopfli (pigz -11) where it is installed, a few % smaller.
function gz(b) {
  try { return execFileSync("pigz", ["-11", "-c"], { input: b, maxBuffer: 1 << 30, stdio: ["pipe", "pipe", "ignore"] }); }
  catch { return gzipSync(b, { level: constants.Z_BEST_COMPRESSION }); }
}
// Each embedded file goes into the HTML as 7-bit text (8 characters per 7 bytes; base64 takes 8 per 6), in a non-JS <script>
// whose text the parser leaves alone but for three characters: NUL, CR and "<" (which could close it). A 7-bit group that is
// one of those is written as one 2-byte character, U+0100 + (index << 7 | the next group), or U+0100 + (3 << 7 | index) at
// the very end. src/lib/single.ts decodes it.
const SPECIAL = [0, 13, 60];
function b7(bytes) {
  const out = []; let acc = 0, bits = 0, groups = [];
  for (const b of bytes) { acc = (acc << 8) | b; bits += 8; while (bits >= 7) { bits -= 7; groups.push((acc >> bits) & 127); } acc &= (1 << bits) - 1; }
  if (bits) groups.push((acc << (7 - bits)) & 127);
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i], s = SPECIAL.indexOf(g);
    if (s < 0) out.push(g);
    else if (i + 1 < groups.length) out.push(0x100 + ((s << 7) | groups[++i]));
    else out.push(0x100 + ((3 << 7) | s));
  }
  let str = "";
  for (let i = 0; i < out.length; i += 8192) str += String.fromCharCode(...out.slice(i, i + 8192));
  return str;
}
const files = {
  naniteJs: nanite.js, naniteWasm: nanite.wasm, vkernelWasm: nanite.vkernel, root: tar,
  // playit.gg's API goes through libcurl.js (curl in WebAssembly, its wasm inside the module) over the Wisp relay.
  libcurl: await readFile(join(here, "node_modules", "@mercuryworkshop", "libcurl-transport", "dist", "index.mjs")),
};
const blobs = Object.entries(files).map(([name, b]) => { const z = gz(b); return { name, bytes: z.length, text: b7(z) }; });
const assets = {
  files: Object.fromEntries(blobs.map((b) => [b.name, b.bytes])),   // gzipped size of each (the page reads <script id="single-NAME">)
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
// The page's script, gzipped like the files (0.85 MB as text, 0.3 MB so), behind a loader that inflates and imports it (a
// module from a blob: URL, which a page opened from a file may import). The decoder is single.ts's b7(), written small.
const LOADER = `const S=[0,13,60],e=document.getElementById("single-page"),t=e.textContent,n=+e.dataset.bytes,o=new Uint8Array(n);
let a=0,b=0,k=0;const p=g=>{a=a<<7|g;b+=7;if(b>=8){b-=8;if(k<n)o[k++]=a>>b&255;a&=(1<<b)-1}};
for(let i=0;i<t.length;i++){const c=t.charCodeAt(i);if(c<128)p(c);else{const v=c-256,s=v>>7;if(s<3){p(S[s]);p(v&127)}else p(S[v&127])}}
const js=await new Response(new Blob([o]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
await import(URL.createObjectURL(new Blob([js],{type:"text/javascript"})));`;
for (const m of [...html.matchAll(/<script type="module"[^>]*src="([^"]+)"[^>]*><\/script>/g)]) {
  const z = gz(Buffer.from(await file(m[1])));
  blobs.unshift({ name: "page", bytes: z.length, text: b7(z) });
  html = html.replace(m[0], () => `<script type="module">${LOADER}</script>`);
}
html = html.replace(/<link rel="modulepreload"[^>]*>\n?/g, "");
// The embedded files, at the end of <body> (the module script runs after the document is parsed).
const data = blobs.map((b) => `<script type="application/x-nanite-b7" id="single-${b.name}" data-bytes="${b.bytes}">${b.text}</script>`).join("\n");
html = html.replace("</body>", () => `${data}\n</body>`);
const left = [...html.matchAll(/(?:src|href)="(?!data:|https?:|#)([^"]+)"/g)].map((m) => m[1]);
if (left.length) throw new Error(`not inlined: ${left.join(", ")}`);
const target = join(out, "nanite-webshell.html");
await writeFile(target, html);
// Beside the normal build's page too (its menu's Offline HTML link): server.mjs serves dist/, build-cf.mjs puts it in cf-dist/.
if (existsSync(join(here, "dist", "index.html"))) await writeFile(join(here, "dist", "nanite-webshell.html"), html);
await rm(build, { recursive: true, force: true });
console.log(`${target}: ${(Buffer.byteLength(html) / 1e6).toFixed(1)} MB (${assets.rootName}, ${(assets.rootBytes / 1e6).toFixed(1)} MB unpacked)`);
