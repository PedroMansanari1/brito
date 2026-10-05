import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { bumpUses, deleteSkill, getSkill, listSkills, promoteSkill, saveSkill, skillsIndex, validate } from "../src/skills/store.js";
import { GOOD_BODY, sandbox } from "./helpers.js";

const input = (over: Partial<Parameters<typeof saveSkill>[1]> = {}) => ({ name: "add-tool", description: "Como adicionar uma tool nova ao agente", body: GOOD_BODY, ...over });

test("saveSkill cria v1 e atualiza guardando history", () => {
  const sb = sandbox();
  try {
    assert.deepEqual(saveSkill(sb.root, input()), { created: true, version: 1, scope: "project" });
    const r = saveSkill(sb.root, input({ body: GOOD_BODY + "\n- armadilha nova" }));
    assert.equal(r.created, false);
    assert.equal(r.version, 2);
    assert.ok(fs.existsSync(path.join(sb.root, ".brito/skills/add-tool/history/v1.md")));
    assert.match(getSkill(sb.root, "add-tool")!.body, /armadilha nova/);
  } finally { sb.cleanup(); }
});

test("validate rejeita nome, descrição e body inválidos", () => {
  assert.throws(() => validate(input({ name: "Nome Ruim" })), /kebab-case/);
  assert.throws(() => validate(input({ description: "curta" })), /description/);
  assert.throws(() => validate(input({ body: "pouco" })), /body curto/);
  assert.throws(() => validate(input({ body: "x".repeat(8001) })), /8000/);
  assert.doesNotThrow(() => validate(input()));
});

test("bumpUses incrementa e preserva o resto", () => {
  const sb = sandbox();
  try {
    saveSkill(sb.root, input());
    bumpUses(sb.root, "add-tool");
    bumpUses(sb.root, "add-tool");
    const s = getSkill(sb.root, "add-tool")!;
    assert.equal(s.uses, 2);
    assert.equal(s.version, 1);
  } finally { sb.cleanup(); }
});

test("deleteSkill move para .trash", () => {
  const sb = sandbox();
  try {
    saveSkill(sb.root, input());
    assert.equal(deleteSkill(sb.root, "add-tool"), true);
    assert.equal(getSkill(sb.root, "add-tool"), null);
    assert.equal(fs.readdirSync(path.join(sb.root, ".brito/skills/.trash")).length, 1);
    assert.equal(deleteSkill(sb.root, "add-tool"), false);
  } finally { sb.cleanup(); }
});

test("promoteSkill move para global e recusa duplicata", () => {
  const sb = sandbox();
  try {
    saveSkill(sb.root, input());
    promoteSkill(sb.root, "add-tool");
    assert.equal(getSkill(sb.root, "add-tool")!.scope, "global");
    saveSkill(sb.root, input(), "project");
    assert.throws(() => promoteSkill(sb.root, "add-tool"), /Já existe skill global/);
  } finally { sb.cleanup(); }
});

test("skillsIndex ordena por uso e marca global", () => {
  const sb = sandbox();
  try {
    saveSkill(sb.root, input({ name: "a-skill" }));
    saveSkill(sb.root, input({ name: "b-skill" }), "global");
    bumpUses(sb.root, "b-skill");
    const lines = skillsIndex(sb.root).split("\n");
    assert.match(lines[0], /^- b-skill \(global\)/);
    assert.match(lines[1], /^- a-skill:/);
    assert.equal(listSkills(sb.root).length, 2);
  } finally { sb.cleanup(); }
});
