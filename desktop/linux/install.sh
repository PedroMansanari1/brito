#!/usr/bin/env bash
# Instala o Brito desktop para o usuário atual: ~/.local/share/brito-desktop + atalho no menu de aplicativos.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="${BRITO_PREFIX:-$HOME/.local/share/brito-desktop}"
BIN="${BRITO_BIN_DIR:-$HOME/.local/bin}"
APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
ICONS="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/512x512/apps"

rm -rf "$DEST"; mkdir -p "$DEST" "$BIN" "$APPS" "$ICONS"
cp -R "$HERE"/. "$DEST"/
rm -f "$DEST/install.sh"
ln -sf "$DEST/brito-desktop" "$BIN/brito-desktop"
cp "$DEST/resources/app/icon.png" "$ICONS/brito.png"
cat > "$APPS/brito.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Brito
Comment=Agente de código com grafo de conhecimento
Exec=$DEST/brito-desktop
Icon=brito
Terminal=false
Categories=Development;
EOF
command -v update-desktop-database >/dev/null && update-desktop-database "$APPS" || true
echo "✓ Brito instalado. Procure \"Brito\" no menu de aplicativos, ou rode: $BIN/brito-desktop"
echo "  Requer o Claude Code (claude → /login) ou ANTHROPIC_API_KEY no ambiente."
