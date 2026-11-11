// playit.gg tunnels (TCP and UDP), with this page as the agent: nothing runs in the machine. Implemented from playit-agent 1.2.0
// (https://github.com/playit-cloud/playit-agent); the protocol notes are below, the field layouts at each encoder / decoder.
//   API        POST https://api.playit.gg<path>, JSON, "Authorization: Agent-Key <secret>"; replies {status, data}. The API refuses
//              browsers (no CORS), so it goes through libcurl.js (curl in WebAssembly, TLS here) over the Wisp relay.
//   claim      a code (hex of 5 random bytes): the user approves https://playit.gg/claim/<code>; /claim/setup is polled until
//              "UserAccepted", then /claim/exchange gives the secret key (kept in localStorage).
//   control    UDP to a control server (from /agents/routing/get) port 5525, one big-endian message a datagram, over a Wisp UDP
//              stream. Ping -> Pong tells our public address (the relay's), /proto/register turns it into signed bytes that
//              register the session; then a Ping every second, a KeepAlive every minute, re-register when Pongs stop (6 s),
//              the session is refused, or our public address changed.
//   TCP        NewClient (a visitor): connect to its claim address, send the token, read 8 bytes; then the stream is the visitor's.
//   UDP        SetupUdpChannel -> UdpChannelDetails (address, token); the token sent there opens the channel (re-sent every 10 s).
//              Datagrams carry a footer (visitor and public addresses, tunnel id) at their end; replies carry the flipped footer.
//   tunnels    made on playit.gg (TCP / UDP / both, local port, PROXY protocol); the page reads them from /v1/agents/rundata.
import { WispConn, type WispStream } from "./wisp";
import { joinGuest, proxyHeader, type Addr, type Net } from "./tunnels.svelte";
import type { UdpSocket } from "./machine";

const API = "https://api.playit.gg";
const SECRET_KEY = "nanite-webshell:playit-secret";
const VERSION = { variant_id: "308943e8-faef-4835-a2ba-270351f72aa3", version_major: 1, version_minor: 2, version_patch: 0 };
const GUEST = "10.0.2.15";
const UDP_ESTABLISH = 0xd01fe6830ddce781n, FOOTER_V4 = 0x5cb867cf78817399n, FOOTER_V6 = 0x6cb667cf78817369n;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type PlayitTunnel = {
  internalId: number; name: string; address: string; proto: "tcp" | "udp" | "both";
  localIp: string; localPort: number; portCount: number; proxy: "" | "v1" | "v2"; disabled: string | null; type: string | null;
};

// ---- binary encoding (big-endian) ----
class W {
  b: number[] = [];
  u8(v: number) { this.b.push(v & 255); return this; }
  u16(v: number) { this.b.push((v >> 8) & 255, v & 255); return this; }
  u32(v: number) { for (let i = 3; i >= 0; i--) this.b.push((v >>> (i * 8)) & 255); return this; }
  u64(v: bigint) { for (let i = 7n; i >= 0n; i--) this.b.push(Number((v >> (i * 8n)) & 255n)); return this; }
  raw(x: ArrayLike<number>) { for (let i = 0; i < x.length; i++) this.b.push(x[i]!); return this; }
  out() { return new Uint8Array(this.b); }
}
class R {
  p = 0;
  constructor(public d: Uint8Array) {}
  u8() { return this.d[this.p++]!; }
  u16() { const v = (this.d[this.p]! << 8) | this.d[this.p + 1]!; this.p += 2; return v; }
  u32() { const v = new DataView(this.d.buffer, this.d.byteOffset + this.p, 4).getUint32(0); this.p += 4; return v; }
  u64() { const v = new DataView(this.d.buffer, this.d.byteOffset + this.p, 8).getBigUint64(0); this.p += 8; return v; }
  bytes(n: number) { const v = this.d.slice(this.p, this.p + n); this.p += n; return v; }
  /** SocketAddr: tag 4 + 4 bytes or tag 6 + 16 bytes, then u16 port. */
  addr(): Addr { const t = this.u8(); const ip = this.bytes(t === 6 ? 16 : 4); return { address: t === 6 ? v6str(ip) : [...ip].join("."), port: this.u16() }; }
  /** Vec<u8>: u64 length + bytes. */
  vec() { return this.bytes(Number(this.u64())); }
  opt<T>(f: () => T): T | null { return this.u8() ? f() : null; }
}
function v6str(b: Uint8Array): string {
  const g = [...Array(8)].map((_, i) => ((b[i * 2]! << 8) | b[i * 2 + 1]!).toString(16));
  return g.join(":").replace(/(^|:)0(:0)+(:|$)/, "::").replace(/:{3,}/, "::");
}
function v6bytes(a: string): number[] {
  const [h, t = ""] = a.split("::"), hs = h ? h.split(":") : [], ts = t ? t.split(":") : [];
  return [...hs, ...Array(8 - hs.length - ts.length).fill("0"), ...ts].flatMap((x) => { const n = parseInt(x || "0", 16); return [n >> 8, n & 255]; });
}
const addrStr = (a: Addr) => (a.address.includes(":") ? `[${a.address}]:${a.port}` : `${a.address}:${a.port}`);
const sameAddr = (a: Addr, b: Addr) => a.address === b.address && a.port === b.port;

