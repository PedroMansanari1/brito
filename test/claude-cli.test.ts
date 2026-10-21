import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { ClaudeSession, ORPHAN_RESULT, recordStreamEvent, turnsToMessages } from "../src/agent/claude-cli.js";
import type { TurnSink } from "../src/agent/sink.js";
import { MCP_PREFIX } from "../src/mcp/server.js";
import { renderTranscript, shouldReflect } from "../src/skills/learn.js";
import type { TurnRecord } from "../src/agent/loop.js";
import { sandbox } from "./helpers.js";

const fresh = (): TurnRecord => ({ messages: [{ role: "user", content: "faça X" }], toolCalls: 0, errors: 0, finished: false });
const assistant = (...content: any[]) => ({ type: "assistant", message: { content } });
const results = (...content: any[]) => ({ type: "user", message: { content } });

test("stream-json vira TurnRecord com tools, resultados e erros", () => {
  const t = fresh(), loaded = new Set<string>();
  recordStreamEvent(t, assistant({ type: "text", text: "vou ler" }, { type: "tool_use", id: "a", name: "Read", input: { file_path: "x.ts" } }), loaded);
  recordStreamEvent(t, results({ type: "tool_result", tool_use_id: "a", content: "conteúdo" }), loaded);
  recordStreamEvent(t, assistant({ type: "tool_use", id: "b", name: "Bash", input: { command: "npm test" } }), loaded);
  recordStreamEvent(t, results({ type: "tool_result", tool_use_id: "b", content: [{ type: "text", text: "falhou" }], is_error: true }), loaded);
  assert.equal(t.toolCalls, 2);
  assert.equal(t.errors, 1);
  assert.equal(t.messages.length, 5);
  const out = renderTranscript(t);
  assert.match(out, /→ Read/);
  assert.match(out, /← \[ERRO\]/);
});

test("prefixo MCP sai do nome e skill_load marca a skill como carregada", () => {
  const t = fresh(), loaded = new Set<string>();
  recordStreamEvent(t, assistant({ type: "tool_use", id: "a", name: `${MCP_PREFIX}skill_load`, input: { name: "add-tool" } }), loaded);
  assert.deepEqual([...loaded], ["add-tool"]);
  assert.match(JSON.stringify(t.messages[1]), /"name":"skill_load"/);
});

test("eventos de subagente (parent_tool_use_id) são ignorados", () => {
  const t = fresh(), loaded = new Set<string>();
  recordStreamEvent(t, { ...assistant({ type: "tool_use", id: "a", name: `${MCP_PREFIX}skill_load`, input: { name: "x" } }), parent_tool_use_id: "p" }, loaded);
  recordStreamEvent(t, { ...results({ type: "tool_result", tool_use_id: "a", content: "ok" }), parent_tool_use_id: "p" }, loaded);
  assert.equal(t.messages.length, 1);
  assert.equal(t.toolCalls, 0);
  assert.equal(loaded.size, 0);
});

test("eventos sem conteúdo útil não geram mensagens", () => {
  const t = fresh();
  recordStreamEvent(t, { type: "system" }, new Set());
  recordStreamEvent(t, assistant({ type: "thinking", thinking: "..." }), new Set());
  recordStreamEvent(t, results({ type: "text", text: "oi" }), new Set());
  assert.equal(t.messages.length, 1);
});

test("turno do modo CLI com erro→conserto dispara a reflexão; turno curto e limpo, não", () => {
  const sb = sandbox();
  try {
    const t = fresh();
    t.finished = true;
    recordStreamEvent(t, assistant({ type: "tool_use", id: "a", name: "Bash", input: { command: "npm test" } }), new Set());
    recordStreamEvent(t, results({ type: "tool_result", tool_use_id: "a", content: "falhou", is_error: true }), new Set());
    recordStreamEvent(t, assistant({ type: "tool_use", id: "b", name: "Bash", input: { command: "npm test" } }), new Set());
    recordStreamEvent(t, results({ type: "tool_result", tool_use_id: "b", content: "ok" }), new Set());
    assert.equal(shouldReflect(t, sb.ctx), true);
    assert.equal(shouldReflect({ ...fresh(), finished: true }, sb.ctx), false);
  } finally { sb.cleanup(); }
});

const FIX = path.join(import.meta.dirname, "fixtures", "claude-cli");
const FAKE = path.join(import.meta.dirname, "fake-claude.mjs");
const silent = (): TurnSink => { const noop = () => {}; return { turnStart: noop, turnEnd: noop, text: noop, textEnd: noop, thinking: noop, toolStart: noop, toolEnd: noop, info: noop, warn: noop, error: noop }; };
/** Sessão cujo `claude` é o falso, reproduzindo a fixture (ou um executável inexistente). */
function fakeSession(root: string, fixture: string | null) {
  const command = (args: string[]) => fixture === null ? { command: path.join(root, "claude-nao-existe"), args }
    : { command: process.execPath, args: [FAKE, path.join(FIX, fixture + ".json"), ...args] };
  return new ClaudeSession({ root, approvalSock: "x", stats: "", mcpCommand: { command: "x", args: [] }, sink: silent(), command });
}

test("send: falha estruturada vira lastFailure classificada", async () => {
  const sb = sandbox();
  try {
    const s = fakeSession(sb.root, "invalid-api-key");
    assert.equal(await s.send("oi"), false);
    assert.deepEqual(s.lastFailure, { kind: "auth", message: "Invalid API key · Fix external API key" });
    const q = fakeSession(sb.root, "usage-limit-hit");
    assert.equal(await q.send("oi"), false);
    assert.equal(q.lastFailure?.kind, "quota");
  } finally { sb.cleanup(); }
});

