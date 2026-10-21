import Anthropic from "@anthropic-ai/sdk";
import { FALLBACK_PROFILE, type FallbackStatus } from "../engine.js";

/** Por que o Claude falhou. Só `other` (erro de conteúdo, bug, interrupção) não troca para o qwen. */
export type FailureKind = "quota" | "rate_limit" | "overloaded" | "auth" | "network" | "other";

export const triggersFallback = (k: FailureKind) => k !== "other";

/**
 * Classifica um erro da API da Anthropic (já depois dos retries do SDK). Na dúvida, `other`: melhor não trocar do que
 * esconder um bug atrás do qwen.
 */
export function classifyAnthropicError(e: unknown): FailureKind {
  if (e instanceof Anthropic.APIUserAbortError || (e as { name?: string })?.name === "AbortError") return "other";
  if (e instanceof Anthropic.APIConnectionError) return "network"; // inclui APIConnectionTimeoutError
  if (!(e instanceof Anthropic.APIError)) return "other";
  const status = e.status ?? 0;
  const type = e.type ?? "";
  if (status === 429 || type === "rate_limit_error") return "rate_limit";
  if (status === 402 || type === "billing_error" || (status === 400 && /credit balance is too low/i.test(e.message))) return "quota";
  if (status === 401 || status === 403 || type === "authentication_error" || type === "permission_error") return "auth";
  if (type === "timeout_error") return "network";
  if (status === 529 || status >= 500 || type === "overloaded_error") return "overloaded";
  return "other";
}

/** Primeira linha do erro, curta, para o aviso e o `/fallback`. */
export const shortError = (e: unknown, max = 120): string => {
  const line = String((e as { message?: string })?.message ?? e).split("\n")[0].trim();
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
};

/**
 * Estado do fallback Claude → qwen numa sessão. Uma troca por sessão (como o Hermes); só o `/model` desfaz.
 * Funções puras: quem monta o backend guarda o objeto e chama as transições.
 */
export interface FallbackState {
  /** modelo principal no início (ou o último escolhido via /model) */
  primary: string;
  /** true depois da troca automática */
  active: boolean;
  /** mensagem do erro que causou a troca */
  reason?: string;
  /** quando trocou (ms desde a época) */
  at?: number;
}

export const newFallbackState = (primary: string): FallbackState => ({ primary, active: false });

/** `/model <x>` é escolha explícita: vira o principal e desfaz o fallback (inclusive `/model qwen`). */
export function chooseModel(s: FallbackState, model: string): void {
  s.primary = model;
  s.active = false;
  s.reason = undefined;
  s.at = undefined;
}

/** A troca automática aconteceu. */
export function activateFallback(s: FallbackState, reason: string, at = Date.now()): void {
  s.active = true;
  s.reason = reason;
  s.at = at;
}

/**
 * Modelo a devolver depois de um turno com `/model --once`. O `--once` zera o fallback, então `active` no fim do turno
 * quer dizer que a troca aconteceu durante ele: aí o `restore` é descartado (voltaria ao Claude que acabou de cair).
 */
export const onceRestore = (restore: string | null, fallbackActive: boolean): string | null => (fallbackActive ? null : restore);

const hhmm = (ms: number) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

/**
 * Linhas do `/fallback`. Principal = o modelo vivo, salvo com o fallback ativo (aí é o principal original e o qwen
 * aparece em uso). `status` vem de `fallbackStatus(state.primary, env)`; `engineLabel` é o motor do principal.
 */
export function renderFallback(state: FallbackState, liveModel: string, engineLabel: string, status: FallbackStatus): string[] {
  const primary = state.active ? state.primary : liveModel;
  const name = status.label ?? "—";
  const self = !state.active && primary.trim().toLowerCase() === FALLBACK_PROFILE;
  const fb = state.active ? `${name}  qwen · ~/.brito/config.json  ● em uso`
    : status.ready ? `${name}  qwen · ~/.brito/config.json  ✓ pronto`
    : self ? `${name}  — o modelo principal já é o qwen`
    : `${name}  ✗ ${status.reason}`;
  const estado = state.active ? `ATIVO desde ${hhmm(state.at ?? Date.now())} — Claude falhou: ${state.reason ?? "?"}. /model <claude> para voltar`
    : status.ready ? "inativo — troca automática se o Claude falhar por limite, crédito, auth ou sobrecarga"
    : self ? "não se aplica"
    : "indisponível — sem troca automática nesta sessão";
  return [`  principal  ${primary}  (${engineLabel})`, `  fallback   ${fb}`, `  estado     ${estado}`];
}