type Pong = { requestNow: bigint; serverNow: bigint; client: Addr; tunnel: Addr; expireAt: bigint | null };
type Feed =
  | { kind: "response"; rid: bigint; id: number; r: R }
  | { kind: "client"; connect: Addr; peer: Addr; tunnelId: bigint; portOffset: number; claim: Addr; token: Uint8Array };
function parseFeed(d: Uint8Array): Feed | null {
  try {
    const r = new R(d), t = r.u32();
    if (t === 1) return { kind: "response", rid: r.u64(), id: r.u32(), r };
    if (t === 3) {
      const connect = r.addr(), peer = r.addr(); r.u32(); const tunnelId = r.u64(), portOffset = r.u16();
      const claim = r.addr(), token = r.vec();
      return { kind: "client", connect, peer, tunnelId, portOffset, claim, token };
    }
  } catch {}
  return null;
}
const parsePong = (r: R): Pong => {
  const requestNow = r.u64(), serverNow = r.u64(); r.u64(); r.u32();
  const client = r.addr(), tunnel = r.addr();
  return { requestNow, serverNow, client, tunnel, expireAt: r.opt(() => r.u64()) };
};

// ---- the HTTP API, through libcurl.js over Wisp ----
type Curl = { init(): Promise<void>; request(u: URL, m: string, body: string, h: Record<string, string>, s?: AbortSignal): Promise<{ body: BodyInit; status: number }> };
let curl: Promise<Curl> | null = null, curlRelay = "";
function curlFor(relay: string): Promise<Curl> {
  if (curl && curlRelay === relay) return curl;
  curlRelay = relay;
  return (curl = (async () => {
    const mod = await import(/* @vite-ignore */ new URL("proxy/libcurl.mjs", document.baseURI).href) as { default: new (o: { wisp: string }) => Curl };
    const c = new mod.default({ wisp: relay.endsWith("/") ? relay : relay + "/" });
    await c.init();
    return c;
  })().catch((e) => { curl = null; throw e; }));
}
class ApiError extends Error { constructor(public kind: string, public data: unknown) { super(typeof data === "string" ? data : JSON.stringify(data)); } }

export class Playit {
  status = $state<"off" | "claiming" | "connecting" | "up" | "retrying">("off");
  error = $state("");
  claimUrl = $state("");
  tunnels = $state<PlayitTunnel[]>([]);
  agentId = $state("");
  /** Visitors connected now (TCP + UDP flows) and since the start. */
  open = $state(0);
  total = $state(0);
  get hasSecret(): boolean { return !!this.secret; }
  private secret = (() => { try { return localStorage.getItem(SECRET_KEY) ?? ""; } catch { return ""; } })();
  private run = 0;   // the current session's number: a stop or restart ends the older loops
  private visitors = new Set<() => void>();
  private stopHooks: (() => void)[] = [];

  constructor(private wisp: () => Promise<WispConn>, private relay: () => string | null, private net: () => Net | null, private udp: () => ((port?: number) => UdpSocket) | null) {}

