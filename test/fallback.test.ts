import { test } from "node:test";
import assert from "node:assert/strict";
import { activateFallback, chooseModel, newFallbackState } from "../src/provider/fallback.js";

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
