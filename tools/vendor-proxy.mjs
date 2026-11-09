#!/usr/bin/env node
// tools/vendor-proxy.mjs: copies the Preview tabs' web proxy from node_modules into public/proxy/ (run by npm run build):
// Scramjet (its client bundle, sync helper and rewriter), bare-mux's SharedWorker and the libcurl transport, which
// public/proxy/nanite-transport.mjs (ours, kept in git) builds on.
import { copyFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
const here = join(dirname(new URL(import.meta.url).pathname), ".."), out = join(here, "public", "proxy"), nm = join(here, "node_modules", "@mercuryworkshop");
mkdirSync(out, { recursive: true });
for (const [from, to] of [
  ["scramjet/dist/scramjet.all.js", "scramjet.all.js"],
  ["scramjet/dist/scramjet.sync.js", "scramjet.sync.js"],
  ["scramjet/dist/scramjet.wasm.wasm", "scramjet.wasm.wasm"],
  ["bare-mux/dist/worker.js", "baremux.js"],
  ["libcurl-transport/dist/index.mjs", "libcurl.mjs"],
]) copyFileSync(join(nm, from), join(out, to));
console.log("public/proxy: Scramjet, bare-mux and the libcurl transport copied");
