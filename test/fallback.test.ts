import { test } from "node:test";
import assert from "node:assert/strict";
import { activateFallback, chooseModel, newFallbackState, renderFallback } from "../src/provider/fallback.js";

test("estado novo: principal = modelo inicial, inativo", () => {
  assert.deepEqual(newFallbackState("claude-opus-5-5"), { primary: "claude-opus-5-5", active: false });
});

test("ativar guarda motivo e horário", () => {
  const s = newFallbackState("sonnet");
  activateFallback(s, "rate_limit (429)", 1234);
  assert.deepEqual(s, { primary: "sonnet", active: true, reason: "rate_limit (429)", at: 1234 });
});

test("/model <claude> com fallback ativo: troca o principal e zera o fallback", () => {
  const s = newFallbackState("sonnet");
  activateFallback(s, "x", 1);
  chooseModel(s, "claude-opus-5-5");
  assert.equal(s.primary, "claude-opus-5-5");
  assert.equal(s.active, false);
  assert.equal(s.reason, undefined);
  assert.equal(s.at, undefined);
});

test("/model qwen é escolha, não fallback", () => {
  const s = newFallbackState("sonnet");
  activateFallback(s, "x", 1);
  chooseModel(s, "qwen");
  assert.equal(s.primary, "qwen");
  assert.equal(s.active, false);
});

const pronto = { ready: true, name: "qwen", label: "Qwen 27B (OCI)" } as const;

test("/fallback: pronto", () => {
  assert.deepEqual(renderFallback(newFallbackState("claude-opus-5-5"), "claude-opus-5-5", "claude CLI · assinatura", pronto), [
    "  principal  claude-opus-5-5  (claude CLI · assinatura)",
    "  fallback   Qwen 27B (OCI)  qwen · ~/.brito/config.json  ✓ pronto",
    "  estado     inativo — troca automática se o Claude falhar por limite, crédito, auth ou sobrecarga",
  ]);
});

test("/fallback: principal é o modelo vivo", () => {
  const [l] = renderFallback(newFallbackState("sonnet"), "claude-haiku-4-5-20251001", "API Anthropic", pronto);
  assert.equal(l, "  principal  claude-haiku-4-5-20251001  (API Anthropic)");
});

test("/fallback: sem chave", () => {
  const out = renderFallback(newFallbackState("sonnet"), "sonnet", "API Anthropic",
    { ready: false, label: "Qwen 27B (OCI)", reason: 'defina a variável de ambiente BRITO_QWEN_API_KEY com a chave do endpoint "qwen"' });
  assert.equal(out[1], '  fallback   Qwen 27B (OCI)  ✗ defina a variável de ambiente BRITO_QWEN_API_KEY com a chave do endpoint "qwen"');
  assert.match(out[2], /indisponível/);
});

test("/fallback: sem perfil", () => {
  const out = renderFallback(newFallbackState("sonnet"), "sonnet", "API Anthropic", { ready: false, reason: 'sem perfil "qwen" em providers no ~/.brito/config.json' });
  assert.equal(out[1], '  fallback   —  ✗ sem perfil "qwen" em providers no ~/.brito/config.json');
});

test("/fallback: principal já é o qwen", () => {
  const out = renderFallback(newFallbackState("qwen"), "QWEN", "endpoint", { ready: false, label: "Qwen 27B (OCI)", reason: "o modelo principal já é o qwen" });
  assert.deepEqual(out, [
    "  principal  QWEN  (endpoint)",
    "  fallback   Qwen 27B (OCI)  — o modelo principal já é o qwen",
    "  estado     não se aplica",
  ]);
});

test("/fallback: ATIVO mostra o principal original, o qwen em uso e o horário", () => {
  const s = newFallbackState("claude-opus-5-5");
  activateFallback(s, "rate_limit (429 Too Many Requests)", new Date(2026, 9, 21, 14, 32).getTime());
  assert.deepEqual(renderFallback(s, "qwen", "API Anthropic", pronto), [
    "  principal  claude-opus-5-5  (API Anthropic)",
    "  fallback   Qwen 27B (OCI)  qwen · ~/.brito/config.json  ● em uso",
    "  estado     ATIVO desde 14:32 — Claude falhou: rate_limit (429 Too Many Requests). /model <claude> para voltar",
  ]);
});
