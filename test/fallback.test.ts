import { test } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { activateFallback, chooseModel, classifyAnthropicError, newFallbackState, onceRestore, renderFallback, shortError, triggersFallback } from "../src/provider/fallback.js";

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

const apiErr = (status: number, type: string, message = "x") =>
  Anthropic.APIError.generate(status, { type: "error", error: { type, message } }, message, new Headers());

test("classificação dos erros da API da Anthropic", () => {
  const casos: [unknown, string][] = [
    [apiErr(429, "rate_limit_error"), "rate_limit"],
    [apiErr(529, "overloaded_error"), "overloaded"],
    [apiErr(500, "api_error"), "overloaded"],
    [apiErr(503, "api_error"), "overloaded"],
    [apiErr(402, "billing_error"), "quota"],
    [apiErr(400, "invalid_request_error", "Your credit balance is too low to access the Anthropic API."), "quota"],
    [apiErr(401, "authentication_error"), "auth"],
    [apiErr(403, "permission_error"), "auth"],
    [new Anthropic.APIConnectionError({ message: "falhou a conexão" }), "network"],
    [new Anthropic.APIConnectionTimeoutError(), "network"],
    [apiErr(400, "invalid_request_error", "messages.1: tool_use ids must be unique"), "other"],
    [apiErr(404, "not_found_error"), "other"],
    [new Anthropic.APIUserAbortError(), "other"],
    [Object.assign(new Error("abortado"), { name: "AbortError" }), "other"],
    [new Error("qualquer"), "other"],
    ["texto", "other"],
  ];
  for (const [e, k] of casos) assert.equal(classifyAnthropicError(e), k, String((e as Error)?.message ?? e));
});

test("só `other` não dispara o fallback", () => {
  for (const k of ["quota", "rate_limit", "overloaded", "auth", "network"] as const) assert.equal(triggersFallback(k), true);
  assert.equal(triggersFallback("other"), false);
});

test("shortError: primeira linha, cortada", () => {
  assert.equal(shortError(new Error("a\nb")), "a");
  assert.equal(shortError(new Error("x".repeat(200)), 10), "x".repeat(9) + "…");
});

test("--once: fallback ativado no turno descarta o restore", () => {
  assert.equal(onceRestore("claude-opus-5-5", false), "claude-opus-5-5");
  assert.equal(onceRestore("claude-opus-5-5", true), null);
  assert.equal(onceRestore(null, false), null);
});
