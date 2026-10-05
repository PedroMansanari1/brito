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

/** Grava `model` no config global preservando as demais chaves. */
export function saveModel(model: string): void {
  let cfg: Record<string, unknown> = {};
  try { cfg = JSON.parse(readFileSync(configPath(), "utf8")) ?? {}; } catch { /* config novo ou ilegível */ }
  mkdirSync(dirname(configPath()), { recursive: true });
  writeFileSync(configPath(), JSON.stringify({ ...cfg, model }, null, 2) + "\n");
}

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
