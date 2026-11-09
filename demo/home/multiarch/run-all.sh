#!/bin/bash
# Runs every binary in this directory. All of them are foreign to each other: x86-64, x86, arm64, armhf, riscv64, riscv32.
# Nanite picks the right front end from each ELF header; nothing is registered, nothing is installed.
cd "$(dirname "$0")"
printf '\e[1m%-18s %-34s %s\e[0m\n' "binary" "file says" "output"
for f in hello-* busybox-*; do
  [ -x "$f" ] || continue
  kind=$(./busybox-x86 head -c 20 "$f" | od -An -tx1 | tr -d ' \n')
  case "${kind:36:4}" in 3e00) a="x86-64";; 0300) a="x86 (i386)";; b700) a="arm64";; 2800) a="arm (32-bit)";;
    f300) [ "${kind:8:2}" = 02 ] && a="riscv64" || a="riscv32";; *) a="?";; esac
  if [[ $f == busybox-* ]]; then out="$(./$f uname -m) · $(./$f sh -c 'echo sh $((6*7))') · $(./$f ls / | ./$f wc -l) files in /"
  else out=$(./$f | sed 's/\x1b\[[0-9;]*m//g'); fi
  printf '%-18s %-34s %s\n' "$f" "$a" "$out"
done
