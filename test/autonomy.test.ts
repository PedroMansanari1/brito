import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import "../src/tools/skills.js";
import { judgeTurn, recordOutcomes, reflect, shouldReflect, type Complete } from "../src/skills/learn.js";
import { getSkill, listPending, listSkills, saveSkill, skillsIndex } from "../src/skills/store.js";
import { DAILY_LIMIT, TRIAL_DAYS, expireTrials, recordOutcome, saveAuto, skillsMode } from "../src/skills/trial.js";
import { autoApplicable, autoConsolidate } from "../src/skills/consolidate.js";
import type { TurnRecord } from "../src/agent/loop.js";
import { GOOD_BODY, sandbox } from "./helpers.js";

const input = (name: string, body = GOOD_BODY) => ({ name, description: "Como fazer a tarefa X no projeto", body, refs: [], reason: "teste" });
const clean: TurnRecord = { messages: [{ role: "user", content: "faça X" }], toolCalls: 2, errors: 0, finished: true };
/** Async: o env tem que valer até a promessa resolver, não só até a função retornar. */
const withAuto = async <T>(fn: () => Promise<T>): Promise<T> => { const prev = process.env.BRITO_SKILLS; process.env.BRITO_SKILLS = "auto"; try { return await fn(); } finally { process.env.BRITO_SKILLS = prev; } };

test("skillsMode: padrão é auto; ask e off são reconhecidos", () => {
  const prev = process.env.BRITO_SKILLS;
  try {
    delete process.env.BRITO_SKILLS; assert.equal(skillsMode(), "auto");
    process.env.BRITO_SKILLS = "ask"; assert.equal(skillsMode(), "ask");
    process.env.BRITO_SKILLS = "off"; assert.equal(skillsMode(), "off");
    process.env.BRITO_SKILLS = "qualquer"; assert.equal(skillsMode(), "auto");
  } finally { if (prev === undefined) delete process.env.BRITO_SKILLS; else process.env.BRITO_SKILLS = prev; }
});

test("saveAuto: skill nova nasce em teste, é carregável e aparece marcada no índice", () => {
  const sb = sandbox();
  try {
    const r = saveAuto(sb.root, input("add-tool"));
    assert.equal(r.saved, true);
    const s = getSkill(sb.root, "add-tool")!;
    assert.deepEqual([s.status, s.origin, s.wins, s.losses], ["trial", "auto", 0, 0]);
    assert.match(skillsIndex(sb.root), /add-tool \(em teste\)/);
  } finally { sb.cleanup(); }
});

test("saveAuto: skill manual nunca é reescrita sozinha (vira proposta); comando destrutivo também vai para a fila", () => {
  const sb = sandbox();
  try {
    saveSkill(sb.root, input("revisada")); // sem auto = humano aprovou
    const r = saveAuto(sb.root, input("revisada", GOOD_BODY + "\nmais um passo importante aqui"));
    assert.equal(r.saved, false);
    assert.equal(getSkill(sb.root, "revisada")!.version, 1);
    assert.equal(listPending(sb.root).some((p) => p.name === "revisada"), true);

    const d = saveAuto(sb.root, input("reset-db", GOOD_BODY + "\n3. Rode git reset --hard antes de testar."));
    assert.equal(d.saved, false);
    assert.equal(getSkill(sb.root, "reset-db"), null);
    assert.equal(listPending(sb.root).some((p) => p.name === "reset-db"), true);
  } finally { sb.cleanup(); }
});

test("saveAuto: teto diário de skills novas; atualizar uma existente não conta", () => {
  const sb = sandbox();
  try {
    for (let i = 0; i < DAILY_LIMIT; i++) assert.equal(saveAuto(sb.root, input(`skill-${i}`)).saved, true);
    assert.equal(saveAuto(sb.root, input("skill-extra")).saved, false);
    assert.equal(saveAuto(sb.root, input("skill-0", GOOD_BODY + "\npasso novo bem concreto")).saved, true);
    assert.equal(getSkill(sb.root, "skill-0")!.version, 2);
  } finally { sb.cleanup(); }
});

test("recordOutcome: 3 sucessos promovem; atualizar a skill em teste zera o placar", () => {
  const sb = sandbox();
  try {
    saveAuto(sb.root, input("promo"));
    assert.equal(recordOutcome(sb.root, "promo", true), null);
    assert.equal(recordOutcome(sb.root, "promo", true), null);
    saveAuto(sb.root, input("promo", GOOD_BODY + "\najuste")); // conteúdo novo = hipótese nova
    assert.equal(getSkill(sb.root, "promo")!.wins, 0);
    recordOutcome(sb.root, "promo", true); recordOutcome(sb.root, "promo", true);
    assert.match(recordOutcome(sb.root, "promo", true) ?? "", /promovida/);
    assert.equal(getSkill(sb.root, "promo")!.status, "active");
  } finally { sb.cleanup(); }
});

