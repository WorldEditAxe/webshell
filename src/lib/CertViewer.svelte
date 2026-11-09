<!-- The Preview tab's site information: the padlock in the address bar, and a panel with the certificate chain the site presents
     (read over Wisp by lib/cert.ts): each certificate's names, issuer, validity, key, extensions and fingerprints, and its PEM. -->
<script lang="ts">
  import { Lock, LockOpen, Server, TriangleAlert, LoaderCircle, Download, X, ShieldCheck } from "@lucide/svelte";
  import { fetchCerts, pem, covers, type CertResult } from "./cert";
  import { currentWisp } from "./preview";

  let { url }: { url: string } = $props();

  const LOCAL = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|10\.0\.2\.15)$/i;
  const at = $derived.by(() => { try { return new URL(url); } catch { return null; } });
  const kind = $derived(!at ? "none" : LOCAL.test(at.hostname) ? "machine" : at.protocol === "https:" ? "https" : "http");

  let open = $state(false), loading = $state(false), error = $state(""), result = $state<CertResult | null>(null), shown = $state(0), forHost = "";
  async function show(): Promise<void> {
    open = !open;
    if (!open || kind !== "https" || !at) return;
    const key = `${at.hostname}:${at.port || 443}`;
    if (key === forHost && (result || loading)) return;
    forHost = key; result = null; error = ""; shown = 0; loading = true;
    try {
      const w = currentWisp();
      if (!w) throw new Error("the network (Wisp) is not connected yet");
      result = await fetchCerts(w.endsWith("/") ? w : `${w}/`, at.hostname, +(at.port || 443));
    } catch (e) { error = (e as Error).message; }
    loading = false;
  }
  $effect(() => {
    if (!open) return;
    const close = (e: Event) => { if (e.type === "blur" || !(e.target as Element).closest?.("[data-certview]")) open = false; };
    window.addEventListener("pointerdown", close, true); window.addEventListener("blur", close);
    return () => { window.removeEventListener("pointerdown", close, true); window.removeEventListener("blur", close); };
  });

  const fmt = (d: Date) => isNaN(+d) ? "?" : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  const dn = (n: [string, string][]) => n.map(([k, v]) => `${k}=${v}`).join(", ");
  const cn = (n: [string, string][]) => n.find(([k]) => k === "CN")?.[1] ?? n.find(([k]) => k === "O")?.[1] ?? dn(n);
  function save(i: number): void {
    const c = result!.chain[i]!, a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([pem(c)], { type: "application/x-pem-file" }));
    a.download = `${cn(c.subject).replace(/[^\w.-]+/g, "_")}.pem`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  const leaf = $derived(result?.chain[0]);
  const now = Date.now();
  const valid = $derived(!!leaf && +leaf.notBefore <= now && now <= +leaf.notAfter);
  const matches = $derived(!!leaf && !!at && covers(leaf, at.hostname));
</script>

