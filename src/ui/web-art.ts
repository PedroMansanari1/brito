import { RESET, c, mix, palette, type RGB } from "./theme.js";

/**
 * A identidade visual do Brito: uma teia (raios + anéis em polígono, com nós nos cruzamentos), meio grafo, com o nome
 * por cima. É gerada em vez de desenhada à mão para servir a qualquer tamanho de janela e os traços ficarem alinhados.
 * Só usa tons derivados do roxo da marca (BRITO_COLOR): claro no centro, escurecendo até a borda.
 */
export const LOGO = [
  "████  ████  █████ █████  ███ ",
  "█   █ █   █   █     █   █   █",
  "████  ████    █     █   █   █",
  "█   █ █  █    █     █   █   █",
  "████  █   █ █████   █    ███ ",
];

/** Tamanho da teia do banner compacto. */
export const WEB_W = 33;
export const WEB_H = 13;

export type Kind = "strand" | "node" | "text" | "empty";
export interface Cell { ch: string; kind: Kind; paint?: (s: string) => string }
export interface WebOpts { rings: number; spokes: number }

const blank = (): Cell => ({ ch: " ", kind: "empty" });
const paintOf = (col: RGB) => c.rgb(col);

/** Caractere de um segmento inteiro, pelo ângulo visual (a célula tem ~2x mais altura que largura): evita ─╱╲ misturados. */
function strand(x0: number, y0: number, x1: number, y1: number): string {
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0) * 2;
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  if (angle < 25) return "─";
  if (angle > 65) return "│";
  return (x1 - x0) * (y1 - y0) > 0 ? "╲" : "╱";
}

/** Traço de a até b (Bresenham) com um caractere só; só preenche célula vazia, então o que veio antes prevalece. */
function line(grid: Cell[][], x0: number, y0: number, x1: number, y1: number, ch: string, paintAt: (x: number, y: number) => (s: string) => string) {
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy, x = x0, y = y0;
  while (x !== x1 || y !== y1) {
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
    if (grid[y]?.[x]?.kind === "empty") grid[y][x] = { ch, kind: "strand", paint: paintAt(x, y) };
  }
}

/** A teia crua de w x h células, centrada: anéis sólidos, raios pontilhados e nós nos cruzamentos. */
export function webCanvas(w: number, h: number, { rings, spokes }: WebOpts): Cell[][] {
  const grid: Cell[][] = Array.from({ length: h }, () => Array.from({ length: w }, blank));
  const cx = (w - 1) / 2, cy = (h - 1) / 2;
  const vertex = (k: number, f: number): [number, number] => {
    const a = (2 * Math.PI * k) / spokes;
    return [Math.round(cx + cx * f * Math.cos(a)), Math.round(cy + cy * f * Math.sin(a))];
  };
  /** 0 no centro, 1 na borda. */
  const dist = (x: number, y: number) => Math.min(1, Math.hypot((x - cx) / Math.max(1, cx), (y - cy) / Math.max(1, cy)));
  const ringPaint = (x: number, y: number) => paintOf(mix(palette.light, palette.accent, Math.pow(dist(x, y), 0.8)));
  const spokePaint = (x: number, y: number) => paintOf(mix(palette.soft, palette.accent, 0.35 + 0.65 * dist(x, y)));

  for (let i = 1; i <= rings; i++) {
    const f = i / rings;
    for (let k = 0; k < spokes; k++) {
      const [x0, y0] = vertex(k, f), [x1, y1] = vertex((k + 1) % spokes, f);
      line(grid, x0, y0, x1, y1, strand(x0, y0, x1, y1), ringPaint);
    }
  }
  for (let k = 0; k < spokes; k++) { const [x, y] = vertex(k, 1); line(grid, Math.round(cx), Math.round(cy), x, y, "·", spokePaint); }
  for (let i = 1; i <= rings; i++) {
    for (let k = 0; k < spokes; k++) {
      const [x, y] = vertex(k, i / rings);
      grid[y][x] = { ch: i === rings ? "◉" : "○", kind: "node", paint: paintOf(mix(palette.soft, palette.accent, 0.15 + 0.7 * dist(x, y))) };
    }
  }
  grid[Math.round(cy)][Math.round(cx)] = { ch: "◉", kind: "node", paint: paintOf(palette.soft) };
  return grid;
}

/** O nome por cima da teia. Na faixa das letras os traços somem (só os nós aparecem pelos vãos): o nome fica nítido. */
export function stampLogo(grid: Cell[][], left: number, top: number): void {
  LOGO.forEach((l, r) => {
    const row = grid[top + r];
    if (!row) return;
    const first = l.search(/\S/), last = l.search(/\s*$/) - 1;
    for (let x = first - 1; x <= last + 1; x++) if (row[left + x]?.kind === "strand") row[left + x] = blank();
    for (let x = 0; x < l.length; x++) {
      if (l[x] !== " " && row[left + x]) row[left + x] = { ch: l[x], kind: "text", paint: paintOf(mix(palette.accent, palette.soft, r / (LOGO.length - 1))) };
    }
  });
}

/** Uma linha já colorida (ANSI) vira células: o que a cor não alcança fica sem pintura. */
function ansiCells(s: string): Cell[] {
  const out: Cell[] = [];
  let prefix = "";
  for (const part of s.split(/(\x1b\[[0-9;]*m)/)) {
    if (!part) continue;
    if (part.startsWith("\x1b[")) { prefix = part === RESET ? "" : prefix + part; continue; }
    const p = prefix;
    for (const ch of part) out.push({ ch, kind: "text", paint: p ? (t) => p + t + RESET : undefined });
  }
  return out;
}

/** Escreve texto sobre a teia; a faixa da linha (mais 1 coluna de cada lado) é limpa para o texto ler bem. */
export function overlayText(grid: Cell[][], x: number, y: number, ansi: string): void {
  const row = grid[y];
  if (!row) return;
  const cells = ansiCells(ansi);
  for (let k = -1; k <= cells.length; k++) if (row[x + k]) row[x + k] = blank();
  cells.forEach((cell, k) => { if (row[x + k]) row[x + k] = cell; });
}

export const serialize = (grid: Cell[][]): string[] => grid.map((row) => row.map((cell) => (cell.paint ? cell.paint(cell.ch) : cell.ch)).join(""));

/** O logotipo do banner compacto: BRITO sobre uma teia pequena. */
export function webLogo(): string[] {
  const grid = webCanvas(WEB_W, WEB_H, { rings: 3, spokes: 8 });
  stampLogo(grid, Math.floor((WEB_W - LOGO[0].length) / 2), Math.round((WEB_H - 1) / 2) - Math.floor(LOGO.length / 2));
  return serialize(grid);
}
