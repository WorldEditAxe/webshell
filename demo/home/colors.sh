#!/bin/bash
# The terminal's colors: the 16-color Sakura palette, the 256-color cube, a truecolor gradient and some Unicode.
printf '\n  \e[1mSakura palette\e[0m\n  '
for i in {0..7}; do printf '\e[48;5;%dm    \e[0m' $i; done; printf '\n  '
for i in {8..15}; do printf '\e[48;5;%dm    \e[0m' $i; done; printf '\n\n  \e[1m256 colors\e[0m\n'
for r in {0..5}; do printf '  '; for g in {0..5}; do for b in {0..5}; do printf '\e[48;5;%dm \e[0m' $((16 + r*36 + g*6 + b)); done; printf ' '; done; printf '\n'; done
printf '\n  \e[1mtruecolor\e[0m\n  '
for i in $(seq 0 2 118); do r=$((255 - i)); g=$((60 + i/2)); b=$((150 + i*0 + i/2)); printf '\e[48;2;%d;%d;%dm \e[0m' $r $g $b; done
printf '\n\n  \e[1mstyles\e[0m  \e[1mbold\e[0m \e[2mdim\e[0m \e[3mitalic\e[0m \e[4munderline\e[0m \e[9mstrike\e[0m \e[7minverse\e[0m\n'
printf '  \e[1municode\e[0m 🌸 桜 さくら ┌─┬─┐ ▁▂▃▄▅▆▇█ ⣿⡇ → ✓ ✗ λ π ∞\n\n'
