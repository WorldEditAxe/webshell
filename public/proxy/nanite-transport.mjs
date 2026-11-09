// The Preview tabs' network, as a bare-mux transport (it runs in bare-mux's SharedWorker; Scramjet's service worker fetches
// through it). Two ways out:
//   localhost, 127.0.0.1, 0.0.0.0, 10.0.2.15   the machine: over `port` (a MessagePort) to the webshell page, which makes the
//                                              request with Nanite's network.fetch to the guest's port (src/lib/preview.ts);
//   anything else                              the web: libcurl.js (curl in WebAssembly, TLS in the browser) over the Wisp
//                                              relay `wisp` (libcurl-transport, copied here by tools/vendor-proxy.mjs).
// Not to the machine: WebSockets (Nanite's fetch is HTTP only).
import LibcurlClient from "./libcurl.mjs";

const VM = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|10\.0\.2\.15|\[::1\])$/i;

export default class NaniteTransport {
  constructor({ wisp, port }) {
    this.ready = false;
    this.web = new LibcurlClient({ wisp });
    this.port = port;
    this.seq = 0;
    this.pending = new Map();
    port.onmessage = ({ data }) => {
      const p = this.pending.get(data.id);
      if (!p) return;
      this.pending.delete(data.id);
      if (data.error) p.reject(new Error(data.error)); else p.resolve(data);
    };
  }
  async init() { await this.web.init(); this.ready = true; }
  meta() { return {}; }

  async request(remote, method, body, headers, signal) {
    if (!VM.test(remote.hostname)) return this.web.request(remote, method, body, headers, signal);
    const bytes = body == null ? null : await new Response(body).arrayBuffer();
    const id = ++this.seq, list = [];
    for (const [k, v] of Object.entries(headers ?? {})) for (const one of [].concat(v)) list.push([k, String(one)]);
    const answer = await new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      signal?.addEventListener("abort", () => { this.pending.delete(id); reject(new DOMException("The operation was aborted.", "AbortError")); });
      this.port.postMessage({ id, port: +(remote.port || (remote.protocol === "https:" ? 443 : 80)), path: remote.pathname + remote.search, method, headers: list, body: bytes },
        bytes ? [bytes] : []);
    });
    const out = {};
    for (const [k, v] of answer.headers) { const key = k.toLowerCase(); out[key] = key in out ? [].concat(out[key], v) : v; }
    return { body: answer.body, headers: out, status: answer.status, statusText: answer.statusText };
  }

  connect(url, protocols, requestHeaders, onopen, onmessage, onclose, onerror) {
    if (!VM.test(url.hostname)) return this.web.connect(url, protocols, requestHeaders, onopen, onmessage, onclose, onerror);
    setTimeout(() => { onerror("WebSockets to the machine are not supported"); onclose(1006, ""); });
    return [() => {}, () => {}];
  }
}
