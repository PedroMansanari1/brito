import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import stringWidth from "string-width";
import { renderBanner, type BannerInfo } from "../src/ui/banner.js";
import { stripAnsi } from "../src/ui/theme.js";
import { LOGO, WEB_H, WEB_W, webLogo } from "../src/ui/web-art.js";

const INFO: BannerInfo = {
  name: "Brito", model: "claude-opus-5-5", ctxWindow: 200000, dir: "/tmp/x", session: "abc123", symbols: 10, notes: 1,
  tools: ["read_file", "bash", "graph_search", "remember", "delegate", "skill_load"], skills: [], agents: ["explore", "plan"],
};

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Janela de cols x rows (rows indefinido = sem TTY, como nos testes) e BRITO_BANNER opcional. */
function withSize<T>(cols: number, rows: number | undefined, fn: () => T, banner?: string): T {
  const prevCols = process.stdout.columns, prevRows = process.stdout.rows, prevEnv = process.env.BRITO_BANNER;
  process.stdout.columns = cols;
  (process.stdout as { rows?: number }).rows = rows;
  if (banner === undefined) delete process.env.BRITO_BANNER; else process.env.BRITO_BANNER = banner;
  try { return fn(); } finally {
    process.stdout.columns = prevCols;
    (process.stdout as { rows?: number }).rows = prevRows;
    if (prevEnv === undefined) delete process.env.BRITO_BANNER; else process.env.BRITO_BANNER = prevEnv;
  }
}
const withCols = <T>(n: number, fn: () => T) => withSize(n, undefined, fn);

test("webLogo: grade WEB_W x WEB_H, toda linha com a mesma largura visível", () => {
  const rows = webLogo().map(stripAnsi);
  assert.equal(rows.length, WEB_H);
  for (const r of rows) assert.equal(stringWidth(r), WEB_W, JSON.stringify(r));
});

test("webLogo: o nome BRITO aparece inteiro, centralizado, com a teia (nós e traços) em volta", () => {
  const rows = webLogo().map(stripAnsi);
  const top = Math.floor((WEB_H - LOGO.length) / 2);
  const left = Math.floor((WEB_W - LOGO[0].length) / 2);
  LOGO.forEach((l, r) => {
    for (let x = 0; x < l.length; x++) if (l[x] === "█") assert.equal(rows[top + r][left + x], "█", `letra em ${r},${x}`);
  });
  const text = rows.join("\n");
  assert.ok(text.includes("◉") && text.includes("○"), "nós");
  assert.ok(/[─│╱╲]/.test(rows[0] + rows[1] + rows[WEB_H - 1]), "traços acima e abaixo do nome");
  assert.ok(!/[─│╱╲·]/.test(rows[top + 1].slice(left, left + LOGO[0].length)), "sem traço solto dentro das letras");
});

test("banner largo: arte à esquerda, painel à direita, nenhuma linha passa da largura", () => {
  const out = withCols(110, () => renderBanner(INFO)).split("\n").map(stripAnsi);
  assert.ok(out.some((l) => l.includes("████")), "logotipo");
  assert.ok(out.some((l) => l.includes("◉")), "teia");
  assert.ok(out.some((l) => l.includes("Ferramentas disponíveis")));
  for (const l of out) assert.ok(stringWidth(l) <= 110, `${stringWidth(l)}: ${l}`);
  const widths = new Set(out.map((l) => stringWidth(l)));
  assert.equal(widths.size, 1, "a moldura fecha na mesma coluna em toda linha");
});

test("banner estreito: sem arte, só o painel", () => {
  const out = withCols(70, () => renderBanner(INFO));
  assert.ok(!out.includes("████") && !out.includes("◉"));
  assert.ok(out.includes("Ferramentas disponíveis"));
});

const plain = (out: string) => out.split("\n").map(stripAnsi);

test("tela cheia: a teia ocupa a janela inteira (largura e altura) e a moldura fecha em toda linha", () => {
  for (const [cols, rows] of [[110, 36], [100, 30], [190, 46]]) {
    const out = plain(withSize(cols, rows, () => renderBanner(INFO)));
    assert.equal(out.length, rows - 5, `${cols}x${rows}: altura`); // sobra o espaço do dock embaixo
    for (const l of out) assert.equal(stringWidth(l), cols, `${cols}x${rows}: ${l}`);
    const text = out.join("\n");
    assert.ok(text.includes("◉") && text.includes("○") && /[─│╱╲]/.test(text) && text.includes("·"), "nós, traços e raios");
    assert.ok(text.includes("████  ████  █████ █████  ███"), "o nome");
  }
});

test("tela cheia: o nome não leva traço da teia dentro das letras e o painel aparece inteiro por cima", () => {
  const out = plain(withSize(120, 40, () => renderBanner(INFO)));
  const first = out.findIndex((l) => l.includes("████  ████  █████ █████  ███"));
  assert.ok(first > 0);
  const left = out[first].indexOf("████");
  for (let r = 0; r < LOGO.length; r++) {
    const span = out[first + r].slice(left, left + LOGO[0].length);
    assert.ok(!/[─│╱╲·]/.test(span), `traço dentro do nome na linha ${r}: ${span}`);
  }
  const text = out.join("\n");
  for (const s of ["read_file, bash", "claude-opus-5-5", "subagentes: explore, plan", "nenhuma ainda", "6 tools"]) {
    if (s === "read_file, bash") assert.ok(text.includes("arquivos: read_file") && text.includes("shell: bash"));
    else assert.ok(text.includes(s), s);
  }
});

test("janela baixa, sem TTY ou BRITO_BANNER=compact: banner compacto; =full força a tela cheia", () => {
  const compactHeading = "Ferramentas disponíveis";
  assert.ok(plain(withSize(120, 20, () => renderBanner(INFO))).join("\n").includes(compactHeading), "poucas linhas");
  assert.ok(plain(withSize(120, undefined, () => renderBanner(INFO))).join("\n").includes(compactHeading), "sem TTY");
  assert.ok(plain(withSize(120, 50, () => renderBanner(INFO), "compact")).join("\n").includes(compactHeading), "compact");
  assert.ok(!plain(withSize(120, 50, () => renderBanner(INFO))).join("\n").includes(compactHeading), "janela grande abre a tela cheia");
  assert.ok(!plain(withSize(120, 20, () => renderBanner(INFO), "full")).join("\n").includes(compactHeading), "full");
});

test("a arte só usa roxo (nada de laranja): toda cor tem verde abaixo do vermelho e do azul", { timeout: 60_000 }, () => {
  const code = `const { renderBanner } = await import("./src/ui/banner.ts");
    process.stdout.columns = 110; process.stdout.rows = 36;
    console.log(renderBanner(${JSON.stringify(INFO)}));`;
  const r = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
    cwd: REPO, encoding: "utf8", env: { ...process.env, FORCE_COLOR: "1", COLORTERM: "truecolor", NO_COLOR: "" },
  });
  assert.equal(r.status, 0, r.stderr);
  const colors = [...r.stdout.matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g)].map((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);
  assert.ok(colors.length > 50, "tem cor");
  for (const [R, G, B] of colors) assert.ok(G < R && G < B, `cor fora do roxo: rgb(${R},${G},${B})`);
});
