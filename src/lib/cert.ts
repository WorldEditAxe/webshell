// The certificate a web site presents, for the Preview tab's certificate viewer. libcurl.js (which fetches the pages) does not
// expose it, so it is read here, the same way out: a TCP stream over the Wisp relay, a TLS 1.2 ClientHello, and the server's
// Certificate message, which TLS 1.2 still sends in the clear (TLS 1.3 encrypts it; a server that only speaks 1.3 answers with an
// alert, and the viewer says so). Nothing is sent after the certificate arrives: the stream is closed.
// The X.509 parsing is minimal DER: subject, issuer, validity, names, keys, extensions; fingerprints come from WebCrypto.

export type Cert = {
  subject: [string, string][]; issuer: [string, string][]; serial: string; version: number;
  notBefore: Date; notAfter: Date; sigAlg: string; keyAlg: string; keySize: string;
  san: string[]; ca: boolean | null; keyUsage: string[]; extKeyUsage: string[];
  sha256: string; sha1: string; der: Uint8Array;
};
export type CertResult = { chain: Cert[]; tls: string; cipher: string };

const enc = new TextEncoder();

// ---- Wisp: one TCP stream ---------------------------------------------------------------------------------------------------
function wispStream(url: string, host: string, port: number, onData: (b: Uint8Array) => void, onClose: (why: string) => void) {
  const ws = new WebSocket(url, "wisp-v2"); ws.binaryType = "arraybuffer";
  const ID = 1;
  const packet = (type: number, id: number, payload: ArrayLike<number>) => {
    const b = new Uint8Array(5 + payload.length); b[0] = type; new DataView(b.buffer).setUint32(1, id, true); b.set(payload, 5); return b;
  };
  let open = false, queue: Uint8Array[] = [];
  const start = () => {
    if (open) return; open = true;
    ws.send(packet(1, ID, [1, port & 255, port >> 8, ...enc.encode(host)]));   // CONNECT, TCP
    for (const q of queue) ws.send(packet(2, ID, q)); queue = [];
  };
  ws.onmessage = (e) => {
    const b = new Uint8Array(e.data as ArrayBuffer), id = new DataView(b.buffer).getUint32(1, true);
    if (b[0] === 5) { ws.send(packet(5, 0, [2, 0])); start(); }           // Wisp v2 INFO: answer with version 2, no extensions
    else if (b[0] === 3 && id === 0) start();                             // v1: the first CONTINUE
    else if (b[0] === 2 && id === ID) onData(b.subarray(5));
    else if (b[0] === 4 && id === ID) onClose(b[5] === 0x42 ? "the site's address could not be found" : b[5] === 0x44 ? "the site refused the connection" : "the connection was closed");
  };
  ws.onerror = () => onClose("the network (Wisp) could not be reached");
  ws.onclose = () => onClose("the connection was closed");
  return {
    send(b: Uint8Array) { if (open) ws.send(packet(2, ID, b)); else queue.push(b); },
    close() { try { if (open) ws.send(packet(4, ID, [2])); ws.close(); } catch {} },
  };
}

