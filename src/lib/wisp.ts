// Wisp from the page (https://github.com/MercuryWorkshop/wisp-protocol): the Network settings' relay tester and the tunnels (lib/
// tunnels.svelte.ts) open their own connections through the machine's relay, next to Nanite's.
//   packet       type (1) | stream id (u32 LE) | payload
//   CONNECT  1   stream type (1: TCP, 2: UDP) | port (u16 LE) | host
//   DATA     2   bytes                         CONTINUE 3  buffer left (u32 LE): TCP flow control
//   CLOSE    4   reason (1)                    INFO     5  (v2) version (2) | extensions: id (1), length (u32 LE), payload
// Where the relays are: Spark Linux's regional relays, the nearest found by the /closest router (by the browser's IP), or by the
// browser's time zone when the router does not answer.

export const WISP_ROUTER = "https://wisp-anycast.sparkpowered.org/closest";
export const WISP_NODES: Record<string, string> = { mci: "Kansas City", nrt: "Tokyo", fra: "Frankfurt", sin: "Singapore" };
const nodeUrl = (id: string) => `wss://${id}-wisp-node.sparkpowered.org/`;

function nodeByTimeZone(): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  if (/^Asia\/(Tokyo|Seoul|Pyongyang|Shanghai|Chongqing|Harbin|Hong_Kong|Macau|Taipei|Vladivostok|Sakhalin|Magadan|Kamchatka|Ulaanbaatar)/.test(tz)) return "nrt";
  if (/^(Asia|Australia|Indian|Pacific\/(Auckland|Fiji|Guam|Port_Moresby|Noumea|Chatham))/.test(tz) &&
      !/^Asia\/(Dubai|Muscat|Riyadh|Qatar|Bahrain|Kuwait|Baghdad|Tehran|Jerusalem|Tel_Aviv|Beirut|Damascus|Amman|Nicosia|Famagusta|Gaza|Hebron|Aden|Baku|Tbilisi|Yerevan|Istanbul)/.test(tz)) return "sin";
  if (/^(Europe|Africa|Atlantic\/(Azores|Madeira|Canary|Faroe|Reykjavik)|Asia|Arctic)/.test(tz)) return "fra";
  return "mci";
}

export type WispNode = { url: string; name: string; distanceKm?: number; up?: boolean };
export type Located = {
  source: "router" | "timezone"; nodes: WispNode[]; pick: WispNode; error?: string;
  /** What the router saw of this browser: its public IP and where that is. */
  you?: { ip?: string; city?: string; country?: string; latitude?: number; longitude?: number };
};
/** Where the relays are, nearest first, and the one to use: from the Wispr router `router` (default Spark's), or (it did not
 *  answer) by the time zone. */
export async function locate(router: string = WISP_ROUTER): Promise<Located> {
  try {
    const j = await (await fetch(router || WISP_ROUTER, { signal: AbortSignal.timeout(2500) })).json();
    const you = { ip: typeof j?.ip === "string" ? j.ip : undefined, ...(j?.location ?? {}) };
    type Raw = { url?: unknown; up?: boolean; region?: string; name?: string; distance_km?: number };
    const conv = (n: Raw): WispNode | null => typeof n?.url === "string" && n.url.startsWith("wss://")
      ? { url: n.url, name: n.region ?? n.name ?? new URL(n.url).host, distanceKm: n.distance_km, up: n.up } : null;
    const first = j?.proxy ? conv(j.proxy) : null;
    const rest = ((j?.alternatives ?? []) as Raw[]).map(conv).filter((n): n is WispNode => !!n).sort((a, b) => (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9));
    const nodes = [...(first ? [first] : []), ...rest.filter((n) => n.url !== first?.url)];
    // The node nearest this browser's IP; if it is down, the nearest of the others that is up.
    const pick = nodes.find((n) => n.up !== false);
    if (pick) return { source: "router", nodes, pick, you };
    throw new Error("the router listed no relay that is up");
  } catch (e) {
    const id = nodeByTimeZone(), nodes = Object.entries(WISP_NODES).map(([k, name]) => ({ url: nodeUrl(k), name }));
    return { source: "timezone", nodes, pick: nodes.find((n) => n.url === nodeUrl(id))!, error: (e as Error).message };
  }
}

