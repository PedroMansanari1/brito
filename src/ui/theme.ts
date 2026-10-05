export type RGB = [number, number, number];

const hex = (h: string): RGB => {
  const m = h.replace("#", "").match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) throw new Error(`cor inválida: ${h}`);
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
};
export const mix = (a: RGB, b: RGB, t: number): RGB => a.map((v, i) => Math.round(v + (b[i] - v) * t)) as RGB;

/** Cor da marca. Troque com BRITO_COLOR=#rrggbb. */
const BASE = hex(process.env.BRITO_COLOR ?? "#8119bd");

export const useColor = !process.env.NO_COLOR && (!!process.env.FORCE_COLOR || !!process.stdout.isTTY);
const truecolor = /truecolor|24bit/i.test(process.env.COLORTERM ?? "");

const to256 = ([r, g, b]: RGB) => 16 + 36 * Math.round((r / 255) * 5) + 6 * Math.round((g / 255) * 5) + Math.round((b / 255) * 5);
const fgSeq = (c: RGB) => (truecolor ? `\x1b[38;2;${c[0]};${c[1]};${c[2]}m` : `\x1b[38;5;${to256(c)}m`);

export const RESET = "\x1b[0m";
const wrap = (open: string) => (s: string) => (useColor ? `${open}${s}${RESET}` : s);
const fg = (c: RGB) => wrap(fgSeq(c));

/** O roxo #8119bd é escuro: bordas e barras usam a cor pura; textos e rótulos usam o tom claro. */
export const palette = {
  accent: BASE,
  light: mix(BASE, [255, 255, 255], 0.45),
  soft: mix(BASE, [255, 255, 255], 0.7),
  muted: mix(BASE, [128, 128, 128], 0.55),
  ok: hex("#4caf50"),
  warn: hex("#ffa726"),
  orange: hex("#ff7043"),
  err: hex("#ef5350"),
};

export const c = {
  accent: fg(palette.accent),
  light: fg(palette.light),
  soft: fg(palette.soft),
  muted: fg(palette.muted),
  ok: fg(palette.ok),
  warn: fg(palette.warn),
  err: fg(palette.err),
  bold: wrap("\x1b[1m"),
  dim: wrap("\x1b[2m"),
  rgb: (col: RGB) => fg(col),
};

export const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
export const cols = () => Math.max(40, Math.min(process.stdout.columns || 80, 120));

/** Corta uma string com ANSI para no máximo `n` colunas visíveis, preservando as cores. */
export function truncAnsi(s: string, n: number): string {
  let out = "", vis = 0;
  for (let i = 0; i < s.length; i++) {
    const m = s.slice(i).match(/^\x1b\[[0-9;]*m/);
    if (m) { out += m[0]; i += m[0].length - 1; continue; }
    if (vis >= n - 1 && stripAnsi(s).length > n) return out + "…" + (useColor ? RESET : "");
    out += s[i]; vis++;
  }
  return out;
}