// ---- TLS 1.2: ClientHello, then read up to the Certificate message -------------------------------------------------------------
const CIPHERS: Record<number, string> = {
  0xc02b: "ECDHE-ECDSA-AES128-GCM-SHA256", 0xc02f: "ECDHE-RSA-AES128-GCM-SHA256", 0xc02c: "ECDHE-ECDSA-AES256-GCM-SHA384",
  0xc030: "ECDHE-RSA-AES256-GCM-SHA384", 0xcca9: "ECDHE-ECDSA-CHACHA20-POLY1305", 0xcca8: "ECDHE-RSA-CHACHA20-POLY1305",
  0xc009: "ECDHE-ECDSA-AES128-SHA", 0xc013: "ECDHE-RSA-AES128-SHA", 0xc00a: "ECDHE-ECDSA-AES256-SHA", 0xc014: "ECDHE-RSA-AES256-SHA",
  0x009c: "AES128-GCM-SHA256", 0x009d: "AES256-GCM-SHA384", 0x002f: "AES128-SHA", 0x0035: "AES256-SHA",
};
const u16 = (n: number) => [n >> 8 & 255, n & 255], u24 = (n: number) => [n >> 16 & 255, n >> 8 & 255, n & 255];
function clientHello(host: string): Uint8Array {
  const name = [...enc.encode(host)];
  const ext = (type: number, data: number[]) => [...u16(type), ...u16(data.length), ...data];
  const exts = [
    ...ext(0, [...u16(name.length + 3), 0, ...u16(name.length), ...name]),                       // server_name
    ...ext(10, [...u16(6), 0, 29, 0, 23, 0, 24]),                                                 // supported_groups: x25519, P-256, P-384
    ...ext(11, [1, 0]),                                                                           // ec_point_formats: uncompressed
    ...ext(13, [...u16(16), 4, 3, 5, 3, 6, 3, 8, 4, 8, 5, 8, 6, 4, 1, 5, 1]),                     // signature_algorithms
    ...ext(0xff01, [0]),                                                                          // renegotiation_info
    ...ext(23, []),                                                                               // extended_master_secret
  ];
  const suites = Object.keys(CIPHERS).flatMap((c) => u16(+c));
  const random = [...crypto.getRandomValues(new Uint8Array(32))];
  const body = [3, 3, ...random, 0, ...u16(suites.length), ...suites, 1, 0, ...u16(exts.length), ...exts];
  const hs = [1, ...u24(body.length), ...body];
  return new Uint8Array([22, 3, 1, ...u16(hs.length), ...hs]);
}
const ALERTS: Record<number, string> = { 40: "handshake failure", 70: "protocol version", 112: "unrecognized name", 80: "internal error", 71: "insufficient security" };

/** The certificate chain `host` presents on `port`, read over the Wisp relay `wisp`. */
export function fetchCerts(wisp: string, host: string, port = 443): Promise<CertResult> {
  return new Promise((resolve, reject) => {
    let rec = new Uint8Array(0), hs = new Uint8Array(0), done = false, tls = "TLS 1.2", cipher = "";
    const finish = (err: Error | null, chain?: Uint8Array[]) => {
      if (done) return; done = true; clearTimeout(timer); stream.close();
      if (err) { reject(err); return; }
      Promise.all(chain!.map(parseCert)).then((c) => resolve({ chain: c, tls, cipher }), reject);
    };
    const cat = (a: Uint8Array, b: Uint8Array) => { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; };
    const stream = wispStream(wisp, host, port, (data) => {
      rec = cat(rec, data);
      while (rec.length >= 5) {
        const len = rec[3]! << 8 | rec[4]!;
        if (rec.length < 5 + len) break;
        const type = rec[0]!, frag = rec.slice(5, 5 + len); rec = rec.slice(5 + len);
        if (type === 21) {
          const why = ALERTS[frag[1]!] ?? `alert ${frag[1]}`;
          finish(new Error(frag[1] === 70 ? "this site only speaks TLS 1.3, which encrypts the certificate: it cannot be read here" : `the site ended the handshake (${why})`));
          return;
        }
        if (type !== 22) continue;
        hs = cat(hs, frag);
        while (hs.length >= 4) {
          const mlen = hs[1]! << 16 | hs[2]! << 8 | hs[3]!;
          if (hs.length < 4 + mlen) break;
          const mt = hs[0]!, m = hs.slice(4, 4 + mlen); hs = hs.slice(4 + mlen);
          if (mt === 2) {                                                          // ServerHello
            const v = m[0]! << 8 | m[1]!; tls = v === 0x0303 ? "TLS 1.2" : v === 0x0302 ? "TLS 1.1" : v === 0x0301 ? "TLS 1.0" : `0x${v.toString(16)}`;
            const sid = m[34]!, cs = m[35 + sid]! << 8 | m[36 + sid]!; cipher = CIPHERS[cs] ?? `0x${cs.toString(16)}`;
          } else if (mt === 11) {                                                  // Certificate
            const certs: Uint8Array[] = [];
            for (let p = 3; p + 3 <= m.length; ) { const l = m[p]! << 16 | m[p + 1]! << 8 | m[p + 2]!; certs.push(m.slice(p + 3, p + 3 + l)); p += 3 + l; }
            finish(certs.length ? null : new Error("the site sent no certificate"), certs);
            return;
          }
        }
      }
    }, (why) => finish(new Error(why)));
    const timer = setTimeout(() => finish(new Error("the site took too long to answer")), 15000);
    stream.send(clientHello(host));
  });
}

