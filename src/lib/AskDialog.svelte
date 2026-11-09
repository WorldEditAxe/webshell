<!-- The page's own confirm / prompt (lib/ask.svelte.ts). Enter confirms, Esc cancels. -->
<script lang="ts">
  import { CircleHelp, TriangleAlert, Trash2, Check, X } from "@lucide/svelte";
  import { asking } from "./ask.svelte";

  let dialog: HTMLDialogElement, field = $state<HTMLInputElement>();
  let value = $state("");
  const cur = $derived(asking.current);
  $effect(() => {
    if (cur && !dialog.open) { value = cur.input ?? ""; dialog.showModal(); requestAnimationFrame(() => field?.select()); }
    else if (!cur && dialog.open) dialog.close();
  });
  function done(ok: boolean): void {
    const c = asking.current; if (!c) return;
    asking.current = null;
    c.resolve(ok ? (c.input !== undefined ? value.trim() || null : "yes") : null);
  }
  const tones = { question: "bg-sakura/15 text-sakura", warn: "bg-[#e5b567]/15 text-[#e5b567]", danger: "bg-danger/15 text-danger" };
</script>

<dialog bind:this={dialog} oncancel={(e) => { e.preventDefault(); done(false); }}
  class="m-auto w-[min(400px,calc(100vw-32px))] rounded-3xl border border-line bg-bg p-0 text-fg shadow-2xl shadow-black/60 backdrop:bg-black/50 backdrop:backdrop-blur-[2px]">
  {#if cur}
    <form class="grid gap-4 p-5" onsubmit={(e) => { e.preventDefault(); done(true); }}>
      <div class="flex items-start gap-3">
        <span class="grid h-9 w-9 shrink-0 place-items-center rounded-full {tones[cur.tone ?? 'question']}">
          {#if cur.tone === "danger"}<Trash2 size={17} />{:else if cur.tone === "warn"}<TriangleAlert size={17} />{:else}<CircleHelp size={17} />{/if}
        </span>
        <div class="grid min-w-0 gap-1 pt-1">
          <h2 class="text-sm font-bold">{cur.title}</h2>
          {#if cur.message}<p class="text-xs leading-relaxed text-muted">{cur.message}</p>{/if}
        </div>
      </div>
      {#if cur.input !== undefined}
        <input bind:this={field} bind:value placeholder={cur.placeholder}
          class="w-full rounded-full border border-line bg-panel px-4 py-2 text-[13px] outline-none placeholder:text-muted/70 focus:border-blossom" />
      {/if}
      <div class="flex justify-end gap-2">
        <button type="button" class="flex items-center gap-1.5 rounded-full border border-line bg-raised px-4 py-1.5 text-xs hover:border-blossom" onclick={() => done(false)}><X size={13} />{cur.cancel ?? "Cancel"}</button>
        <button type="submit" class="flex items-center gap-1.5 rounded-full px-4 py-1.5 text-xs font-bold {cur.tone === 'danger' ? 'bg-danger text-bg hover:brightness-110' : 'bg-sakura text-bg hover:bg-[#f7c8d6]'}">
          {#if cur.tone === "danger"}<Trash2 size={13} />{:else}<Check size={13} />{/if}{cur.confirm ?? "OK"}
        </button>
      </div>
    </form>
  {/if}
</dialog>
