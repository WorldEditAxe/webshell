# Welcome to the nanite webshell

Everything here runs in your browser tab: Ubuntu 26.04's own x86-64 binaries, translated to WebAssembly by Nanite.

    ./sysinfo.sh              what the machine looks like from inside
    ./colors.sh               the terminal: palette, 256 colors, truecolor, Unicode
    ./net-test.sh             DNS, TCP, HTTP and ICMP ping through the Wisp relay
    ping 1.1.1.1              real ICMP echo, through Spark's Wisp ping extension (source: /usr/local/src/ping)
    multiarch/run-all.sh      x86, arm64, armhf, riscv64 and riscv32 binaries side by side
    screen/paint              draw on the virtual screen: open it with the monitor tab (top bar),
                              click it to capture mouse + keyboard (Esc releases), q quits
    screen/install-desktop.sh a lightweight desktop on the virtual screen (Xorg + JWM + xterm), then: startdesktop
    usage                     CPU, RAM, disk and network at a glance (source: /usr/local/src/usage)
    python3 fib.py            after: apt install -y python3

Your files are kept in this browser's storage: they survive a reload. The menu (⋮, top right) saves the whole disk to a file, loads one back, resets to a fresh Ubuntu, or changes the launch settings (memory, screen size, Wisp server). The + in the top bar opens more terminals.