  private async api<T>(path: string, body: unknown, auth = true): Promise<T> {
    const relay = this.relay();
    if (!relay) throw new Error("the machine has no Wisp relay yet");
    const c = await curlFor(relay);
    const h: Record<string, string> = { "content-type": "application/json" };
    if (auth && this.secret) h.authorization = `Agent-Key ${this.secret.trim()}`;
    const res = await c.request(new URL(API + path), "POST", JSON.stringify(body), h);
    const text = await new Response(res.body).text();
    if (res.status === 429) throw new ApiError("error", "playit.gg: too many requests");
    let j: { status?: string; data?: unknown };
    try { j = JSON.parse(text); } catch { throw new ApiError("error", `playit.gg answered HTTP ${res.status}`); }
    if (j.status === "success") return j.data as T;
    const d = j.data as { type?: string; message?: unknown } | string;
    throw new ApiError(j.status ?? "error", typeof d === "object" && d && "message" in d ? d.message : d);
  }

  /** Connects (claiming an agent first when there is no secret yet). */
  async start(): Promise<void> {
    const my = ++this.run;
    this.stopAll(); this.error = "";
    try {
      if (!this.secret) await this.claim(my);
      if (my !== this.run) return;
      await this.session(my);
    } catch (e) {
      if (my !== this.run) return;
      const msg = e instanceof ApiError ? String(e.message) : (e as Error).message;
      this.error = msg;
      if (/InvalidAgentKey|NoLongerValid/.test(msg)) { this.forget(); this.error = "playit.gg no longer knows this agent: connect again to claim a new one"; return; }
      this.status = "retrying";
      await sleep(5000);
      if (my === this.run) void this.start();
    }
  }
  stop(): void { this.run++; this.stopAll(); this.status = "off"; this.claimUrl = ""; }
  /** Stops and forgets the agent's secret (the next start claims a new agent). */
  forget(): void { this.stop(); this.secret = ""; this.tunnels = []; this.agentId = ""; try { localStorage.removeItem(SECRET_KEY); } catch {} }
  private stopAll(): void {
    for (const f of this.stopHooks.splice(0)) try { f(); } catch {}
    for (const v of [...this.visitors]) v();
    this.visitors.clear(); this.open = 0;
  }

  private async claim(my: number): Promise<void> {
    this.status = "claiming";
    const code = [...crypto.getRandomValues(new Uint8Array(5))].map((b) => b.toString(16).padStart(2, "0")).join("");
    this.claimUrl = `https://playit.gg/claim/${code}`;
    for (;;) {
      if (my !== this.run) return;
      try {
        const s = await this.api<string>("/claim/setup", { code, agent_type: "self-managed", version: "nanite-webshell (playit 1.2.0)" }, false);
        if (s === "UserAccepted") break;
        if (s === "UserRejected") throw new Error("the claim was rejected on playit.gg");
        await sleep(1000);
      } catch (e) {
        if (!(e instanceof ApiError) || /CodeExpired|InvalidCode/.test(e.message)) throw e;
        this.error = `playit.gg: ${e.message} (retrying)`; await sleep(2000);
      }
    }
    for (;;) {
      if (my !== this.run) return;
      try {
        const r = await this.api<{ secret_key: string }>("/claim/exchange", { code }, false);
        this.secret = r.secret_key.trim();
        try { localStorage.setItem(SECRET_KEY, this.secret); } catch {}
        this.claimUrl = "";
        return;
      } catch (e) { if (e instanceof ApiError && e.kind === "fail" && !/UserRejected|CodeExpired/.test(e.message)) { await sleep(2000); continue; } throw e; }
    }
  }

