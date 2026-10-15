// Renderiza o ícone do app (teia roxa + B) em PNG 1024. Uso: electron desktop/make-icon.mjs <saida.png>
import { app, BrowserWindow } from "electron";
import fs from "node:fs";

const polar = (r, i, n) => { const a = (Math.PI * 2 * i) / n - Math.PI / 2; return [512 + r * Math.cos(a), 512 + r * Math.sin(a)]; };
const ring = (r) => Array.from({ length: 10 }, (_, i) => polar(r, i, 10).map((v) => v.toFixed(1)).join(",")).join(" ");
const spokes = Array.from({ length: 10 }, (_, i) => { const [x, y] = polar(420, i, 10); return `<line x1="512" y1="512" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}"/>`; }).join("");
const rings = [110, 200, 290, 380].map((r) => `<polygon points="${ring(r)}"/>`).join("");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#a63ee0"/><stop offset="1" stop-color="#560c82"/></linearGradient>
    <clipPath id="c"><rect x="100" y="100" width="824" height="824" rx="190"/></clipPath>
  </defs>
  <rect x="100" y="100" width="824" height="824" rx="190" fill="url(#g)"/>
  <g clip-path="url(#c)" fill="none" stroke="#fff" stroke-opacity=".16" stroke-width="7" stroke-linejoin="round">${rings}${spokes}</g>
  <text x="512" y="512" text-anchor="middle" dominant-baseline="central" font-family="-apple-system, 'SF Pro Display', 'Helvetica Neue', Arial" font-weight="800" font-size="560" fill="#fff">B</text>
</svg>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, frame: false, transparent: true, webPreferences: { offscreen: true } });
  await win.loadURL("data:text/html," + encodeURIComponent(`<style>html,body{margin:0;background:transparent}</style>${svg}`));
  await new Promise((r) => setTimeout(r, 400));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(process.argv[2], img.resize({ width: 1024, height: 1024 }).toPNG());
  app.quit();
});
