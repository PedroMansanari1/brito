import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { ClaudeSession, recordStreamEvent } from "../src/agent/claude-cli.js";
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
