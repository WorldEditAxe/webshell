#!/bin/sh
# riscv is pinned to RV64GC/RV32GC: this clang defaults riscv64 to RVA23 (Zcb etc.), which Nanite does not decode.
# Builds demo/home/multiarch/hello.c for six architectures into demo/home/multiarch/hello-<arch> (static, no libc). Needs clang + ld.lld.
set -eu
cd "$(dirname "$0")/.."
out=demo/home/multiarch; mkdir -p $out
for t in x86_64:x86_64-linux-gnu x86:i386-linux-gnu aarch64:aarch64-linux-gnu armhf:armv7a-linux-gnueabihf riscv64:riscv64-linux-gnu:rv64gc riscv32:riscv32-linux-gnu:rv32gc; do
  a=${t%%:*}; tr=${t#*:}; march=""
  case $tr in *:*) march="-march=${tr#*:}"; tr=${tr%%:*};; esac
  clang --target=$tr $march -Os -static -nostdlib -ffreestanding -fno-pic -fno-stack-protector -fuse-ld=lld \
    -Wl,--build-id=none -Wl,-z,norelro -o $out/hello-$a demo/home/multiarch/hello.c
  llvm-strip $out/hello-$a 2>/dev/null || strip $out/hello-$a 2>/dev/null || true
done
# The screen demo (x86-64 only: it runs on the Ubuntu itself).
clang --target=x86_64-linux-gnu -O2 -static -nostdlib -ffreestanding -fno-pic -fno-stack-protector -fno-builtin -fuse-ld=lld \
  -Wl,--build-id=none -Wl,-z,norelro -o demo/home/screen/paint demo/home/screen/paint.c
llvm-strip demo/home/screen/paint 2>/dev/null || strip demo/home/screen/paint 2>/dev/null || true
ls -l $out/hello-* demo/home/screen/paint
