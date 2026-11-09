#!/bin/sh
# tools/make-root.sh [NAME]: builds a root filesystem with Docker, exports it flat (cache/roots/NAME.tar.gz) and splits it into the
# FragmentedFS store the page loads, public/roots/NAME.ffs/ (tools/tar-to-ffs.mjs; src/lib/ffsroot.ts reads it).
#   ubuntu-26.04-x86_64    Ubuntu 26.04 LTS, webshell edition: the motd, usage, ping, ~/ extras (tools/Dockerfile.ubuntu26; default)
#   ubuntu-26.04-plain     Ubuntu 26.04 LTS as Docker ships it, but GNU coreutils   } tools/Dockerfile.roots: each with
#   debian-13              debian:trixie as Docker ships it                       } `usage` (static) added
#   alpine-3.22            alpine:3.22 as Docker ships it                         }
# Not zstd: browsers have no native zstd decoder, and fzstd (JS) took 23 s on it; DecompressionStream("gzip") is native and
# inflates while the file downloads.
set -eu
cd "$(dirname "$0")/.."
name=${1:-ubuntu-26.04-x86_64}
case $name in
  ubuntu-26.04-x86_64) img=nanite-webshell-ubuntu:26.04; docker build --platform linux/amd64 -q -t $img -f tools/Dockerfile.ubuntu26 . ;;
  ubuntu-26.04-plain) img=nanite-webshell-root:ubuntu-plain; docker build --platform linux/amd64 -q --target ubuntu-plain -t $img -f tools/Dockerfile.roots . ;;
  debian-13) img=nanite-webshell-root:debian; docker build --platform linux/amd64 -q --target debian -t $img -f tools/Dockerfile.roots . ;;
  alpine-3.22) img=nanite-webshell-root:alpine; docker build --platform linux/amd64 -q --target alpine -t $img -f tools/Dockerfile.roots . ;;
  *) echo "make-root.sh: unknown root $name" >&2; exit 2 ;;
esac
c=$(docker create --platform linux/amd64 $img /bin/true)
trap 'docker rm -f "$c" >/dev/null' EXIT
mkdir -p cache/roots
out=cache/roots/$name.tar.gz
docker export "$c" | python3 -I tools/export-rootfs.py | gzip -9 > $out.part
mv $out.part $out
node tools/tar-to-ffs.mjs $out public/roots/$name.ffs.part
node vendor/fragmentedfs/scripts/fragmentedfs.mjs verify public/roots/$name.ffs.part
rm -rf public/roots/$name.ffs && mv public/roots/$name.ffs.part public/roots/$name.ffs