test("recordOutcome: 2 falhas arquivam (reversível em .trash); skill manual nunca é arquivada", () => {
  const sb = sandbox();
  try {
    saveAuto(sb.root, input("ruim"));
    recordOutcome(sb.root, "ruim", false);
    assert.match(recordOutcome(sb.root, "ruim", false) ?? "", /arquivada/);
    assert.equal(getSkill(sb.root, "ruim"), null);
    assert.equal(fs.readdirSync(path.join(sb.root, ".brito", "skills", ".trash")).some((d) => d.startsWith("ruim-")), true);

    saveSkill(sb.root, input("manual"));
    for (let i = 0; i < 6; i++) assert.equal(recordOutcome(sb.root, "manual", false), null);
    assert.equal(getSkill(sb.root, "manual")!.losses, 6);
  } finally { sb.cleanup(); }
});

test("expireTrials: em teste sem uso por mais de 21 dias é arquivada; ativa ou recente fica", () => {
  const sb = sandbox();
  try {
    saveAuto(sb.root, input("parada"));
    assert.deepEqual(expireTrials(sb.root), []);
    const later = Date.now() + (TRIAL_DAYS + 2) * 86_400_000;
    assert.equal(expireTrials(sb.root, later).length, 1);
    assert.equal(getSkill(sb.root, "parada"), null);
  } finally { sb.cleanup(); }
});

test("judgeTurn / recordOutcomes: turno limpo credita sucesso; correção do usuário credita falha; abortado é neutro", () => {
  const sb = sandbox();
  try {
    saveAuto(sb.root, input("usada"));
    sb.ctx.loadedSkills!.add("usada");
    assert.equal(judgeTurn(clean), "win");
    assert.equal(judgeTurn({ ...clean, finished: false }), null);
    assert.equal(judgeTurn({ ...clean, messages: [{ role: "user", content: "Não, use o outro comando" }] }), "loss");
    recordOutcomes(clean, sb.ctx);
    assert.equal(getSkill(sb.root, "usada")!.wins, 1);
    recordOutcomes({ ...clean, messages: [{ role: "user", content: "Não, use o outro comando" }] }, sb.ctx);
    assert.equal(getSkill(sb.root, "usada")!.losses, 1);
    recordOutcomes({ ...clean, finished: false }, sb.ctx);
    assert.deepEqual([getSkill(sb.root, "usada")!.wins, getSkill(sb.root, "usada")!.losses], [1, 1]);
  } finally { sb.cleanup(); }
});

test("reflect em modo auto: grava em teste sem perguntar ao usuário, até em 'ask' da permissão negada", async () => {
  const sb = sandbox();
  try {
    sb.ctx.ask = async () => { throw new Error("não devia perguntar"); };
    const complete: Complete = async () => [{ type: "tool_use", id: "1", name: "skill_save", input: input("auto-feita") } as Anthropic.ToolUseBlock];
    const out = await withAuto(() => reflect(clean, sb.ctx, "m", complete));
    assert.match(out[0], /criada em teste/);
    assert.equal(getSkill(sb.root, "auto-feita")!.status, "trial");
  } finally { sb.cleanup(); }
});

test("BRITO_SKILLS=off: não reflete", () => {
  const sb = sandbox();
  const prev = process.env.BRITO_SKILLS;
  try {
    process.env.BRITO_SKILLS = "off";
    assert.equal(shouldReflect({ ...clean, toolCalls: 50 }, sb.ctx), false);
    assert.deepEqual(recordOutcomes(clean, sb.ctx), []);
  } finally { process.env.BRITO_SKILLS = prev; sb.cleanup(); }
});

test("consolidação automática só mexe em skills automáticas", async () => {
  const sb = sandbox();
  try {
    saveSkill(sb.root, input("humana"));
    saveAuto(sb.root, input("auto-a"));
    const props = [
      { kind: "delete" as const, name: "humana", reason: "x" },
      { kind: "delete" as const, name: "auto-a", reason: "x" },
    ];
    assert.deepEqual(autoApplicable(sb.root, props).map((p) => (p as { name: string }).name), ["auto-a"]);

    for (let i = 0; i < 6; i++) saveSkill(sb.root, input(`extra-${i}`, GOOD_BODY + `\npasso ${i}`), "project", { auto: true }); // direto: o teto diário barraria via saveAuto
    let calls = 0;
    const complete: Complete = async () => { calls++; return []; };
    assert.deepEqual(await autoConsolidate(sb.root, "m", complete), []);
    assert.deepEqual(await autoConsolidate(sb.root, "m", complete), []); // trava semanal: não chama de novo
    assert.equal(calls, 1);
    assert.equal(listSkills(sb.root).length >= 4, true);
  } finally { sb.cleanup(); }
});