test("send: claude não encontrado (spawn ENOENT) → auth", async () => {
  const sb = sandbox();
  try {
    const s = fakeSession(sb.root, null);
    assert.equal(await s.send("oi"), false);
    assert.equal(s.lastFailure?.kind, "auth");
    assert.match(s.lastFailure!.message, /ENOENT/);
  } finally { sb.cleanup(); }
});

test("send: interrupção nunca vira falha", async () => {
  const sb = sandbox();
  try {
    const s = fakeSession(sb.root, "interrupted");
    const p = s.send("oi");
    setTimeout(() => s.abort(), 300);
    assert.equal(await p, true); // resolve(ok): interrupção não é erro
    assert.equal(s.lastFailure, null);
  } finally { sb.cleanup(); }
});

test("send: turno novo zera a falha anterior", async () => {
  const sb = sandbox();
  try {
    const s = fakeSession(sb.root, "logged-out");
    await s.send("oi");
    assert.equal(s.lastFailure?.kind, "auth");
    (s as any).o.command = (args: string[]) => ({ command: process.execPath, args: [FAKE, path.join(FIX, "interrupted.json"), ...args] });
    const p = s.send("de novo");
    setTimeout(() => s.abort(), 300);
    await p;
    assert.equal(s.lastFailure, null);
  } finally { sb.cleanup(); }
});

/** Dois turnos montados do stream-json: o primeiro completo, o segundo caiu no meio de um tool_use. */
function twoTurns(): TurnRecord[] {
  const a = fresh(), b: TurnRecord = { messages: [{ role: "user", content: "agora rode os testes" }], toolCalls: 0, errors: 0, finished: false };
  recordStreamEvent(a, assistant({ type: "text", text: "vou ler" }), new Set());
  recordStreamEvent(a, assistant({ type: "tool_use", id: "r1", name: "Read", input: { file_path: "x.ts", limit: 10 } }), new Set());
  recordStreamEvent(a, results({ type: "tool_result", tool_use_id: "r1", content: "conteúdo" }), new Set());
  recordStreamEvent(a, assistant({ type: "tool_use", id: "g1", name: `${MCP_PREFIX}graph_search`, input: { query: "X" } }), new Set());
  recordStreamEvent(a, results({ type: "tool_result", tool_use_id: "g1", content: "achei" }), new Set());
  recordStreamEvent(a, assistant({ type: "text", text: "feito" }), new Set());
  a.finished = true;
  recordStreamEvent(b, assistant({ type: "tool_use", id: "b1", name: "Bash", input: { command: "npm test" } }), new Set());
  recordStreamEvent(b, assistant({ type: "tool_use", id: "b2", name: "Grep", input: { pattern: "x" } }), new Set());
  recordStreamEvent(b, results({ type: "tool_result", tool_use_id: "b1", content: "ok" }), new Set());
  return [a, b];
}

test("turnsToMessages: papéis alternam, nomes e parâmetros do Brito, órfão fechado", () => {
  const msgs = turnsToMessages(twoTurns());
  assert.deepEqual(msgs.map((m) => m.role), ["user", "assistant", "user", "assistant", "user", "assistant", "user", "assistant", "user"]);
  const uses = msgs.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b: any) => b.type === "tool_use") as any[];
  assert.deepEqual(uses.map((u) => u.name), ["read_file", "graph_search", "bash", "grep"]);
  assert.deepEqual(uses[0].input, { path: "x.ts", limit: 10 });
  // assistant "feito" + user do turno 2 viram mensagens separadas; o user do turno 2 é texto puro
  assert.deepEqual(msgs[6], { role: "user", content: [{ type: "text", text: "agora rode os testes" }] });
  // b1 tem resultado; b2 (órfão) ganha tool_result de erro, antes dos resultados reais
  const last = msgs.at(-1)!.content as any[];
  assert.deepEqual(last.map((r) => [r.tool_use_id, !!r.is_error]), [["b2", true], ["b1", false]]);
  assert.equal(last[0].content, ORPHAN_RESULT);
});

test("turnsToMessages: turno que caiu sem resposta junta com o pedido seguinte; órfão no fim ganha mensagem própria", () => {
  const caiu: TurnRecord = { messages: [{ role: "user", content: "pedido 1" }], toolCalls: 0, errors: 0, finished: false };
  const segue: TurnRecord = { messages: [{ role: "user", content: "pedido 2" }], toolCalls: 0, errors: 0, finished: false };
  recordStreamEvent(segue, assistant({ type: "tool_use", id: "w1", name: "Write", input: { file_path: "a.ts", content: "x" } }), new Set());
  const msgs = turnsToMessages([caiu, segue]);
  assert.deepEqual(msgs, [
    { role: "user", content: [{ type: "text", text: "pedido 1" }, { type: "text", text: "pedido 2" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "w1", name: "write_file", input: { path: "a.ts", content: "x" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "w1", content: ORPHAN_RESULT, is_error: true }] },
  ]);
});

test("turnsToMessages não altera os TurnRecord (a reflexão segue com os nomes do claude)", () => {
  const turns = twoTurns();
  const before = JSON.stringify(turns);
  turnsToMessages(turns);
  assert.equal(JSON.stringify(turns), before);
});

test("allTurns guarda todos os turnos; recentTurns só 3; reset zera os dois", async () => {
  const sb = sandbox();
  try {
    const s = fakeSession(sb.root, "logged-out");
    for (let i = 0; i < 4; i++) await s.send(`pedido ${i}`);
    assert.equal(s.allTurns.length, 4);
    assert.equal(s.recentTurns.length, 3);
    assert.equal(s.allTurns[0].messages[0].content, "pedido 0");
    s.reset();
    assert.equal(s.allTurns.length, 0);
    assert.equal(s.recentTurns.length, 0);
  } finally { sb.cleanup(); }
});
