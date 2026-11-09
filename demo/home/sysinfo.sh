#!/bin/bash
# What the machine looks like from the inside.
b() { printf '\e[1;35m%-10s\e[0m %s\n' "$1" "$2"; }
. /etc/os-release
b os "$PRETTY_NAME"
b kernel "$(uname -srm)  (Nanite's vkernel: Linux's system calls, implemented in WebAssembly)"
b cpu "$(nproc) cpus, $(grep -m1 'model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2- | sed 's/^ //')"
b memory "$(free -m 2>/dev/null | awk '/^Mem:/{print $3 " MiB used of " $2}')"
b disk "$(df -h / 2>/dev/null | awk 'NR==2{print $3 " used of " $2 " on /"}')"
b uptime "$(uptime -p 2>/dev/null)"
b shell "$BASH $BASH_VERSION"
b user "$(id)"