const EXTENSIONS: Record<number, string> = { 0x01: "UDP", 0x02: "password auth", 0x03: "key auth", 0x04: "MOTD", 0x05: "open confirmation", 0xe1: "ICMP ping" };
const CLOSE_REASONS: Record<number, string> = {
  0x02: "closed", 0x03: "network error", 0x41: "invalid stream", 0x42: "unreachable", 0x43: "timed out", 0x44: "refused",
  0x47: "timed out", 0x48: "blocked by the relay", 0x49: "throttled",
};
const enc = new TextEncoder(), dec = new TextDecoder();

export interface WispStream {
  /** Sends bytes (TCP: in order, within the relay's buffer; UDP: one datagram each). */
  send(bytes: Uint8Array): void;
  ondata: (bytes: Uint8Array) => void;
  onclose: (reason: string) => void;
  close(): void;
}

/** One Wisp connection: TCP and UDP streams over one WebSocket. */
export class WispConn {
  ws!: WebSocket;
  version = "1";
  extensions: { id: number; name: string }[] = [];
  motd = "";
  private nextId = 1;
  private initial = 128;   // the relay's TCP buffer (CONTINUE on stream 0)
  private streams = new Map<number, { s: WispStream; buf: number; queue: Uint8Array[]; tcp: boolean }>();
  onclose: () => void = () => {};

  static open(url: string, timeout = 8000): Promise<WispConn> {
    const c = new WispConn();
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, "wisp-v2"); ws.binaryType = "arraybuffer"; c.ws = ws;
      let ready = false, gotContinue = false, gotInfo = false;
      const t = setTimeout(() => { ws.close(); reject(new Error("the relay did not answer")); }, timeout);
      const done = () => { if (!ready && gotContinue) { ready = true; clearTimeout(t); resolve(c); } };
      // A v1 relay sends CONTINUE first; a v2 relay sends INFO (we answer it, announcing UDP), then CONTINUE.
      ws.onmessage = (e) => {
        const b = new Uint8Array(e.data as ArrayBuffer), id = new DataView(b.buffer).getUint32(1, true);
        if (b[0] === 5 && !gotInfo) {
          gotInfo = true; c.version = `${b[5]}.${b[6]}`;
          const dv = new DataView(b.buffer);
          for (let p = 7; p + 5 <= b.length; ) {
            const ext = b[p]!, len = dv.getUint32(p + 1, true), payload = b.subarray(p + 5, p + 5 + len);
            c.extensions.push({ id: ext, name: EXTENSIONS[ext] ?? `0x${ext.toString(16)}` });
            if (ext === 0x04) c.motd = dec.decode(payload);
            p += 5 + len;
          }
          ws.send(packet(5, 0, [2, 0, 0x01, 0, 0, 0, 0]));
          return;
        }
        if (b[0] === 3 && id === 0) { c.initial = new DataView(b.buffer).getUint32(5, true); gotContinue = true; done(); return; }
        c.message(b, id);
      };
      ws.onerror = () => { if (!ready) { clearTimeout(t); reject(new Error("could not connect to the relay")); } };
      ws.onclose = () => {
        if (!ready) { clearTimeout(t); reject(new Error("the relay closed the connection")); return; }
        for (const st of c.streams.values()) st.s.onclose("the relay connection closed");
        c.streams.clear(); c.onclose();
      };
    });
  }

  private message(b: Uint8Array, id: number): void {
    const st = this.streams.get(id);
    if (!st) return;
    if (b[0] === 2) st.s.ondata(b.slice(5));
    else if (b[0] === 3) { st.buf = new DataView(b.buffer).getUint32(5, true); this.flush(id); }
    else if (b[0] === 4) { this.streams.delete(id); st.s.onclose(CLOSE_REASONS[b[5]!] ?? `closed (0x${b[5]!.toString(16)})`); }
  }
  private flush(id: number): void {
    const st = this.streams.get(id);
    while (st && st.queue.length && (!st.tcp || st.buf > 0)) { this.ws.send(packet(2, id, st.queue.shift()!)); if (st.tcp) st.buf--; }
  }

  /** A stream to host:port: "tcp" or "udp" (UDP needs the relay's UDP extension). */
  open(kind: "tcp" | "udp", host: string, port: number): WispStream {
    const id = this.nextId++, conn = this;
    const s: WispStream = {
      ondata: () => {}, onclose: () => {},
      send(bytes) { const st = conn.streams.get(id); if (!st) return; st.queue.push(bytes); conn.flush(id); },
      close() { if (conn.streams.delete(id) && conn.ws.readyState === WebSocket.OPEN) conn.ws.send(packet(4, id, [0x02])); },
    };
    this.streams.set(id, { s, buf: this.initial, queue: [], tcp: kind === "tcp" });
    const h = enc.encode(host), p = new Uint8Array(3 + h.length);
    p[0] = kind === "tcp" ? 1 : 2; new DataView(p.buffer).setUint16(1, port, true); p.set(h, 3);
    this.ws.send(packet(1, id, p));
    return s;
  }
  close(): void { try { this.ws.close(); } catch {} }
}

