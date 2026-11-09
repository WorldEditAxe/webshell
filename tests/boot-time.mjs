// node tests/boot-time.mjs <url>: loads the page twice in one headless Chromium profile (cold, then warm: HTTP cache and
// Nanite's OPFS translation cache filled) and prints window.bootTimes for each.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const [url] = process.argv.slice(2);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sakura-boot-"));
const chrome = spawn(`${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`, ["--headless=new", "--remote-debugging-port=9349", `--user-data-dir=${dir}`, "--no-first-run", "--no-sandbox", "--window-size=1280,800", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let tabs; for (let i = 0; i < 150; i++) { try { tabs = await (await fetch("http://127.0.0.1:9349/json")).json(); break; } catch { await sleep(200); } }
const ws = new WebSocket(tabs.find((t) => t.type === "page").webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map(); ws.onmessage = (e) => { const m = JSON.parse(e.data); pending.get(m.id)?.(m); };
const cmd = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (x) => (await cmd("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true })).result?.result?.value;
for (const run of ["cold", "warm"]) {
  await cmd("Page.navigate", { url });
  let t = null;
  for (let i = 0; i < 240; i++) { await sleep(500); t = await ev("window.bootTimes && window.bootTimes.prompt ? window.bootTimes : null"); if (t) break; }
  t ??= await ev("window.bootTimes");
  const order = Object.entries(t ?? {}).sort((a, b) => a[1] - b[1]);
  let prev = 0;
  console.log(`${run}: ` + order.map(([k, v]) => { const s = `${k} ${v} (+${v - prev})`; prev = v; return s; }).join(" | "));
  await sleep(3000);
}
ws.close(); chrome.kill(); await sleep(500); try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
process.exit(0);
