import { BOLD, CODE, ITALIC, OFF, c, cols, palette, useColor } from "./theme.js";
import type { Dock } from "./dock.js";
import { renderBanner, type BannerInfo } from "./banner.js";
import stringWidth from "string-width";

export const NAME = "Brito";
const isTTY = !!process.stdout.isTTY;

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FACES = ["(｡•́︿•̀｡)", "(⊙_⊙)", "(•̀ᴗ•́)و", "(¬‿¬)", "ʕ•ᴥ•ʔ", "(◕‿◕)", "(・・?)", "(｀･ω･´)"];
const VERBS = ["pensando", "ponderando", "investigando", "mapeando o grafo", "conectando os pontos", "analisando", "rastreando chamadas", "ruminando", "fazendo hipóteses"];
const DONE = ["(•̀ᴗ•́)و", "ヽ(´▽`)/", "(◕‿◕)"];

const EMOJI: Record<string, string> = {
  read_file: "📄", write_file: "📝", edit_file: "📝", glob: "📁", grep: "🔍", bash: "💻",
  remember: "🧠", recall: "🧠", delegate: "🤖", skill_load: "🎓", skill_save: "🎓", skill_delete: "🎓",
};
const emojiOf = (name: string) => EMOJI[name] ?? (name.startsWith("graph_") ? "🔗" : "🔧");