  /** One control session: connect, register, then run until stopped (an error ends it; start() retries). */
  private async session(my: number): Promise<void> {
    this.status = "connecting";
    await this.refreshTunnels();
    const routing = await this.api<{ agent_id: string; targets4: string[]; targets6: string[] }>("/agents/routing/get", { agent_id: null });
    this.agentId = routing.agent_id;
    const w = await this.wisp();
    // IPv4 first: a relay without IPv6 would lose seconds on each IPv6 address.
    const targets = [...routing.targets4, ...routing.targets6];
    let ctl: WispStream | null = null, pong: Pong | null = null, target = "";
    const inbox: Feed[] = [];
    let wake: (() => void) | null = null;
    const next = (ms: number) => new Promise<Feed | null>((res) => {
      const t = setTimeout(() => { wake = null; res(null); }, ms);
      wake = () => { clearTimeout(t); wake = null; res(inbox.shift() ?? null); };
      if (inbox.length) wake();
    });
    for (const ip of targets) {
      const s = w.open("udp", ip, 5525);
      s.ondata = (d) => { const f = parseFeed(d); if (f) { inbox.push(f); wake?.(); } };
      for (let a = 0; a < 3 && !pong; a++) {
        s.send(new W().u64(1n).u32(6).u64(BigInt(Date.now())).u8(0).u8(0).out());
        for (let i = 0; i < 4 && !pong; i++) {
          const f = await next(500);
          if (f?.kind === "response" && f.rid === 1n && f.id === 1) pong = parsePong(f.r);
        }
      }
      if (pong) { ctl = s; target = ip; break; }
      s.close();
    }
    if (!ctl || !pong) throw new Error("no playit.gg control server answered (the relay must allow UDP)");
    this.stopHooks.push(() => ctl!.close());
    const c = ctl;
    const send = (b: Uint8Array) => c.send(b);

    // Registration: /proto/register signs our addresses; the bytes go out after a request id.
    let session: Uint8Array | null = null, expiresAt = 0n, authPong = pong, lastPong = Date.now(), rtt: number | null = null, expired = false;
    const register = async (p: Pong) => {
      const key = await this.api<{ key: string }>("/proto/register", {
        agent_version: null, proto_version: 2, version: VERSION, platform: "linux", client_addr: addrStr(p.client), tunnel_addr: addrStr(p.tunnel),
      });
      const bytes = Uint8Array.from(key.key.match(/../g)!.map((h) => parseInt(h, 16))), rid = BigInt(Date.now());
      for (let a = 0; a < 5; a++) {
        send(new W().u64(rid).raw(bytes).out());
        for (let i = 0; i < 5; i++) {
          const f = await next(500);
          if (f?.kind !== "response" || f.rid !== rid) { if (f) handle(f); continue; }
          if (f.id === 6) { session = f.r.bytes(24); expiresAt = f.r.u64(); authPong = p; expired = false; return; }
          if (f.id === 2) throw new Error("playit.gg: invalid signature");
          if (f.id === 3) throw new Error("playit.gg refused the registration (the relay's address changed?)");
          if (f.id === 4) { await sleep(1000); break; }
        }
      }
      throw new Error("playit.gg did not confirm the registration");
    };

    // UDP channel state.
    let chanAddr = null as Addr | null, chanToken = null as Uint8Array | null, chan = null as WispStream | null, chanAck = 0, chanSent = 0, setupAsked = 0;
    const flows = new Map<string, { sock: UdpSocket; reply: Uint8Array; last: number; close: () => void }>();
    const wantsUdp = () => this.tunnels.some((t) => t.proto !== "tcp" && !t.disabled);
    const openChannel = (addr: Addr, token: Uint8Array) => {
      const changed = !chanAddr || !sameAddr(chanAddr, addr);
      chanAddr = addr; chanToken = token;
      if (changed) {
        chan?.close();
        chan = w.open("udp", addr.address, addr.port);
        chan.ondata = (d) => this.udpIn(d, chan!, flows, () => { chanAck = Date.now(); });
        this.stopHooks.push(() => chan?.close());
      }
      if (changed || Date.now() - chanAck > 5000) { chan!.send(token); chanSent = Date.now(); }
    };

    const handle = (f: Feed) => {
      if (f.kind === "client") { void this.tcpIn(f, w); return; }
      if (f.id === 1) {
        const p = parsePong(f.r), now = Date.now();
        lastPong = now; rtt = Math.max(0, now - Number(p.requestNow));
        pong = p;
        if (p.expireAt != null) expiresAt = BigInt(Number(p.requestNow) + Math.max(Number(p.expireAt - p.serverNow), rtt) - rtt);
        if (!sameAddr(p.client, authPong.client) || !sameAddr(p.tunnel, authPong.tunnel)) expired = true;
        if (authPong.expireAt == null && p.expireAt != null) authPong = p;   // the first Pong of the session
      } else if (f.id === 3) expired = true;
      else if (f.id === 6) { session = f.r.bytes(24); expiresAt = f.r.u64(); }
      else if (f.id === 8) { const addr = f.r.addr(), token = f.r.vec(); openChannel(addr, token); }
    };

    await register(pong);
    if (my !== this.run) return;
    this.status = "up"; this.error = "";
    console.info(`playit.gg: registered through ${target}:5525 as ${addrStr(authPong.client)}`);

    let lastPing = 0, lastKeep = 0, lastRundata = Date.now();
    while (my === this.run) {
      const now = Date.now();
      if (expired) {
        this.status = "connecting";
        await register(pong);
        if (my !== this.run) return;
        this.status = "up";
      }
      if (now - lastPing > 1000) {
        lastPing = now;
        const m = new W().u64(200n).u32(6).u64(BigInt(now));
        if (rtt == null) m.u8(0); else m.u8(1).u32(rtt);
        if (session) m.u8(1).raw(session); else m.u8(0);
        send(m.out());
      }
      const keepEvery = Number(expiresAt) - now < 30000 ? 10000 : 60000;
      if (session && now - lastKeep > keepEvery) { lastKeep = now; send(new W().u64(100n).u32(3).raw(session).out()); }
      if (session && wantsUdp() && now - chanAck > 6000 && now - setupAsked > 5000) { setupAsked = now; send(new W().u64(1n).u32(4).raw(session).out()); }
      if (chan && chanToken && now - chanSent > (now - chanAck > 15000 ? 3000 : 10000)) { chan.send(chanToken); chanSent = now; }
      if (now - lastRundata > 5000) { lastRundata = now; void this.refreshTunnels().catch(() => {}); }
      for (const [k, fl] of flows) if (now - fl.last > 90000) { fl.close(); flows.delete(k); }
      if (now - lastPong > 6000) { expired = true; lastPong = now; }
      const f = await next(250);
      if (f) handle(f);
    }
  }

