// Cloudflare Worker in front of the static assets (wrangler.jsonc; built by tools/build-cf.mjs into cf-dist/). Everything is a
// static asset except two things server.mjs did:
//  - /roots/NAME.ffs/blobs/ID: a FragmentedFS blob. Blobs that compress are uploaded only as blobs/ID.gz (the free plan allows
//    20,000 files, and raw + gzip copies of every blob would pass that); they are sent as is with Content-Encoding: gzip (the
//    browser inflates them before the page checks their SHA-256), or inflated here for a client that takes no gzip.
//  - /api/docker: building roots from Docker images needs Docker, which a Worker has not; the page shows the error.
const BLOB = /^\/roots\/[^/]+\.ffs\/blobs\/[0-9a-f]+$/;
const IMMUTABLE = "public, max-age=31536000, immutable";

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/docker"))
      return Response.json({ state: "error", error: "Docker images can't be built on this deployment (it has no Docker); run server.mjs for that" },
        { headers: { "Cache-Control": "no-store" } });
    if (BLOB.test(url.pathname) && (req.method === "GET" || req.method === "HEAD")) {
      const gz = await env.ASSETS.fetch(new URL(url.pathname + ".gz", url), { method: req.method });
      const headers = { "Content-Type": "application/octet-stream", "Cache-Control": IMMUTABLE, "Vary": "Accept-Encoding" };
      if (gz.ok) {
        if (/\bgzip\b/.test(req.headers.get("Accept-Encoding") ?? ""))
          return new Response(gz.body, { headers: { ...headers, "Content-Encoding": "gzip" }, encodeBody: "manual" });
        return new Response(gz.body?.pipeThrough(new DecompressionStream("gzip")), { headers });
      }
      const raw = await env.ASSETS.fetch(req);
      return raw.ok ? new Response(raw.body, { headers }) : raw;
    }
    return env.ASSETS.fetch(req);
  },
};
