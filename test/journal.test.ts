import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import "../src/tools/skills.js";
import { appendJournal, describeEntry, entryFromTurn, readJournal, similarEntries, similarity, type JournalEntry } from "../src/skills/journal.js";
import { buildReflectInput, reflect, type Complete } from "../src/skills/learn.js";
import { perms } from "../src/permissions.js";
import type { TurnRecord } from "../src/agent/loop.js";
import { GOOD_BODY, sandbox } from "./helpers.js";

const call = (id: string) => ({ role: "assistant" as const, content: [{ type: "tool_use" as const, id, name: "bash", input: { command: "x" } }] });
const result = (id: string, content: string, is_error = false) => ({ role: "user" as const, content: [{ type: "tool_result" as const, tool_use_id: id, content, is_error }] });
/** Turno com um tropeço (erro seguido de conserto). */
const trap = (task: string, error: string): TurnRecord => ({ messages: [{ role: "user", content: task }, call("1"), result("1", error, true), call("2"), result("2", "ok")], toolCalls: 2, errors: 1, finished: true });
const entry = (task: string, error: string, saved: string[] = []): JournalEntry => entryFromTurn(trap(task, error), saved, "2026-09-30");

const ENOENT = "ENOENT: no such file or directory, open '.env.test'";

test("entryFromTurn redige segredos e caminhos absolutos e limita o tamanho", () => {
  const t = trap("Configure o deploy com sk-live-9f8e7d6c5b4a3210 em /Users/wilson/Documents/app/x.ts " + "y".repeat(500), "falhou em /Users/wilson/app com ghp_abcdefghijklmnopqrstuvwxyz0123");
  const e = entryFromTurn(t, []);
  const all = JSON.stringify(e);
  assert.ok(!all.includes("sk-live") && !all.includes("/Users/wilson") && !all.includes("ghp_"));
  assert.match(all, /\[redigido\]/);
  assert.ok(e.task.length <= 200 && e.sig.every((x) => x.length <= 160));
});

test("append/read: ida e volta, linhas corrompidas ignoradas, rotação em 200, .gitignore criado", () => {
  const sb = sandbox();
  try {
    assert.deepEqual(readJournal(sb.root), []);
    appendJournal(sb.root, entry("tarefa um", "erro um"));
    const file = path.join(sb.root, ".brito/skills/.journal.jsonl");
    fs.appendFileSync(file, "isto não é json\n");
    appendJournal(sb.root, entry("tarefa dois", "erro dois"));
    assert.deepEqual(readJournal(sb.root).map((e) => e.task), ["tarefa um", "tarefa dois"]);
    const ignore = fs.readFileSync(path.join(sb.root, ".brito/skills/.gitignore"), "utf8");
    assert.match(ignore, /\.journal\.jsonl/);
    for (let i = 0; i < 210; i++) appendJournal(sb.root, entry(`tarefa-${i}`, "erro"));
    const all = readJournal(sb.root);
    assert.equal(all.length, 200);
    assert.equal(all[199].task, "tarefa-209");
  } finally { sb.cleanup(); }
});

test("similaridade: mesma armadilha em outra tarefa passa; armadilha diferente não", () => {
  const atual = entry("Rode os testes de integração do módulo billing", ENOENT);
  const mesma = entry("Execute os testes do módulo users", ENOENT);
  const outra = entry("Rode os testes de integração do módulo billing", "TS2304: Cannot find name 'defineTool'");
  assert.ok(similarity(atual, mesma) >= 0.3, String(similarity(atual, mesma)));
  assert.ok(similarity(atual, outra) < 0.3, String(similarity(atual, outra)));
});

test("similarEntries: ordena, limita a 3 e devolve vazio sem parecidas", () => {
  const sb = sandbox();
  try {
    const t = trap("Rode os testes de integração do módulo billing", ENOENT);
    assert.deepEqual(similarEntries(sb.root, t), []);
    appendJournal(sb.root, entry("Compile o projeto inteiro", "Cannot find module './config'"));
    assert.deepEqual(similarEntries(sb.root, t), []);
    for (const m of ["users", "orders", "payments", "catalog"]) appendJournal(sb.root, entry(`Execute os testes do módulo ${m}`, ENOENT));
    const got = similarEntries(sb.root, t);
    assert.equal(got.length, 3);
    assert.ok(got.every((e) => e.sig[0].includes("ENOENT")));
  } finally { sb.cleanup(); }
});

test("buildReflectInput mostra tarefas parecidas só quando existem", () => {
  const sb = sandbox();
  try {
    const t = trap("Rode os testes de integração do módulo billing", ENOENT);
    assert.ok(!buildReflectInput(t, sb.ctx).includes("Tarefas parecidas"));
    appendJournal(sb.root, entry("Execute os testes do módulo users", ENOENT, ["preparar-testes"]));
    const input = buildReflectInput(t, sb.ctx);
    assert.match(input, /# Tarefas parecidas já vistas/);
    assert.match(input, /gerou\/atualizou skill: preparar-testes/);
    assert.match(describeEntry(readJournal(sb.root)[0]), /^- 2026-09-30:/);
  } finally { sb.cleanup(); }
});

const saveBlock = (name: string): Anthropic.ToolUseBlock => ({ type: "tool_use", id: name, name: "skill_save", input: { name, description: "Como preparar o ambiente de testes", body: GOOD_BODY, refs: [], reason: "t" } }) as any;

test("reflect registra no journal: sem saves, com save aprovado, negado e em bypass", async () => {
  const sb = sandbox();
  const prev = perms.mode;
  try {
    perms.mode = "manual";
    const t = trap("Rode os testes do módulo billing", ENOENT);
    await reflect(t, sb.ctx, "m", async () => []);
    assert.deepEqual(readJournal(sb.root).map((e) => e.saved), [[]]);

    await reflect(t, sb.ctx, "m", async () => [saveBlock("preparar-testes")]);
    assert.deepEqual(readJournal(sb.root)[1].saved, ["preparar-testes"]);

    sb.ctx.ask = async () => false;
    await reflect(t, sb.ctx, "m", async () => [saveBlock("outra-skill")]);
    assert.deepEqual(readJournal(sb.root)[2].saved, []); // negada: não conta como skill criada

    perms.mode = "bypass";
    await reflect(t, sb.ctx, "m", async () => [saveBlock("staged-skill")]);
    assert.deepEqual(readJournal(sb.root)[3].saved, ["staged-skill"]); // proposta pendente conta
  } finally { perms.mode = prev; sb.cleanup(); }
});

test("falha ao gravar o journal nunca derruba a reflexão", async () => {
  const sb = sandbox();
  try {
    fs.writeFileSync(path.join(sb.root, ".brito"), "arquivo no lugar do diretório");
    const complete: Complete = async () => [];
    assert.deepEqual(await reflect(trap("x", "y"), sb.ctx, "m", complete), []);
  } finally { sb.cleanup(); }
});