function packet(type: number, id: number, payload: ArrayLike<number>): Uint8Array {
  const b = new Uint8Array(5 + payload.length);
  b[0] = type; new DataView(b.buffer).setUint32(1, id, true); b.set(payload, 5);
  return b;
}

export type WispTest = {
  url: string; ok: boolean; connectMs?: number; tcpMs?: number; udpMs?: number | null;
  version?: string; extensions?: string[]; motd?: string; error?: string;
};
/** Tests a relay: the WebSocket and Wisp handshake, a TCP stream (HTTP HEAD to example.com), and a UDP stream (a DNS query to
 *  1.1.1.1) when the relay offers UDP. Times in ms. */
export async function testWisp(url: string): Promise<WispTest> {
  const t0 = performance.now();
  let c: WispConn;
  try { c = await WispConn.open(url, 6000); } catch (e) { return { url, ok: false, error: (e as Error).message }; }
  const r: WispTest = { url, ok: false, connectMs: Math.round(performance.now() - t0), version: c.version, extensions: c.extensions.map((x) => x.name), motd: c.motd || undefined };
  const timed = <T,>(ms: number, p: Promise<T>) => Promise.race([p, new Promise<never>((_, j) => setTimeout(() => j(new Error("timed out")), ms))]);
  try {
    const t1 = performance.now();
    await timed(6000, new Promise<void>((resolve, reject) => {
      const s = c.open("tcp", "example.com", 80);
      let got = "";
      s.ondata = (b) => { got += dec.decode(b); if (got.includes("HTTP/")) { resolve(); s.close(); } };
      s.onclose = (why) => reject(new Error(`TCP: ${why}`));
      s.send(enc.encode("HEAD / HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n"));
    }));
    r.tcpMs = Math.round(performance.now() - t1);
    r.udpMs = null;
    if (c.extensions.some((x) => x.id === 0x01)) {
      const t2 = performance.now();
      await timed(4000, new Promise<void>((resolve, reject) => {
        const s = c.open("udp", "1.1.1.1", 53);
        s.ondata = () => { resolve(); s.close(); };
        s.onclose = (why) => reject(new Error(`UDP: ${why}`));
        // A DNS query: id 0x1234, recursion desired, one question: example.com A IN.
        s.send(new Uint8Array([0x12, 0x34, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 7, ...enc.encode("example"), 3, ...enc.encode("com"), 0, 0, 1, 0, 1]));
      }));
      r.udpMs = Math.round(performance.now() - t2);
    }
    r.ok = true;
  } catch (e) { r.error = (e as Error).message; }
  c.close();
  return r;
}
