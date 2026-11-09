#!/bin/bash
# The network: the guest's TCP and UDP leave through Spark Linux's Wisp relay (a WebSocket from this page).
# Checks DNS (UDP), TCP connect times, an HTTP request, and ICMP ping (Spark's Wisp ping extension, through the page's bridge).
ms() { echo $(( ($(date +%s%N) - $1) / 1000000 )); }
echo -e "\e[1mDNS\e[0m (UDP to $(awk '/^nameserver/{print $2; exit}' /etc/resolv.conf))"
for h in ubuntu.com github.com cloudflare.com; do t=$(date +%s%N); ip=$(getent ahostsv4 $h | awk '{print $1; exit}'); echo "  $h -> ${ip:-FAILED} ($(ms $t) ms)"; done
echo -e "\e[1mTCP connect\e[0m (through Wisp)"
for hp in 1.1.1.1:443 8.8.8.8:53 archive.ubuntu.com:80; do
  t=$(date +%s%N)
  if timeout 5 bash -c "exec 3<>/dev/tcp/${hp%:*}/${hp#*:}" 2>/dev/null; then echo "  $hp open ($(ms $t) ms)"; else echo "  $hp FAILED"; fi
done
echo -e "\e[1mHTTP\e[0m"
t=$(date +%s%N)
exec 3<>/dev/tcp/example.com/80 && printf 'HEAD / HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n' >&3 && head -1 <&3 | sed "s/^/  example.com: /; s/\r//" && exec 3<&- && echo "  ($(ms $t) ms)"
echo -e "\e[1mICMP ping\e[0m"
ping -c 3 -W 3 1.1.1.1 | sed 's/^/  /'
