#!/usr/bin/env bash
# Instala o Brito: clona, compila e expõe o comando `brito`.
set -euo pipefail

REPO="${BRITO_REPO:-https://github.com/wilsonbrito/brito.git}"
DIR="${BRITO_INSTALL_DIR:-$HOME/.brito-cli}"

command -v git >/dev/null || { echo "git não encontrado"; exit 1; }
command -v node >/dev/null || { echo "Node >= 20 não encontrado"; exit 1; }
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ] || { echo "Node >= 20 necessário"; exit 1; }

if [ -d "$DIR/.git" ]; then
  git -C "$DIR" pull --ff-only
else
  git clone --depth 1 "$REPO" "$DIR"
fi

cd "$DIR"
npm install
npm run build
npm link

echo "Pronto. Defina ANTHROPIC_API_KEY e rode: brito"
