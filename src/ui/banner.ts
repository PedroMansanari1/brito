import fs from "node:fs";
import stringWidth from "string-width";
import { c, cols, mix, palette, stripAnsi, truncAnsi } from "./theme.js";

export interface BannerInfo {
  name: string;
  model: string;
  ctxWindow: number;
  dir: string;
  session: string;
  symbols: number;
  notes: number;
  tools: string[];
  skills: { name: string; scope: string }[];
  agents: string[];
}

const LOGO = [
  "████  ████  █████ █████  ███ ",
  "█   █ █   █   █     █   █   █",
  "████  ████    █     █   █   █",
  "█   █ █  █    █     █   █   █",
  "████  █   █ █████   █    ███ ",
];

/** Arte do lado esquerdo: um pequeno grafo, a identidade do Brito. */
const HERO = [
  "   ◉───────◉───────◉   ",
  "   │ \\   / │ \\   / │   ",
  "   │  ◉────◉───◉  │   ",
  "   │ /   \\ │ /   \\ │   ",
  "   ◉───────◉───────◉   ",
];

const GROUPS: [string, (n: string) => boolean][] = [
  ["arquivos", (n) => ["read_file", "write_file", "edit_file", "glob", "grep"].includes(n)],
  ["shell", (n) => n === "bash"],
  ["grafo", (n) => n.startsWith("graph_")],
  ["memória", (n) => n === "remember" || n === "recall"],
  ["agentes", (n) => n === "delegate"],
  ["skills", (n) => n.startsWith("skill_")],
];

const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - stringWidth(stripAnsi(s))));
const version = () => {
  try { return JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version as string; } catch { return "0.0.0"; }
};
const fmtK = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));

function listLine(label: string, items: string[], width: number): string {
  const head = c.muted(`${label}: `);
  const room = Math.max(10, width - label.length - 2);
  let used = 0;
  const shown: string[] = [];
  for (const it of items) {
    const add = it.length + (shown.length ? 2 : 0);
    if (used + add > room - 5) break;
    shown.push(it);
    used += add;
  }
  const rest = items.length - shown.length;
  return head + c.soft(shown.join(", ")) + (rest > 0 ? c.dim(`  +${rest}`) : "");
}

export function renderBanner(i: BannerInfo): string {
  const total = Math.min(cols(), 110);
  const wide = total >= 95;
  const inner = total - 4;

  const home = process.env.HOME ?? "\0";
  const context = [
    `${c.soft(i.model)} ${c.dim("·")} ${c.muted(`${fmtK(i.ctxWindow)} ctx`)}`,
    c.muted(i.dir.replace(home, "~")),
    c.dim(`sessão ${i.session}`),
  ];

  const leftW = wide ? Math.max(LOGO[0].length, HERO[0].length) + 2 : inner;
  const rightW = wide ? inner - leftW - 3 : inner;

  const left: string[] = [];
  if (wide) {
    LOGO.forEach((l, k) => left.push(c.rgb(mix(palette.accent, palette.soft, k / (LOGO.length - 1)))(l)));
    left.push("");
    HERO.forEach((l) => left.push(l.replace(/[◉]/g, (m) => c.light(m)).replace(/[─│\\/]/g, (m) => c.accent(m))));
    left.push("");
  }
  left.push(...context);

  const right: string[] = [c.bold(c.light("Ferramentas disponíveis"))];
  for (const [label, test] of GROUPS) {
    const names = i.tools.filter(test);
    if (names.length) right.push(listLine(label, names, rightW));
  }
  right.push("", c.bold(c.light("Subagentes")), c.soft(i.agents.join(", ") || "—"));
  right.push("", c.bold(c.light("Skills")));
  if (i.skills.length) {
    const project = i.skills.filter((s) => s.scope === "project").map((s) => s.name);
    const global = i.skills.filter((s) => s.scope === "global").map((s) => s.name);
    if (project.length) right.push(listLine("projeto", project, rightW));
    if (global.length) right.push(listLine("global", global, rightW));
  } else right.push(c.dim("nenhuma ainda · nascem sozinhas após tarefas complexas"));
  right.push("", c.dim(`${i.tools.length} tools · ${i.skills.length} ${i.skills.length === 1 ? "skill" : "skills"} · ${i.symbols} símbolos · ${i.notes} notas · /help`));

  const body: string[] = [];
  if (wide) {
    const n = Math.max(left.length, right.length);
    for (let k = 0; k < n; k++) body.push(pad(left[k] ?? "", leftW) + "   " + (right[k] ?? ""));
  } else body.push(...left, "", ...right);

  const title = ` ${i.name} v${version()} `;
  const top = c.accent("╭─") + c.bold(c.light(title)) + c.accent("─".repeat(Math.max(1, total - title.length - 3)) + "╮");
  const row = (raw: string) => {
    const txt = stringWidth(stripAnsi(raw)) > inner ? truncAnsi(raw, inner) : raw;
    return c.accent("│ ") + pad(txt, inner) + c.accent(" │");
  };
  return [top, ...body.map(row), c.accent("╰" + "─".repeat(total - 2) + "╯")].join("\n");
}
