// node tests/eval.mjs <url> <js expression>: evaluate in headless Chromium and print the JSON result.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const [url, expr] = process.argv.slice(2);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sakura-eval-"));
const chrome = spawn(process.env.CHROME ?? `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`, ["--headless=new", "--remote-debugging-port=9348", `--user-data-dir=${dir}`, "--no-first-run", "--no-sandbox", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let tabs; for (let i = 0; i < 150; i++) { try { tabs = await (await fetch("http://127.0.0.1:9348/json")).json(); break; } catch { await sleep(200); } }
const ws = new WebSocket(tabs.find((t) => t.type === "page").webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map(); ws.onmessage = (e) => { const m = JSON.parse(e.data); pending.get(m.id)?.(m); };
const cmd = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await cmd("Page.enable"); await cmd("Page.navigate", { url }); await sleep(+(process.env.WAIT ?? 1500));
const r = await cmd("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
console.log(JSON.stringify(r.result?.result?.value ?? r.result));
ws.close(); chrome.kill(); await sleep(500); try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
process.exit(0);
