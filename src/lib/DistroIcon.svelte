<!-- A root's logo: the distribution's own (Simple Icons, in its brand colour), found from the root's icon or, for Docker images,
     URLs and files, from its name (debian:13, archlinux, rockylinux-9.tar.gz ...). Anything else: a Lucide icon. -->
<script lang="ts">
  import { siAlmalinux, siAlpinelinux, siArchlinux, siCentos, siDebian, siDocker, siFedora, siGentoo, siKalilinux, siLinux, siLinuxmint,
    siManjaro, siNixos, siOpensuse, siRedhat, siRockylinux, siUbuntu, siVoidlinux } from "simple-icons";
  import { CircleDot, FileArchive, Link } from "@lucide/svelte";

  type Logo = { title: string; path: string; hex: string };
  let { icon, name = "", size = 16 }: { icon: string; name?: string; size?: number } = $props();

  // By name, first match wins (linuxmint before "linux", ubuntu before the rest of the Debian family).
  const BY_NAME: [RegExp, Logo][] = [
    [/ubuntu/, siUbuntu], [/debian/, siDebian], [/alpine/, siAlpinelinux], [/arch/, siArchlinux], [/fedora/, siFedora],
    [/rocky/, siRockylinux], [/alma/, siAlmalinux], [/centos/, siCentos], [/rhel|redhat|ubi\d?/, siRedhat], [/suse/, siOpensuse],
    [/gentoo/, siGentoo], [/void/, siVoidlinux], [/nixos/, siNixos], [/kali/, siKalilinux], [/mint/, siLinuxmint],
    [/manjaro/, siManjaro],
  ];
  const BY_ICON: Record<string, Logo> = { ubuntu: siUbuntu, debian: siDebian, alpine: siAlpinelinux, docker: siDocker };

  const logo = $derived(BY_ICON[icon] && icon !== "docker" ? BY_ICON[icon]
    : BY_NAME.find(([re]) => re.test(name.toLowerCase()))?.[1] ?? (icon === "docker" ? siDocker : icon === "linux" ? siLinux : null));
  // Brand colours too dark to see on the dark circles (Debian's red, Alpine's navy, AlmaLinux's black) are lifted toward white until
  // they read; the hue stays.
  function colour(hex: string): string {
    const n = parseInt(hex, 16), c = [n >> 16, (n >> 8) & 255, n & 255];
    const lum = (v: number[]) => 0.2126 * v[0]! + 0.7152 * v[1]! + 0.0722 * v[2]!;
    let t = 0, v = c;
    while (lum(v) < 105 && t < 1) { t += 0.05; v = c.map((x) => Math.round(x + (255 - x) * t)); }
    return `rgb(${v.join(" ")})`;
  }
</script>

{#if logo}
  <svg role="img" aria-label={logo.title} viewBox="0 0 24 24" width={size} height={size} fill={colour(logo.hex)}>
    <title>{logo.title}</title><path d={logo.path} />
  </svg>
{:else if icon === "file"}<FileArchive {size} />
{:else if icon === "link"}<Link {size} />
{:else}<CircleDot {size} />
{/if}