  /** The tunnels made on playit.gg for this agent. */
  async refreshTunnels(): Promise<void> {
    type T = { internal_id: number; name: string; display_address: string; port_type: "tcp" | "udp" | "both"; port_count: number; tunnel_type: string | null;
      agent_config?: { fields?: { name: string; value: string }[] }; disabled_reason: string | null };
    const d = await this.api<{ agent_id: string; tunnels: T[] }>("/v1/agents/rundata", {});
    this.agentId = d.agent_id;
    this.tunnels = d.tunnels.map((t) => {
      const f = (n: string) => t.agent_config?.fields?.find((x) => x.name === n)?.value?.trim() ?? "";
      const pp = f("proxy_protocol");
      const localPort = +(f("local_port") || t.display_address.split(":").pop() || 0);
      return { internalId: t.internal_id, name: t.name, address: t.display_address, proto: t.tunnel_type === "nethernet" ? "udp" : t.port_type,
        localIp: f("local_ip") || "127.0.0.1", localPort, portCount: t.port_count, proxy: pp === "proxy-protocol-v1" ? "v1" : pp === "proxy-protocol-v2" ? "v2" : "",
        disabled: t.disabled_reason, type: t.tunnel_type };
    });
  }
  private tunnelFor(id: bigint, tcp: boolean): PlayitTunnel | null {
    return this.tunnels.find((t) => BigInt(t.internalId) === id && (t.proto === "both" || t.proto === (tcp ? "tcp" : "udp"))) ?? null;
  }
  private localPort(t: PlayitTunnel, offset: number): number { return t.portCount === 0 ? t.localPort : t.localPort + offset; }
  private guestAddress(t: PlayitTunnel): string | undefined { return /^127\./.test(t.localIp) ? "127.0.0.1" : t.localIp === GUEST ? undefined : t.localIp; }