// ---- X.509 (DER) ------------------------------------------------------------------------------------------------------------
type Node = { tag: number; cls: number; cons: boolean; start: number; len: number; hdr: number; kids?: Node[] };
function der(b: Uint8Array, at = 0, end = b.length): Node[] {
  const out: Node[] = [];
  while (at < end) {
    const t = b[at]!; let p = at + 1, len = b[p++]!;
    if (len & 0x80) { const n = len & 0x7f; len = 0; for (let i = 0; i < n; i++) len = len * 256 + b[p++]!; }
    const node: Node = { tag: t & 0x1f, cls: t >> 6, cons: !!(t & 0x20), start: p, len, hdr: p - at };
    if (node.cons) node.kids = der(b, p, p + len);
    out.push(node); at = p + len;
  }
  return out;
}
const OIDS: Record<string, string> = {
  "2.5.4.3": "CN", "2.5.4.6": "C", "2.5.4.7": "L", "2.5.4.8": "ST", "2.5.4.10": "O", "2.5.4.11": "OU", "2.5.4.5": "serialNumber",
  "1.2.840.113549.1.9.1": "E", "2.5.4.15": "businessCategory", "1.3.6.1.4.1.311.60.2.1.3": "jurisdictionC",
  "1.2.840.113549.1.1.5": "SHA-1 with RSA", "1.2.840.113549.1.1.11": "SHA-256 with RSA", "1.2.840.113549.1.1.12": "SHA-384 with RSA",
  "1.2.840.113549.1.1.13": "SHA-512 with RSA", "1.2.840.113549.1.1.10": "RSA-PSS", "1.2.840.10045.4.3.2": "ECDSA with SHA-256",
  "1.2.840.10045.4.3.3": "ECDSA with SHA-384", "1.2.840.10045.4.3.4": "ECDSA with SHA-512", "1.3.101.112": "Ed25519",
  "1.2.840.113549.1.1.1": "RSA", "1.2.840.10045.2.1": "EC", "1.2.840.10045.3.1.7": "P-256", "1.3.132.0.34": "P-384", "1.3.132.0.35": "P-521",
  "1.3.6.1.5.5.7.3.1": "Server authentication", "1.3.6.1.5.5.7.3.2": "Client authentication", "1.3.6.1.5.5.7.3.4": "Email protection",
  "1.3.6.1.5.5.7.3.3": "Code signing", "1.3.6.1.5.5.7.3.9": "OCSP signing",
};
const KEY_USAGE = ["Digital signature", "Non-repudiation", "Key encipherment", "Data encipherment", "Key agreement", "Certificate signing", "CRL signing", "Encipher only", "Decipher only"];
function oid(b: Uint8Array, n: Node): string {
  const v = b.subarray(n.start, n.start + n.len), parts = [Math.floor(v[0]! / 40), v[0]! % 40];
  let x = 0;
  for (let i = 1; i < v.length; i++) { x = x * 128 + (v[i]! & 0x7f); if (!(v[i]! & 0x80)) { parts.push(x); x = 0; } }
  return parts.join(".");
}
const str = (b: Uint8Array, n: Node) => n.tag === 30
  ? String.fromCharCode(...Array.from({ length: n.len / 2 }, (_, i) => b[n.start + 2 * i]! << 8 | b[n.start + 2 * i + 1]!))
  : new TextDecoder().decode(b.subarray(n.start, n.start + n.len));
