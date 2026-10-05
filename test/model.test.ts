import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseModelArgs, saveModel, loadSavedModel } from "../src/model.js";

test("alias e escopo padrão = sessão", () => {
  assert.deepEqual(parseModelArgs("opus"), { model: "claude-opus-5-5", scope: "session", errors: [] });
});

test("flags: global, once e travessão unicode", () => {
  assert.equal(parseModelArgs("haiku --global").scope, "global");
  assert.equal(parseModelArgs("sonnet —once").scope, "once");
  assert.equal(parseModelArgs("x --global --session").scope, "session");
});

test("conflitos viram erro", () => {
  assert.equal(parseModelArgs("opus --once --global").errors.length, 1);
  assert.equal(parseModelArgs("--once").errors.length, 1);
  assert.equal(parseModelArgs("").model, "");
});

test("saveModel persiste e preserva outras chaves", () => {
  process.env.BRITO_CONFIG = join(mkdtempSync(join(tmpdir(), "brito-")), "c.json");
  saveModel("claude-opus-5-5");
  assert.equal(loadSavedModel(), "claude-opus-5-5");
  assert.match(readFileSync(process.env.BRITO_CONFIG, "utf8"), /opus/);
});

test("effort persiste, valida e preserva o modelo", async () => {
  const { saveEffort, loadSavedEffort, isEffort } = await import("../src/model.js");
  process.env.BRITO_CONFIG = join(mkdtempSync(join(tmpdir(), "brito-")), "c.json");
  saveModel("claude-sonnet-5-5");
  saveEffort("low");
  assert.equal(loadSavedEffort(), "low");
  assert.equal(loadSavedModel(), "claude-sonnet-5-5");
  assert.equal(isEffort("tiny"), false);
});

test("effort: --global sem nível remove o salvo e BRITO_EFFORT inválido é ignorado", async () => {
  const { saveEffort, loadSavedEffort, initialEffort } = await import("../src/model.js");
  process.env.BRITO_CONFIG = join(mkdtempSync(join(tmpdir(), "brito-")), "c.json");
  saveModel("claude-sonnet-5-5");
  saveEffort("high");
  saveEffort(undefined);
  assert.equal(loadSavedEffort(), undefined);
  assert.equal(loadSavedModel(), "claude-sonnet-5-5");
  process.env.BRITO_EFFORT = "hgih";
  assert.equal(initialEffort(), "");
  process.env.BRITO_EFFORT = "MAX";
  assert.equal(initialEffort(), "max");
  delete process.env.BRITO_EFFORT;
});
