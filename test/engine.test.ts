import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pickEngine, subagentModel } from "../src/engine.js";

before(() => {
  process.env.BRITO_CONFIG = join(mkdtempSync(join(tmpdir(), "brito-")), "c.json");
  writeFileSync(process.env.BRITO_CONFIG, JSON.stringify({ providers: { qwen: { type: "openai", baseURL: "https://endpoint.invalido/v1", model: "m", apiKeyEnv: "BRITO_TESTE_KEY" } } }));
});

const nuncaChamar = () => { throw new Error("não devia consultar o claude CLI"); };

test("perfil com chave → api, sem ANTHROPIC_API_KEY e sem consultar o claude", () => {
  assert.deepEqual(pickEngine("qwen", { BRITO_TESTE_KEY: "k" }, nuncaChamar), { kind: "api" });
});

test("perfil sem chave ou com chave vazia → erro nomeando a variável", () => {
  for (const env of [{}, { BRITO_TESTE_KEY: "" }, { BRITO_TESTE_KEY: "  " }]) {
    const e = pickEngine("qwen", env, nuncaChamar);
    assert.equal(e.kind, "error");
    assert.match((e as { message: string }).message, /BRITO_TESTE_KEY/);
  }
});

test("Claude segue a regra de antes", () => {
  assert.deepEqual(pickEngine("sonnet", { ANTHROPIC_API_KEY: "x" }, nuncaChamar), { kind: "api" });
  assert.deepEqual(pickEngine("sonnet", {}, () => true), { kind: "claude" });
  const e = pickEngine("sonnet", {}, () => false);
  assert.equal(e.kind, "error");
  assert.match((e as { message: string }).message, /Defina ANTHROPIC_API_KEY ou instale o Claude Code/);
});

test("subagentes ficam no provedor do agente principal", () => {
  assert.equal(subagentModel({ name: "explore" }, "qwen", {}), "qwen");
  assert.equal(subagentModel({ name: "x", model: "haiku" }, "qwen", {}), "qwen");
  assert.equal(subagentModel({ name: "explore" }, "qwen", { BRITO_EXPLORE_MODEL: "sonnet" }), "sonnet");
  assert.equal(subagentModel({ name: "explore" }, "sonnet", {}), "claude-haiku-4-5-20251001");
  assert.equal(subagentModel({ name: "plan" }, "sonnet", {}), "sonnet");
  assert.equal(subagentModel({ name: "x", model: "qwen" }, "sonnet", {}), "qwen");
});
