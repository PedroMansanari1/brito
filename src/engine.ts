import { MODEL_ALIASES, loadProfiles } from "./model.js";
import { missingKeyMessage } from "./provider/openai-compat.js";
import { resolveModel } from "./provider/resolve.js";

export type Engine = { kind: "api" } | { kind: "claude" } | { kind: "error"; message: string };

/** O fallback é sempre este perfil de `providers` (não configurável). */
export const FALLBACK_PROFILE = "qwen";

export type FallbackStatus =
  | { ready: true; name: typeof FALLBACK_PROFILE; label: string }
  | { ready: false; reason: string; label?: string };

/**
 * Pronto só se o perfil existe, é válido, tem a chave no ambiente e o principal não é ele mesmo. Relê o config a
 * cada chamada, como os perfis.
 */
export function fallbackStatus(primary: string, env: NodeJS.ProcessEnv): FallbackStatus {
  const { profiles, errors, rejected } = loadProfiles();
  const p = profiles[FALLBACK_PROFILE];
  const label = p?.label;
  if (primary.trim().toLowerCase() === FALLBACK_PROFILE) return { ready: false, reason: "o modelo principal já é o qwen", label };
  if (rejected.includes(FALLBACK_PROFILE)) {
    const why = errors.find((e) => e.toLowerCase().includes(`"${FALLBACK_PROFILE}"`)) ?? "";
    return { ready: false, reason: `o perfil "${FALLBACK_PROFILE}" em ~/.brito/config.json está inválido (${why})` };
  }
  if (!p) return { ready: false, reason: `sem perfil "${FALLBACK_PROFILE}" em providers no ~/.brito/config.json` };
  if (!env[p.apiKeyEnv]?.trim()) return { ready: false, reason: missingKeyMessage(p), label };
  return { ready: true, name: FALLBACK_PROFILE, label: p.label };
}

/** Modelo padrão do subagente `explore` no Claude: rápido e barato. */
export const EXPLORE_DEFAULT = MODEL_ALIASES.haiku;

/**
 * Qual motor atende o modelo: perfil de endpoint → loop próprio (modo API), sem olhar a Anthropic nem o claude CLI.
 * Claude → a regra de sempre: com ANTHROPIC_API_KEY, API direta; sem ela, o `claude` oficial (assinatura).
 */
export function pickEngine(model: string, env: NodeJS.ProcessEnv, hasCli: () => boolean): Engine {
  const r = resolveModel(model);
  const name = model.trim().toLowerCase();
  if (r.kind === "anthropic" && loadProfiles().rejected.includes(name)) {
    const why = loadProfiles().errors.find((e) => e.toLowerCase().includes(`"${name}"`)) ?? "";
    return { kind: "error", message: `o perfil "${name}" em ~/.brito/config.json está inválido (${why}); corrija antes de usar` };
  }
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

/** Modelo da reflexão/consolidação de skills: BRITO_LEARN_MODEL, salvo se ele levaria a conta à Anthropic com um perfil ativo. */
export function learnerModel(live: string, env: NodeJS.ProcessEnv): string {
  const wanted = env.BRITO_LEARN_MODEL;
  if (!wanted) return live;
  return resolveModel(live).kind === "openai" && resolveModel(wanted).kind === "anthropic" ? live : wanted;
}
