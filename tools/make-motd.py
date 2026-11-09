# python3 tools/make-motd.py: writes demo/rootfs/etc/motd, the banner with Sakura-palette ANSI colors.
import pathlib
E = "\x1b["
P, L, G, Y, C, D, B, R = E+"38;2;255;101;253m", E+"38;2;203;182;255m", E+"38;2;34;229;41m", E+"38;2;245;149;116m", E+"38;2;152;146;241m", E+"38;2;120;109;105m", E+"1m", E+"0m"
rule = P + "=" * 44 + R
cmd = lambda c, note="": f"{D}-{R} {G}{c}{R}" + (f"  {note}" if note else "")
arch = lambda s: f"{C}{s}{R}"
lines = [
  rule,
  f"{B}{P}Welcome to the Nanite Webshell!{R}",
  "",
  f"{B}{L}Nanite{R} is a polyglot ({arch('x86-64')}, {arch('x86')}, {arch('riscv')}, {arch('riscv64')}, {arch('aarch64')}, {arch('armhf')}), performance-first",
  f"WASM userspace emulator for Linux. Though normally you'd use this with {Y}binfmt{R}, it",
  f"can also run standalone under its \"{L}vkernel{R}\" Linux userspace ABI implementation.",
  "",
  f"The Nanite Webshell runs a {B}Ubuntu 26.04 LTS{R} rootfs and runs it alongside the {L}vkernel{R}",
  f"implementation. Internet access is available through {Y}WISP{R}, and all processing and",
  "storage happens on your device.",
  "",
  f"{B}Try out some commands{R} {D}(run{R} {G}apt update{R} {D}first){R}:",
  cmd("uname -a"),
  cmd("apt install -y curl && curl -I https://ubuntu.com"),
  cmd("apt install -y neovim && nvim"),
  cmd("apt install -y python3 && python3 -c \"print('hello from nanite!')\""),
  "",
  f"{B}More in your home directory{R}:",
  cmd("./multiarch/run-all.sh        ", f"{arch('x86')}, {arch('arm64')}, {arch('armhf')}, {arch('riscv64')} and {arch('riscv32')} binaries"),
  cmd("./multiarch/busybox-aarch64 sh", f"an {arch('arm64')} shell, on this {arch('x86-64')} Ubuntu"),
  cmd("./multiarch/hello-riscv32     ", f"a 900-byte {arch('riscv32')} program"),
  cmd("./net-test.sh                 ", f"DNS, TCP, HTTP and ping through {Y}WISP{R}"),
  cmd("./screen/paint                ", "draw on the virtual screen (the monitor tab)"),
  cmd("./screen/install-desktop.sh  ", f"a lightweight desktop (Xorg + JWM), then {G}startdesktop{R}"),
  cmd("usage                         ", "CPU, RAM, disk and network at a glance"),
  cmd("ping 1.1.1.1                  ", f"real ICMP, through {Y}WISP{R}'s ping extension"),
  f"{D}-{R} {G}./sysinfo.sh{R}, {G}./colors.sh{R}       the machine and the terminal",
  "",
  f"I've put in a few files in the home directory for you to play with. Feel free to peek around!",
  rule,
  "",
]
out = pathlib.Path(__file__).resolve().parent.parent / "demo/rootfs/etc/motd"
out.write_text("\n".join(lines))
print(out)
