#!/usr/bin/env bash
# usage.sh — minimal CPU / RAM / disk / network usage report (Linux)
# Colours are always on; set NO_COLOR=1 to turn them off.

if [[ -z ${NO_COLOR:-} ]]; then
  B=$'\e[1m' D=$'\e[2m' R=$'\e[0m' G=$'\e[32m' Y=$'\e[33m' E=$'\e[31m'
  C=$'\e[96m' M=$'\e[95m' BL=$'\e[94m' O=$'\e[93m' W=$'\e[97m'
fi

first=1
bar() {  # bar PCT ICON LABEL LABEL_COLOUR DETAIL — title + stats, then bar below
  local p=$1 w=40 n c=$G f e
  (( p > 100 )) && p=100; n=$(( p * w / 100 ))
  (( p >= 60 )) && c=$Y; (( p >= 85 )) && c=$E
  printf -v f '%*s' "$n" ''; printf -v e '%*s' $(( w - n )) ''
  (( first )) || echo; first=0
  printf "%s %s%s${R}  %s\n" "$2" "$B$4" "$3" "$5"
  printf "   %s%s${R}${D}%s${R} %s${B}%3d%%${R}\n" "$c" "${f// /█}" "${e// /░}" "$c" "$p"
}
v() { printf '%s' "$W$*$R"; }   # highlight a value
hb() { awk -v b="$1" 'BEGIN { split("B K M G T P", u); i = 1
  while (b >= 1024 && i < 6) { b /= 1024; i++ }; printf(i == 1 ? "%d%s" : "%.1f%s", b, u[i]) }'; }

# CPU + network: two samples 0.5s apart (network = default-route interface)
nif=$(awk '$2 == "00000000" {print $1; exit}' /proc/net/route)
net() { awk -v i="$nif:" '$1 == i {print $2, $10}' /proc/net/dev; }
read -r _ a1 a2 a3 a4 a5 _ < /proc/stat; read -r rx1 tx1 < <(net); sleep 0.5
read -r _ b1 b2 b3 b4 b5 _ < /proc/stat; read -r rx2 tx2 < <(net)
idle=$(( b4 + b5 - a4 - a5 )) total=$(( b1+b2+b3+b4+b5 - a1-a2-a3-a4-a5 ))
cpu=$(( total > 0 ? 100 * (total - idle) / total : 0 ))
read -r l1 l5 l15 procs _ < /proc/loadavg

# RAM (kB)
mt=$(awk '/^MemTotal/{print $2}' /proc/meminfo)
ma=$(awk '/^MemAvailable/{print $2}' /proc/meminfo)
mu=$(( mt - ma ))

echo "${B}${C}System Stats${R} ${D}(up${R} $(v "$(awk '{s=int($1); d=int(s/86400); printf (d ? d "d " : "") "%dh %dm", s%86400/3600, s%3600/60}' /proc/uptime)")${D})${R}"
bar "$cpu" ⚡ CPU "$C" "${D}load${R} $(v "$l1 $l5 $l15") ${D}·${R} $(v "$(nproc)") ${D}cores ·${R} $(v "$(ls -d /proc/[0-9]* | wc -l)") ${D}procs (${R}$(v "${procs%/*}") ${D}running)${R}"
bar $(( 100 * mu / mt )) 🧠 RAM "$M" "$(v $(( mu / 1024 ))) ${D}/${R} $(v $(( mt / 1024 ))) ${D}MiB${R}"
# Disk: real filesystems from POSIX df (works with GNU, BusyBox, etc.); always fall back to /
disks=$(df -kP 2>/dev/null | awk 'NR > 1 && $2 > 0 && $1 !~ /^(tmpfs|devtmpfs|udev|none|shm|overlay|squashfs)$/ &&
  $6 !~ /^\/(snap|sys|proc|dev|run)(\/|$)/ && !seen[$1]++ { print $3, $2, $4, $6 }')
[[ -z $disks ]] && disks=$(df -kP / 2>/dev/null | awk 'NR == 2 { print $3, $2, $4, $6 }')
while read -r used size avail mnt; do   # % like df: used / (used + avail), rounded up
  [[ -n $size ]] && bar $(( (100 * used + used + avail - 1) / (used + avail) )) 💾 Disk "$BL" "$(v "$(hb $((used * 1024)))") ${D}/${R} $(v "$(hb $((size * 1024)))")  ${BL}$mnt${R}"
done <<< "$disks"
if [[ -n $nif ]]; then
  rx=$(( (rx2 - rx1) * 2 )) tx=$(( (tx2 - tx1) * 2 ))          # bytes/s
  rate() { echo "$(hb "$1")/s"; }
  speed=$(cat "/sys/class/net/$nif/speed" 2>/dev/null)        # Mbit/s, -1 if unknown
  max=$(( rx > tx ? rx : tx ))
  bar $(( speed > 0 ? max * 800 / (speed * 1000000) : 0 )) 🌐 Net "$O" \
    "${G}↓${R} $(v "$(rate $rx)") ${M}↑${R} $(v "$(rate $tx)")  ${O}$nif${R}$( (( speed > 0 )) && echo " ${D}@ ${speed}Mb/s${R}")"
fi
