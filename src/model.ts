import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Atalhos para os modelos atuais (o Hermes resolve aliases antes de validar o nome). */
export const MODEL_ALIASES: Record<string, string> = {
  fable: "claude-fable-5-1",
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
  haiku: "claude-haiku-4-5-20251001",
};

export const DEFAULT_MODEL = MODEL_ALIASES.sonnet;

/** once = só o próximo turno · session = esta sessão · global = grava no config */
export type ModelScope = "once" | "session" | "global";

export interface ModelRequest {
  /** vazio = só mostrar o modelo atual */
  model: string;
  scope: ModelScope;
  errors: string[];
}

const configPath = () => process.env.BRITO_CONFIG ?? join(homedir(), ".brito", "config.json");

export function loadSavedModel(): string | undefined {
  try {
    const m = JSON.parse(readFileSync(configPath(), "utf8"))?.model;
    return typeof m === "string" && m.trim() ? m.trim() : undefined;
  } catch { return undefined; }
}

/** Grava `patch` no config global preservando as demais chaves. */
function saveConfig(patch: Record<string, unknown>): void {
  let cfg: Record<string, unknown> = {};
  try { cfg = JSON.parse(readFileSync(configPath(), "utf8")) ?? {}; } catch { /* config novo ou ilegível */ }
  mkdirSync(dirname(configPath()), { recursive: true });
  writeFileSync(configPath(), JSON.stringify({ ...cfg, ...patch }, null, 2) + "\n");
}

export const saveModel = (model: string) => saveConfig({ model });

/**
 * Escada de esforço do Hermes (EFFORT_LADDER, do mais fraco ao mais forte). `none` desliga o raciocínio;
 * `minimal` e `ultra` são internos: o claude CLI não os aceita, então `clampEffort` os mapeia.
 */
export const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type Effort = (typeof EFFORTS)[number];
export const isEffort = (s: unknown): s is Effort => (EFFORTS as readonly unknown[]).includes(s);

/** Níveis que o `claude --effort` aceita. */
export const CLAUDE_EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

/**
 * Igual ao clamp_effort do Hermes: passa direto se suportado; senão o nível suportado MAIS FRACO mais próximo
 * (nunca escala o custo); se não há mais fraco, o mais fraco suportado. `none` nunca é alvo de degradação.
 */
export function clampEffort(requested: Effort, supported: readonly Effort[] = CLAUDE_EFFORTS): Effort {
  if (supported.includes(requested)) return requested;
  const rank = (e: Effort) => EFFORTS.indexOf(e);
  const cands = supported.filter((e) => e !== "none").sort((a, b) => rank(a) - rank(b));
  if (!cands.length) return requested;
  const weaker = cands.filter((e) => rank(e) < rank(requested));
  return weaker.length ? weaker[weaker.length - 1] : cands[0];
}

/** O que mandar ao claude CLI: `thinking:false` = raciocínio desligado (MAX_THINKING_TOKENS=0), sem `--effort`. */
export function wireEffort(level: string): { effort?: Effort; thinking: boolean } {
  if (!isEffort(level)) return { thinking: true };
  if (level === "none") return { thinking: false };
  return { effort: clampEffort(level), thinking: true };
}

/** Rótulo do `/reasoning`: o nível, ou `"<nível> (envia <x> no claude CLI)"` quando ele é remapeado. */
export function effortLabel(level: string): string {
  if (!isEffort(level)) return level || "padrão";
  if (level === "none") return "none (raciocínio desligado)";
  const sent = clampEffort(level);
  return sent === level ? level : `${level} (envia ${sent} no claude CLI)`;
}

/** Exibição do raciocínio (`/reasoning show|hide|full|clamp`); padrão do Hermes: mostrar, recortado. */
export interface ReasoningDisplay { show: boolean; full: boolean }

export function loadReasoningDisplay(): ReasoningDisplay {
  try {
    const d = JSON.parse(readFileSync(configPath(), "utf8"))?.display;
    return { show: d?.show_reasoning !== false, full: d?.reasoning_full === true };
  } catch { return { show: true, full: false }; }
}

export function saveReasoningDisplay(patch: Partial<ReasoningDisplay>): void {
  let cfg: Record<string, any> = {};
  try { cfg = JSON.parse(readFileSync(configPath(), "utf8")) ?? {}; } catch { /* config novo ou ilegível */ }
  const display = { ...(cfg.display ?? {}) };
  if (patch.show !== undefined) display.show_reasoning = patch.show;
  if (patch.full !== undefined) display.reasoning_full = patch.full;
  saveConfig({ display });
}

export function loadSavedEffort(): Effort | undefined {
  try {
    const e = JSON.parse(readFileSync(configPath(), "utf8"))?.effort;
    return isEffort(e) ? e : undefined;
  } catch { return undefined; }
}

/** `undefined` remove o esforço salvo (volta ao padrão do claude). */
export const saveEffort = (effort: Effort | undefined) => saveConfig({ effort });

/** Prioridade: BRITO_EFFORT (válido) > config global > padrão (""). */
export const initialEffort = (): string => {
  const env = process.env.BRITO_EFFORT?.trim().toLowerCase();
  return (isEffort(env) ? env : undefined) ?? loadSavedEffort() ?? "";
};

/** Prioridade: BRITO_MODEL > config global > padrão. */
export const initialModel = () => process.env.BRITO_MODEL ?? loadSavedModel() ?? DEFAULT_MODEL;

export const resolveModelAlias = (name: string) => MODEL_ALIASES[name.toLowerCase()] ?? name;

/** Parser único do `/model`: flags + validação de conflito, igual ao parse_model_switch_args do Hermes. */
export function parseModelArgs(raw: string): ModelRequest {
  // Mobile/teclados convertem `--` em travessão: normaliza antes de ler as flags.
  const text = raw.replace(/[‒-―](global|session|once)/g, "--$1");
  const flags = new Set<string>();
  const words: string[] = [];
  for (const tok of text.split(/\s+/).filter(Boolean)) {
    if (tok === "--global" || tok === "--session" || tok === "--once") flags.add(tok.slice(2));
    else words.push(tok);
  }
  const errors: string[] = [];
  const model = words.join(" ");
  if (flags.has("once") && flags.has("global")) errors.push("/model --once não combina com --global");
  if (flags.has("once") && !model) errors.push("/model --once precisa de um modelo");
  // Primeira flag que vale: once > session > global > padrão (sessão).
  const scope: ModelScope = flags.has("once") ? "once" : flags.has("global") && !flags.has("session") ? "global" : "session";
  return { model: model ? resolveModelAlias(model) : "", scope, errors };
}

/** Texto de ajuda mostrado por `/model` sem argumentos. */
export const MODEL_HELP =
  "uso: /model <nome|alias> [--global|--session|--once]  (aliases: " + Object.keys(MODEL_ALIASES).join(", ") + ")";