  /** A TCP visitor: claim it at its claim address (token, then 8 bytes back), then join it to the guest's port. */
  private async tcpIn(f: Extract<Feed, { kind: "client" }>, w: WispConn): Promise<void> {
    const t = this.tunnelFor(f.tunnelId, true), net = this.net();
    if (!t || !net) return;
    const remote = w.open("tcp", f.claim.address, f.claim.port), early: Uint8Array[] = [];
    let gone = false, got = 0;
    const ready = new Promise<void>((res, rej) => {
      const to = setTimeout(() => rej(new Error("timed out")), 8000);
      remote.ondata = (b) => {
        if (got >= 8) { early.push(b); return; }
        const need = 8 - got; got += Math.min(need, b.length);
        if (b.length > need) early.push(b.slice(need));
        if (got >= 8) { clearTimeout(to); res(); }
      };
      remote.onclose = (why) => { gone = true; clearTimeout(to); rej(new Error(why)); };
    });
    remote.send(f.token);
    try { await ready; } catch { remote.close(); return; }
    await joinGuest({ net, port: this.localPort(t, f.portOffset), guestAddress: this.guestAddress(t), remote, early, gone: () => gone, visitors: this.visitors, counters: this,
      header: t.proxy ? proxyHeader(t.proxy, { src: f.peer, dst: f.connect }) : null, onError: (m) => { this.error = m; } });
  }

  /** A datagram on the UDP channel: the channel's ack, or a visitor's datagram (payload + footer) for the guest. */
  private udpIn(d: Uint8Array, chan: WispStream, flows: Map<string, { sock: UdpSocket; reply: Uint8Array; last: number; close: () => void }>, ack: () => void): void {
    if (d.length < 8) return;
    const dv = new DataView(d.buffer, d.byteOffset, d.length), id = dv.getBigUint64(d.length - 8);
    if (id === UDP_ESTABLISH) { ack(); return; }
    let src: Addr, dst: Addr, serverId: bigint, tunnelId: bigint, offset: number, footer: number;
    if (id === FOOTER_V4) {
      if (d.length < 40) return;
      footer = dv.getUint16(d.length - 10) === 0 ? 40 : 43;
      if (d.length < footer) return;
      const r = new R(d.subarray(d.length - footer));
      const sip = r.bytes(4), dip = r.bytes(4), sport = r.u16(), dport = r.u16();
      serverId = r.u64(); tunnelId = r.u64(); offset = r.u16();
      src = { address: [...sip].join("."), port: sport }; dst = { address: [...dip].join("."), port: dport };
    } else if (id === FOOTER_V6) {
      footer = 62;
      if (d.length < footer) return;
      const r = new R(d.subarray(d.length - footer));
      const sip = r.bytes(16), dip = r.bytes(16), sport = r.u16(), dport = r.u16();
      serverId = r.u64(); tunnelId = r.u64(); offset = r.u16();
      src = { address: v6str(sip), port: sport }; dst = { address: v6str(dip), port: dport };
    } else return;
    const payload = d.slice(0, d.length - footer);
    const t = this.tunnelFor(tunnelId, false), mk = this.udp();
    if (!t || !mk) return;
    const key = `${addrStr(src)}|${addrStr(dst)}|${tunnelId}`, port = this.localPort(t, offset);
    // The reply footer: the flow flipped (from the public address to the visitor), with the server id of the latest datagram.
    const replyFooter = () => {
      const six = src.address.includes(":"), m = new W();
      if (six) m.raw(v6bytes(dst.address)).raw(v6bytes(src.address)); else m.raw(dst.address.split(".").map(Number)).raw(src.address.split(".").map(Number));
      m.u16(dst.port).u16(src.port).u64(serverId).u64(tunnelId).u16(offset);
      if (!six) m.u16(0);
      return m.u64(six ? FOOTER_V6 : FOOTER_V4).out();
    };
    let fl = flows.get(key);
    if (!fl) {
      const sock = mk(0), entry = { sock, reply: replyFooter(), last: Date.now(), close: () => { try { sock.close(); } catch {} this.open = Math.max(0, this.open - 1); } };
      sock.on("message", (bytes, from) => {
        if (from.port !== port) return;
        entry.last = Date.now();
        const out = new Uint8Array(bytes.length + entry.reply.length); out.set(bytes); out.set(entry.reply, bytes.length);
        chan.send(out);
      });
      flows.set(key, entry); fl = entry; this.open++; this.total++;
      if (t.proxy === "v2") void sock.send(proxyHeader("v2", { src, dst }, true), port, this.guestUdp(t));
    } else fl.reply = replyFooter();
    fl.last = Date.now();
    void fl.sock.send(payload, port, this.guestUdp(t));
  }
  private guestUdp(t: PlayitTunnel): string { return /^127\./.test(t.localIp) ? GUEST : t.localIp; }
}
