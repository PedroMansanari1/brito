import { MODEL_ALIASES } from "./model.js";
import { missingKeyMessage } from "./provider/openai-compat.js";
import { resolveModel } from "./provider/resolve.js";

export type Engine = { kind: "api" } | { kind: "claude" } | { kind: "error"; message: string };

/** Modelo padrão do subagente `explore` no Claude: rápido e barato. */
export const EXPLORE_DEFAULT = MODEL_ALIASES.haiku;

/**
 * Qual motor atende o modelo: perfil de endpoint → loop próprio (modo API), sem olhar a Anthropic nem o claude CLI.
 * Claude → a regra de sempre: com ANTHROPIC_API_KEY, API direta; sem ela, o `claude` oficial (assinatura).
 */
export function pickEngine(model: string, env: NodeJS.ProcessEnv, hasCli: () => boolean): Engine {
  const r = resolveModel(model);
  if (r.kind === "openai") return env[r.profile!.apiKeyEnv]?.trim() ? { kind: "api" } : { kind: "error", message: missingKeyMessage(r.profile!) };
  if (env.ANTHROPIC_API_KEY) return { kind: "api" };
  if (hasCli()) return { kind: "claude" };
  return { kind: "error", message: "Defina ANTHROPIC_API_KEY ou instale o Claude Code e rode `claude` → /login." };
}

/**
 * Modelo de um subagente. BRITO_EXPLORE_MODEL manda no `explore`. Com o agente principal num endpoint, subagente
 * que pediria um Claude fica no modelo do principal (senão a conta da Anthropic voltaria a ser usada em silêncio).
 */
export function subagentModel(def: { name: string; model?: string }, parent: string, env: NodeJS.ProcessEnv): string {
  if (def.name === "explore" && env.BRITO_EXPLORE_MODEL) return env.BRITO_EXPLORE_MODEL;
  const wanted = def.model ?? (def.name === "explore" ? EXPLORE_DEFAULT : undefined);
  if (resolveModel(parent).kind === "openai" && (!wanted || resolveModel(wanted).kind === "anthropic")) return parent;
  return wanted ?? parent;
}