const fmtMs = (ms: number) => (ms < 1000 ? `${(ms / 1000).toFixed(1)}s` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`);
export const fmtTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M` : n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}K` : String(n));

/** Primeiro argumento "legível" da chamada, para a linha da tool. */
function preview(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const v = Object.values(input as Record<string, unknown>).find((x) => typeof x === "string" && x.length > 0) as string | undefined;
  return v ? v.replace(/\s+/g, " ").slice(0, 60) : "";
}

class UI {
  private busy = false;
  private paused = false;
  private visible = false; // spinner desenhado agora
  private timer?: NodeJS.Timeout;
  private t0 = 0;
  private frame = 0;
  private running = new Map<string, { name: string; input: unknown; t0: number }>();
  private textOpen = false;
  private lineStart = true;
  private seed = Math.floor(Math.random() * FACES.length);
  private dock: Dock | null = null;

  /** Com dock, toda saída vai para cima dele e o spinner mora na linha própria do dock. */
  attachDock(d: Dock | null) { this.dock = d; }
  private out(s: string) { if (this.dock) this.dock.write(s); else process.stdout.write(s); }

  // ---------- baixo nível ----------
  private clear() {
    if (this.dock) { this.dock.setSpinner(null); return; }
    if (this.visible && isTTY) { process.stdout.write("\r\x1b[2K"); this.visible = false; }
  }

  private spinnerLabel(): string {
    const secs = (Date.now() - this.t0) / 1000;
    const f = c.light(FRAMES[this.frame % FRAMES.length]);
    if (this.running.size > 0) {
      const names = [...new Set([...this.running.values()].map((r) => r.name))];
      const what = this.running.size === 1 ? names[0] : `${this.running.size} ferramentas`;
      return `${f} ${c.muted(`executando ${what}…`)} ${c.dim(`(${secs.toFixed(1)}s)`)}`;
    }
    const face = FACES[(this.seed + Math.floor(secs / 2)) % FACES.length];
    const verb = VERBS[(this.seed + Math.floor(secs / 3)) % VERBS.length];
    return `${f} ${c.soft(face)} ${c.muted(`${verb}…`)} ${c.dim(`(${secs.toFixed(1)}s)`)}`;
  }

  private draw() {
    if (!isTTY) return;
    const show = this.busy && !this.paused && !this.textOpen;
    if (this.dock) { this.dock.setSpinner(show ? this.spinnerLabel() : null); return; }
    if (!show) return;
    process.stdout.write(`\r\x1b[2K${this.spinnerLabel()}`);
    this.visible = true;
  }

  /** Imprime uma linha sem quebrar o spinner. */
  print(line = "") {
    this.clear();
    this.out(line + "\n");
    this.draw();
  }

  // ---------- ciclo do turno ----------
  turnStart() {
    this.busy = true; this.t0 = Date.now(); this.frame = 0;
    if (isTTY) this.timer = setInterval(() => { this.frame++; this.draw(); }, 90);
    this.draw();
  }
  turnEnd(ok = true) {
    this.textEnd();
    this.busy = false; this.running.clear();
    if (this.timer) clearInterval(this.timer);
    this.clear();
    const secs = (Date.now() - this.t0) / 1000;
    if (ok && this.t0) this.print(c.dim(`${DONE[this.seed % DONE.length]} pronto! (${secs.toFixed(1)}s)`));
  }
  /** Libera o terminal para um prompt interativo (permissão). */
  suspend() { this.paused = true; this.clear(); }
  resume() { this.paused = false; this.draw(); }

  // ---------- resposta do modelo ----------
  private lineW = 0;
  private word = "";
  // markdown em streaming: b=**negrito**, i=*itálico*, k=`código`, fence=bloco ```
  private st = { b: false, i: false, k: false, fence: false };
  private wordStart = "";  // estilo ativo quando a palavra em andamento começou
  private run = { ch: "", n: 0, bol: false }; // sequência pendente de * ou ` (decidida pelo próximo caractere)
  private skip = false;    // descarta o resto da linha do ``` (nome da linguagem)
  private bol = true;      // só espaços até agora nesta linha
  private prev = " ";      // último caractere resolvido

  private seq(): string {
    const { b, i, k, fence } = this.st;
    return k || fence ? CODE : (i ? ITALIC : "") + (b ? BOLD : "");
  }
  private active() { const s = this.st; return s.b || s.i || s.k || s.fence; }

  /** Aplica a mudança de estilo: no meio da palavra vira código ANSI; entre palavras vira o estilo inicial da próxima. */
  private restyle() {
    if (this.word) this.word += OFF + this.seq(); else this.wordStart = this.seq();
  }

  private resetStyle() {
    this.st = { b: false, i: false, k: false, fence: false };
    this.run = { ch: "", n: 0, bol: false };
    this.wordStart = ""; this.skip = false; this.bol = true; this.prev = " ";
  }

  /** Descarrega a palavra em andamento, quebrando a linha antes dela se não couber. */
  private emitWord() {
    if (!this.word) return;
    const w = stringWidth(this.word);
    const room = cols() - 2;
    if (this.lineW > 0 && this.lineW + w > room) { this.out("\n"); this.lineStart = true; this.lineW = 0; }
    if (this.lineStart) { this.out(c.accent("│ ")); this.lineStart = false; }
    // o estilo é reaplicado por palavra: a borda e os espaços não herdam a cor
    this.out(this.wordStart + this.word + (this.active() ? OFF : ""));
    this.lineW += w;
    this.word = "";
    this.wordStart = this.seq();
  }

  /** Decide o que fazer com a sequência pendente de `*`/`` ` `` olhando o próximo caractere. */
  private resolve(next: string) {
    const { ch, n, bol } = this.run;
    this.run = { ch: "", n: 0, bol: false };
    const s = this.st;
    const lit = () => { for (let j = 0; j < n; j++) this.put(ch); };
    if (ch === "`") {
      if (n >= 3 && bol) { s.fence = !s.fence; this.restyle(); this.skip = true; return; }
      if (n <= 2 && !s.fence) { s.k = !s.k; this.restyle(); return; }
      return lit();
    }
    if (n > 3) return lit();
    const keys: ("b" | "i")[] = n === 1 ? ["i"] : n === 2 ? ["b"] : ["b", "i"];
    const nextWs = /\s/.test(next), prevWs = /\s/.test(this.prev);
    if (keys.every((x) => s[x]) && !prevWs) { keys.forEach((x) => (s[x] = false)); this.restyle(); }
    else if (keys.every((x) => !s[x]) && !nextWs && !/[\p{L}\p{N}]/u.test(this.prev)) { keys.forEach((x) => (s[x] = true)); this.restyle(); }
    else lit(); // `2 ** 3`, `a*b`, marcador solto: fica literal
  }

  private feed(ch: string) {
    if (ch === this.run.ch) { this.run.n++; return; }
    if (this.run.n) this.resolve(ch);
    if (this.skip) { if (ch === "\n") this.skip = false; return; }
    const s = this.st;
    const tick = ch === "`" && (!s.fence || this.bol);
    const star = ch === "*" && !s.k && !s.fence;
    if (tick || star) { this.run = { ch, n: 1, bol: this.bol }; return; }
    this.put(ch);
  }

  private put(ch: string) {
    const blank = this.prev === "\n";
    this.prev = ch;
    if (ch === "\n") {
      this.emitWord();
      this.bol = true;
      this.st.k = false; // código inline não atravessa linhas
      if (blank && !this.st.fence) { this.st.b = false; this.st.i = false; } // linha em branco encerra ênfase aberta
      this.wordStart = this.seq();
      this.out((this.lineStart ? c.accent("│") : "") + "\n");
      this.lineStart = true; this.lineW = 0;
    } else if (ch === " ") {
      this.emitWord();
      if (this.lineStart) { this.out(c.accent("│ ")); this.lineStart = false; }
      if (this.lineW + 1 > cols() - 2) { this.out("\n"); this.lineStart = true; this.lineW = 0; }
      else { this.out(" "); this.lineW++; }
    } else { this.word += ch; this.bol = false; }
  }

  /** Texto do modelo em streaming, dentro da caixa, com quebra por palavra e borda em todas as linhas. */
  text(chunk: string) {
    if (!this.textOpen) {
      this.clear();
      const label = ` ${NAME} `;
      this.out(c.accent("╭─") + c.bold(c.light(label)) + c.accent("─".repeat(Math.max(2, cols() - label.length - 2))) + "\n");
      this.textOpen = true; this.lineStart = true; this.lineW = 0; this.word = "";
      this.resetStyle();
    }
    for (const ch of chunk) this.feed(ch);
  }
  textEnd() {
    if (!this.textOpen) return;
    if (this.run.n) this.resolve("\n"); // marcador no fim da resposta: fecha se havia abertura, senão fica literal
    this.emitWord();
    this.resetStyle();
    if (!this.lineStart) this.out("\n");
    this.out(c.accent("╰" + "─".repeat(cols() - 1)) + "\n");
    this.textOpen = false;
    this.draw();
  }

  // ---------- ferramentas ----------
  toolStart(id: string, name: string, input: unknown) { this.running.set(id, { name, input, t0: Date.now() }); this.draw(); }
  toolEnd(id: string, isError: boolean) {
    const r = this.running.get(id);
    if (!r) return;
    this.running.delete(id);
    this.textEnd();
    this.print(this.toolLine(r.name, r.input, Date.now() - r.t0, isError));
  }
  /** Só o prefixo + emoji + nome, sem argumento nem tempo. */
  toolLabel(name: string) { return `${c.accent("┊")} ${emojiOf(name)} ${c.soft(name)}`; }
  toolLine(name: string, input: unknown, ms: number, isError: boolean, indent = "") {
    const arg = preview(input);
    const mark = isError ? c.err("✗") : "";
    return `${indent}${c.accent("┊")} ${emojiOf(name)} ${isError ? c.err(name) : c.soft(name)}${arg ? " " + c.muted(arg) : ""} ${c.dim(`(${fmtMs(ms)})`)} ${mark}`.trimEnd();
  }
  /** Linha de progresso de um subagente (indentada, com o rótulo dele). */
  sub(label: string, text: string) { this.textEnd(); this.print(`  ${c.accent("┊")} ${c.light(`[${label}]`)} ${text}`); }

  info(msg: string) { this.textEnd(); this.print(c.muted(msg)); }
  warn(msg: string) { this.textEnd(); this.print(c.rgb(palette.warn)(msg)); }
  error(msg: string) { this.textEnd(); this.print(c.err(msg)); }

  // ---------- estrutura fixa ----------
  rule() { return c.accent("─".repeat(cols())); }

  /**
   * Barra de status: cada indicador tem um rótulo para quem não conhece os números.
   * Se não couber na largura do terminal, descarta primeiro os de menor prioridade (tempo, extra, tokens…).
   */
  statusLine(s: { model: string; ctxTokens: number; ctxWindow: number; input: number; output: number; cacheRead?: number; startedAt: number; extra?: string; cost?: number; mode?: string }) {
    const pct = Math.min(100, Math.round((s.ctxTokens / s.ctxWindow) * 100));
    const slots = 8, filled = Math.round((pct / 100) * slots);
    const colour = pct >= 95 ? c.err : pct >= 80 ? c.rgb(palette.orange) : pct >= 50 ? c.warn : c.ok;
    const bar = colour("█".repeat(filled)) + c.dim("░".repeat(slots - filled));
    const mins = Math.floor((Date.now() - s.startedAt) / 60_000);
    const label = (t: string) => c.dim(t + " ");
    // Taxa de acerto do cache de prompt (quanto mais alta, mais barato): só aparece quando há dado, como no Hermes.
    const hit = s.cacheRead && s.input > 0 ? Math.min(100, (s.cacheRead / s.input) * 100) : undefined;
    const hitColour = hit === undefined ? c.muted : hit >= 70 ? c.ok : hit >= 40 ? c.warn : c.err;

    // [prioridade (maior = descarta primeiro), texto]
    const segs: [number, string][] = [
      ...(s.mode ? [[0, s.mode] as [number, string]] : []),
      [0, c.light("⬢ ") + c.bold(c.soft(s.model))],
      [0, label("contexto") + c.muted(`${fmtTokens(s.ctxTokens)}/${fmtTokens(s.ctxWindow)}`) + ` [${bar}] ${colour(`${pct}%`)}`],
      ...(hit !== undefined ? [[2, label("cache") + hitColour(`◎ ${Math.round(hit)}%`)] as [number, string]] : []),
      [3, label("tokens") + c.muted(`↑${fmtTokens(s.input)} ↓${fmtTokens(s.output)}`)],
      ...(s.cost !== undefined ? [[1, label("custo") + c.muted(`$${s.cost.toFixed(2)}`)] as [number, string]] : []),
      [4, label("tempo") + c.muted(mins < 1 ? "<1m" : `${mins}m`)],
      ...(s.extra ? [[5, c.muted(s.extra)] as [number, string]] : []),
    ];
    const sep = c.accent(" │ ");
    const render = () => segs.map(([, t]) => t).join(sep);
    while (segs.length > 2 && stringWidth(render()) > cols()) {
      const worst = segs.reduce((w, x, i) => (x[0] > segs[w][0] ? i : w), 0);
      if (segs[worst][0] === 0) break;
      segs.splice(worst, 1);
    }
    return render();
  }

  /** Legenda dos indicadores (comando /indicadores). */
  statusLegend(): string[] {
    return [
      ["contexto", "tokens que o modelo está lendo agora / tamanho máximo da janela. Perto de 100% a conversa precisa ser compactada."],
      ["cache", "% do prompt reaproveitado do cache (◎). Alto (verde) = respostas mais rápidas e baratas. Some enquanto não há dado."],
      ["tokens", "total da sessão: ↑ enviados ao modelo (inclui cache) · ↓ gerados por ele."],
      ["custo", "gasto estimado da sessão em dólares."],
      ["tempo", "há quanto tempo a sessão está aberta."],
    ].map(([k, v]) => `  ${c.soft(k.padEnd(9))} ${c.muted(v)}`);
  }

  banner(info: BannerInfo) { this.out(renderBanner(info) + "\n"); }
}

export const ui = new UI();
export { c, useColor };
export type { BannerInfo };