<div class="relative flex shrink-0 items-center" data-certview>
  <button type="button" class="grid h-5 w-5 place-items-center rounded-full transition-colors hover:bg-sakura/15
    {kind === 'https' ? 'text-muted hover:text-sakura' : kind === 'http' ? 'text-danger/80' : 'text-muted'}" disabled={kind === "none"}
    title={kind === "https" ? "Connection is encrypted: view the certificate" : kind === "http" ? "Not secure: the connection is not encrypted" : kind === "machine" ? "A page served by the machine" : ""}
    aria-haspopup="dialog" aria-expanded={open} onclick={show}>
    {#if kind === "https"}<Lock size={12} />{:else if kind === "http"}<LockOpen size={12} />{:else}<Server size={12} />{/if}
  </button>
  {#if open}
    <div role="dialog" aria-label="Site information" class="absolute top-full left-0 z-30 mt-2.5 max-h-[70vh] w-[min(30rem,calc(100vw-2rem))] overflow-auto rounded-3xl border border-line bg-panel p-4 text-xs shadow-xl shadow-black/50">
      <div class="mb-3 flex items-start gap-2">
        {#if kind === "https"}<ShieldCheck size={16} class="mt-0.5 shrink-0 text-sakura" />{:else if kind === "http"}<TriangleAlert size={16} class="mt-0.5 shrink-0 text-danger" />{:else}<Server size={16} class="mt-0.5 shrink-0 text-sakura" />{/if}
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm text-fg">{at?.host}</p>
          <p class="text-muted">
            {#if kind === "https"}Encrypted (HTTPS), fetched over the machine's Wisp relay with TLS in this browser.
            {:else if kind === "http"}Not secure: this connection is not encrypted.
            {:else}Served by the machine, over its own network (not encrypted, never leaves this browser).{/if}
          </p>
        </div>
        <button type="button" class="grid h-6 w-6 shrink-0 place-items-center rounded-full text-muted hover:bg-sakura/15 hover:text-sakura" title="Close" onclick={() => (open = false)}><X size={13} /></button>
      </div>
      {#if kind === "https"}
        {#if loading}
          <p class="flex items-center gap-2 text-muted"><LoaderCircle size={13} class="animate-spin text-sakura" />Reading the certificate…</p>
        {:else if error}
          <p class="text-danger">Could not read the certificate: {error}</p>
        {:else if result && leaf}
          <div class="mb-3 grid gap-1 rounded-2xl bg-bg p-3">
            <p class={valid ? "text-fg" : "text-danger"}>{valid ? "Valid" : +leaf.notAfter < now ? "Expired" : "Not yet valid"} until {fmt(leaf.notAfter)}</p>
            <p class={matches ? "text-fg" : "text-danger"}>{matches ? `Issued for ${at?.hostname}` : `Not issued for ${at?.hostname}`}</p>
            <p class="text-muted">{result.tls} · {result.cipher}</p>
          </div>
          {#if result.chain.length > 1}
            <div class="mb-3 flex flex-wrap gap-1" role="tablist">
              {#each result.chain as c, i (i)}
                <button type="button" role="tab" aria-selected={shown === i} onclick={() => (shown = i)}
                  class="max-w-full truncate rounded-full px-3 py-1 transition-colors {shown === i ? 'bg-sakura/20 text-sakura' : 'text-fg hover:bg-sakura/15 hover:text-sakura'}">
                  {"  ".repeat(i)}{cn(c.subject)}</button>
              {/each}
            </div>
          {/if}
          {@const c = result.chain[shown]!}
          <dl class="grid grid-cols-[7.5rem_1fr] gap-x-3 gap-y-1.5 [&_dd]:min-w-0 [&_dd]:break-words [&_dd]:text-fg [&_dt]:text-muted">
            <dt>Issued to</dt><dd>{dn(c.subject)}</dd>
            <dt>Issued by</dt><dd>{dn(c.issuer)}</dd>
            <dt>Valid from</dt><dd>{fmt(c.notBefore)}</dd>
            <dt>Valid until</dt><dd>{fmt(c.notAfter)}</dd>
            {#if c.san.length}<dt>Names</dt><dd>{c.san.slice(0, 40).join(", ")}{c.san.length > 40 ? ` and ${c.san.length - 40} more` : ""}</dd>{/if}
            <dt>Public key</dt><dd>{c.keyAlg}{c.keySize ? ` (${c.keySize})` : ""}</dd>
            <dt>Signature</dt><dd>{c.sigAlg}</dd>
            <dt>Serial number</dt><dd class="font-mono text-[10px]">{c.serial}</dd>
            <dt>Version</dt><dd>{c.version}</dd>
            <dt>Authority</dt><dd>{c.ca ? "Yes (can sign certificates)" : "No"}</dd>
            {#if c.keyUsage.length}<dt>Key usage</dt><dd>{c.keyUsage.join(", ")}</dd>{/if}
            {#if c.extKeyUsage.length}<dt>Extended usage</dt><dd>{c.extKeyUsage.join(", ")}</dd>{/if}
            <dt>SHA-256</dt><dd class="font-mono text-[10px]">{c.sha256}</dd>
            <dt>SHA-1</dt><dd class="font-mono text-[10px]">{c.sha1}</dd>
          </dl>
          <button type="button" class="mt-3 flex items-center gap-2 rounded-full border border-line px-3 py-1.5 text-fg transition-colors hover:border-sakura/60 hover:bg-sakura/15 hover:text-sakura" onclick={() => save(shown)}>
            <Download size={13} />Download this certificate (PEM)</button>
        {/if}
      {/if}
    </div>
  {/if}
</div>
