/**
 * Eval de replay do aprendizado de skills (chama o modelo de verdade).
 * Uso: npm run eval:learn -- [--runs=3] [--write-baseline]
 *
 * Mede três coisas por fixture:
 *  - gatilho: `shouldReflect` disparou quando devia (`expectReflect`)? Disparo à toa = chamada extra desperdiçada.
 *  - reflexão: o modelo decidiu certo (none | create | update:<nome>) quando chamado direto?
 *  - ponta a ponta: gatilho + reflexão juntos, que é o que o usuário vive.
 * Falha (exit 1) só em falso positivo da reflexão ou vazamento de conteúdo proibido.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type Anthropic from "@anthropic-ai/sdk";
import "../src/tools/skills.js";
import { MODEL } from "../src/agent/loop.js";
import { defaultComplete, reflect, shouldReflect, type Complete } from "../src/skills/learn.js";
import { claudeCliComplete } from "../src/skills/learn-cli.js";
import { hasClaudeCli } from "../src/agent/claude-cli.js";
import { saveSkill } from "../src/skills/store.js";
import { appendJournal, type JournalEntry } from "../src/skills/journal.js";
import { sandbox } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, "fixtures/turns");
const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const runs = Number(arg("runs") ?? 1);
const only = arg("only")?.split(",") ?? []; // prefixos de fixture, ex.: --only=07,13
const model = process.env.BRITO_LEARN_MODEL ?? MODEL;
const useApi = !!process.env.ANTHROPIC_API_KEY;
if (!useApi && !hasClaudeCli()) { console.error("Defina ANTHROPIC_API_KEY ou instale o claude CLI (/login)."); process.exit(2); }
const backend = useApi ? "api" : "claude-cli";
const base: Complete = useApi ? defaultComplete : claudeCliComplete;

interface Fixture { expect: string; expectReflect: boolean; note: string; forbid?: string[]; existingSkills?: { name: string; description: string; body: string }[]; loadedSkills?: string[]; journal?: JournalEntry[]; turn: any }
type Outcome = "none" | "create" | `update:${string}`;

async function runOnce(f: Fixture): Promise<{ gate: boolean; outcome: Outcome; leaked: boolean }> {
  const sb = sandbox();
  try {
    for (const s of f.existingSkills ?? []) saveSkill(sb.root, s);
    for (const e of f.journal ?? []) appendJournal(sb.root, e);
    for (const n of f.loadedSkills ?? []) sb.ctx.loadedSkills!.add(n);
    const gate = shouldReflect(f.turn, sb.ctx); // antes do reflect, que limpa loadedSkills
    const saves: Anthropic.ToolUseBlock[] = [];
    const complete: Complete = async (req) => {
      const content = await base(req);
      saves.push(...content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "skill_save"));
      return content;
    };
    await reflect(f.turn, sb.ctx, model, complete);
    const first = saves[0]?.input as { name?: string } | undefined;
    const existing = new Set((f.existingSkills ?? []).map((s) => s.name));
    const outcome: Outcome = !first ? "none" : first.name && existing.has(first.name) ? `update:${first.name}` : "create";
    const leaked = (f.forbid ?? []).some((x) => JSON.stringify(saves.map((s) => s.input)).includes(x));
    return { gate, outcome, leaked };
  } finally { sb.cleanup(); }
}

const rows: string[] = [];
const m = { negs: 0, reflectFalsePos: 0, poss: 0, reflectHits: 0, leaks: 0, gatePoss: 0, gateHits: 0, gateNegs: 0, gateWaste: 0, e2eHits: 0, e2eFalsePos: 0 };
for (const file of fs.readdirSync(dir).filter((x) => x.endsWith(".json") && (!only.length || only.some((o) => x.startsWith(o)))).sort()) {
  const f: Fixture = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
  const positive = f.expect !== "none";
  for (let i = 0; i < runs; i++) {
    const { gate, outcome, leaked } = await runOnce(f);
    const e2e: Outcome = gate ? outcome : "none";
    if (positive) { m.poss++; if (outcome === f.expect) m.reflectHits++; if (e2e === f.expect) m.e2eHits++; }
    else { m.negs++; if (outcome !== "none") m.reflectFalsePos++; if (e2e !== "none") m.e2eFalsePos++; }
    if (f.expectReflect) { m.gatePoss++; if (gate) m.gateHits++; } else { m.gateNegs++; if (gate) m.gateWaste++; }
    if (leaked) m.leaks++;
    const ok = (b: boolean) => (b ? "ok" : "FALHA");
    rows.push(`| ${file.replace(".json", "")} | ${f.expect} | ${gate ? "sim" : "não"} (${ok(gate === f.expectReflect)}) | ${outcome} (${ok(outcome === f.expect)}) | ${e2e} (${ok(e2e === f.expect)})${leaked ? " VAZOU" : ""} |`);
  }
}

const report = [
  `# Baseline do eval de aprendizado de skills`,
  ``,
  `backend: ${backend} · modelo: ${model} · execuções por fixture: ${runs} · data: ${new Date().toISOString().slice(0, 10)}`,
  ``,
  `| fixture | esperado | gatilho disparou | reflexão (direta) | ponta a ponta |`,
  `|---|---|---|---|---|`,
  ...rows,
  ``,
  `- gatilho: recall ${m.gateHits}/${m.gatePoss} · disparos desperdiçados ${m.gateWaste}/${m.gateNegs}`,
  `- reflexão direta: recall ${m.reflectHits}/${m.poss} · falsos positivos ${m.reflectFalsePos}/${m.negs} (meta: 0)`,
  `- ponta a ponta: recall ${m.e2eHits}/${m.poss} · falsos positivos ${m.e2eFalsePos}/${m.negs}`,
  `- vazamentos de conteúdo proibido: ${m.leaks} (meta: 0)`,
  ``,
].join("\n");

console.log(report);
if (process.argv.includes("--write-baseline") && !only.length) fs.writeFileSync(path.join(here, "eval-baseline.md"), report);
process.exit(m.reflectFalsePos || m.leaks ? 1 : 0);