const hex = (b: Uint8Array, sep = ":") => [...b].map((x) => x.toString(16).padStart(2, "0").toUpperCase()).join(sep);
function name(b: Uint8Array, n: Node): [string, string][] {
  return (n.kids ?? []).flatMap((set) => (set.kids ?? []).map((atv) => {
    const id = oid(b, atv.kids![0]!); return [OIDS[id] ?? id, str(b, atv.kids![1]!)] as [string, string];
  }));
}
function time(b: Uint8Array, n: Node): Date {
  const s = str(b, n), m = n.tag === 23 ? /^(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)?Z$/.exec(s) : /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)?Z$/.exec(s);
  if (!m) return new Date(NaN);
  const y = n.tag === 23 ? (+m[1]! < 50 ? 2000 : 1900) + +m[1]! : +m[1]!;
  return new Date(Date.UTC(y, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +(m[6] ?? 0)));
}
async function parseCert(d: Uint8Array): Promise<Cert> {
  const [cert] = der(d), tbs = cert!.kids![0]!, f = tbs.kids!;
  let i = 0, version = 1;
  if (f[0]!.cls === 2 && f[0]!.tag === 0) { version = d[f[0]!.kids![0]!.start]! + 1; i = 1; }
  const serial = f[i]!, sig = f[i + 1]!, issuer = f[i + 2]!, validity = f[i + 3]!, subject = f[i + 4]!, spki = f[i + 5]!;
  const keyAlgId = oid(d, spki.kids![0]!.kids![0]!), keyParam = spki.kids![0]!.kids![1];
  let keySize = "";
  if (keyAlgId === "1.2.840.113549.1.1.1") {
    const bits = spki.kids![1]!, inner = der(d, bits.start + 1, bits.start + bits.len)[0]!, mod = inner.kids![0]!;
    keySize = `${(mod.len - (d[mod.start] === 0 ? 1 : 0)) * 8} bits`;
  } else if (keyParam && keyParam.tag === 6) keySize = OIDS[oid(d, keyParam)] ?? oid(d, keyParam);
  const out: Cert = {
    subject: name(d, subject), issuer: name(d, issuer), version,
    serial: hex(d.subarray(serial.start, serial.start + serial.len)).replace(/^00:/, ""),
    notBefore: time(d, validity.kids![0]!), notAfter: time(d, validity.kids![1]!),
    sigAlg: OIDS[oid(d, sig.kids![0]!)] ?? oid(d, sig.kids![0]!), keyAlg: OIDS[keyAlgId] ?? keyAlgId, keySize,
    san: [], ca: null, keyUsage: [], extKeyUsage: [], sha256: "", sha1: "", der: d,
  };
  const extsWrap = f.find((n) => n.cls === 2 && n.tag === 3);
  for (const ext of extsWrap?.kids?.[0]?.kids ?? []) {
    const id = oid(d, ext.kids![0]!), val = ext.kids!.at(-1)!, inner = der(d, val.start, val.start + val.len)[0];
    if (!inner) continue;
    if (id === "2.5.29.17") for (const g of inner.kids ?? []) {
      if (g.tag === 2) out.san.push(str(d, g));
      else if (g.tag === 7) out.san.push(g.len === 4 ? [...d.subarray(g.start, g.start + 4)].join(".") : hex(d.subarray(g.start, g.start + g.len)));
    }
    else if (id === "2.5.29.19") out.ca = !!(inner.kids?.[0]?.tag === 1 && d[inner.kids[0].start]);
    else if (id === "2.5.29.15") {
      const unused = d[inner.start]!, bytes = d.subarray(inner.start + 1, inner.start + inner.len);
      KEY_USAGE.forEach((u, k) => { const byte = k >> 3; if (byte < bytes.length && (bytes[byte]! >> (7 - (k & 7)) & 1) && !(byte === bytes.length - 1 && 7 - (k & 7) < unused)) out.keyUsage.push(u); });
    }
    else if (id === "2.5.29.37") for (const k of inner.kids ?? []) { const o = oid(d, k); out.extKeyUsage.push(OIDS[o] ?? o); }
  }
  if (out.ca === null) out.ca = false;
  const buf = d.slice().buffer as ArrayBuffer;
  out.sha256 = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", buf)));
  out.sha1 = hex(new Uint8Array(await crypto.subtle.digest("SHA-1", buf)));
  return out;
}

/** The certificate as PEM text. */
export function pem(c: Cert): string {
  let s = ""; for (const b of c.der) s += String.fromCharCode(b);
  return `-----BEGIN CERTIFICATE-----\n${btoa(s).replace(/.{64}/g, "$&\n").replace(/\n$/, "")}\n-----END CERTIFICATE-----\n`;
}
/** Whether the certificate names `host` (exactly, or by a one-level wildcard). */
export function covers(c: Cert, host: string): boolean {
  const h = host.toLowerCase(), names = c.san.length ? c.san : c.subject.filter(([k]) => k === "CN").map(([, v]) => v);
  return names.some((n) => { n = n.toLowerCase(); return n === h || (n.startsWith("*.") && h.endsWith(n.slice(1)) && !h.slice(0, -n.length + 1).includes(".")); });
}
