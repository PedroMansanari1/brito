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
