import { FALLBACK_PROFILE, type FallbackStatus } from "../engine.js";

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
