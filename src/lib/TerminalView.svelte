<!-- One terminal tab's xterm.js. Every tab stays mounted (hidden ones are invisible, not removed), so each keeps its size. -->
<script lang="ts">
  import { onMount } from "svelte";
  import type { Shell } from "./term";

  let { shell, active, dispose = false }: { shell: Shell; active: boolean; dispose?: boolean } = $props();
  let el: HTMLDivElement;

  onMount(() => {
    shell.mount(el);
    const ro = new ResizeObserver(() => shell.scheduleFit());
    ro.observe(el);
    return () => { ro.disconnect(); if (dispose) shell.dispose(); };
  });
  $effect(() => {
    if (active) requestAnimationFrame(() => { shell.refit(); shell.term.focus(); });
  });
</script>

<!-- overflow-hidden: nothing ever draws past the pane (Shell.refit fits the rows to what is drawn). -->
<div bind:this={el} class="absolute inset-0 overflow-hidden pt-2 pl-2.5" class:invisible={!active} role="tabpanel"></div>
