#!/bin/sh
# tools/get-vscode-web.sh: downloads Microsoft's VS Code for the Web (the "web-standalone" build, the workbench of vscode.dev)
# into public/vscode/web, checking its sha256. The Code tab runs it in an iframe (public/vscode/index.html) with the extension in
# public/vscode/nanite (the machine's files as the workspace, its bash as the terminal).
set -eu
cd "$(dirname "$0")/.."
meta=$(curl -fsSL https://update.code.visualstudio.com/api/update/web-standalone/stable/latest)
url=$(printf '%s' "$meta" | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["url"])')
sum=$(printf '%s' "$meta" | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["sha256hash"])')
ver=$(printf '%s' "$meta" | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["productVersion"])')
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
curl -fsSL -o "$tmp/web.tar.gz" "$url"
echo "$sum  $tmp/web.tar.gz" | sha256sum -c -
mkdir "$tmp/x" && tar -xzf "$tmp/web.tar.gz" -C "$tmp/x"
rm -rf public/vscode/web && mkdir -p public/vscode && mv "$tmp/x/vscode-web" public/vscode/web
echo "$ver" > public/vscode/web/VERSION
du -sh public/vscode/web; echo "VS Code for the Web $ver"
