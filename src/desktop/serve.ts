import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import "../tools/fs.js";
import "../tools/bash.js";
import "../tools/graph.js";
import "../tools/delegate.js";
import "../tools/plan.js";
import "../tools/skills.js";
import { Agent } from "../agent/loop.js";
import { ClaudeSession, hasClaudeCli } from "../agent/claude-cli.js";
import { startApprovalServer } from "../agent/approval.js";
import { loadProjectAgents } from "../agent/agents.js";
import { buildSystemPrompt, graphStatsLine } from "../agent/prompt.js";
import type { TurnSink } from "../agent/sink.js";
import { GraphStore } from "../graph/store.js";
import { indexProject } from "../graph/indexer.js";
import { initialEffort, initialModel, isEffort, MODEL_ALIASES } from "../model.js";
import { pickEngine } from "../engine.js";
import { contextWindowFor, resolveModel } from "../provider/resolve.js";
import { PLAN_NOTE, perms, type PermMode } from "../permissions.js";
import { skillsIndex } from "../skills/store.js";
import type { ToolContext } from "../tools/registry.js";

/**
 * Backend do app desktop, controlado por JSON em linhas.
 * stdin  → {t:"send",text} {t:"abort"} {t:"approve",id,allow} {t:"config",model?,effort?,mode?} {t:"reset"} {t:"quit"}
 * stdout → linhas "@@{json}" (qualquer outra linha, como logs perdidos, a janela ignora).
 * Motor: perfil de endpoint (ex.: Qwen) ou ANTHROPIC_API_KEY usam o loop próprio (como o `brito` no terminal); sem
 * nada disso, o `claude` CLI (assinatura).
 */
const MARK = "@@";
const emit = (ev: Record<string, unknown>) => process.stdout.write(MARK + JSON.stringify(ev) + "\n");

const sink: TurnSink = {
  turnStart: () => emit({ t: "turnStart" }),
  turnEnd: (ok = true) => emit({ t: "turnEnd", ok }),
  text: (text) => emit({ t: "text", text }),
  textEnd: () => emit({ t: "textEnd" }),
  thinking: (text) => emit({ t: "thinking", text }),
  toolStart: (id, name, input) => emit({ t: "toolStart", id, name, input }),
  toolEnd: (id, isError, output) => emit({ t: "toolEnd", id, isError, output: (output ?? "").slice(0, 4000) }),
  info: (msg) => emit({ t: "info", msg }),
  warn: (msg) => emit({ t: "warn", msg }),
  error: (msg) => emit({ t: "error", msg }),
};

/** O que a janela precisa de um motor, seja a API direta ou o claude CLI. */
interface Engine {
  kind: "api" | "claude";
  sessionId: string;
  model: string;
  effort: string;
  setModel(id: string): void;
  send(text: string): Promise<void>;
  abort(): void;
  reset(): void;
  stats(): { usage: unknown; contextTokens: number; contextWindow?: number; costUsd: number };
  close(): Promise<void>;
}


export async function serveDesktop(root: string, resumeId?: string): Promise<void> {
  const pending = new Map<string, (ok: boolean) => void>();
  const ask = (text: string, opts?: { force?: boolean }) =>
    perms.mode === "bypass" && !opts?.force ? Promise.resolve(true) : new Promise<boolean>((resolve) => {
      const id = randomUUID();
      pending.set(id, resolve);
      emit({ t: "approval", id, text, force: !!opts?.force });
    });

  // Na pasta pessoal (projeto "Home") indexar tudo seria enorme e inútil: sem índice ali.
  const isHome = path.resolve(root) === path.resolve(os.homedir());
  const startModel = initialModel();
  const picked = pickEngine(startModel, process.env, hasClaudeCli);
  const useApi = picked.kind === "api";
  if (picked.kind === "error") {
    const msg = resolveModel(startModel).kind === "openai" ? picked.message : "Sem acesso ao modelo: defina ANTHROPIC_API_KEY (no seu shell) ou instale o Claude Code e rode `claude` → /login.";
    emit({ t: "error", msg });
    process.exit(1);
  }
  loadProjectAgents(root);

  let engine: Engine;
  let syms = 0, notes = 0;
  let closeApproval = () => {};

  if (useApi) {
    // API direta: o grafo fica aberto neste processo (sem servidor MCP), como no `brito` do terminal.
    // No Home o banco vai para ~/.brito/home-graph, para não criar .brito dentro da pasta pessoal.
    const graphRoot = isHome ? path.join(os.homedir(), ".brito", "home-graph") : root;
    fs.mkdirSync(graphRoot, { recursive: true });
    const graph = await GraphStore.open(graphRoot);
    const sync = async () => { if (!isHome) syms = (await indexProject(root, graph)).symbols; };
    emit({ t: "info", msg: "sincronizando grafo…" });
    try { await sync(); } catch (e: any) { emit({ t: "warn", msg: `grafo indisponível: ${e?.message ?? e}` }); }
    try { notes = Number((await graph.run("MATCH (s:Note) RETURN count(s) AS n"))[0].n); } catch { /* sem notas */ }
    const ctx: ToolContext = { root, graph, ask, sync, dirty: false, loadedSkills: new Set(), model: () => agent.model };
    const agent = new Agent(
      () => buildSystemPrompt(root, graphStatsLine(syms, notes, "now"), skillsIndex(root)) + (perms.mode === "plan" ? PLAN_NOTE : ""),
      ctx, { model: startModel, sink },
    );
    let ac: AbortController | null = null;
    const id = randomUUID();
    if (resumeId) emit({ t: "info", msg: "No modo API o histórico da conversa não é retomado ao reabrir; a tela mostra o que já foi dito, mas o modelo recomeça." });
    engine = {
      kind: "api", sessionId: id, effort: "",
      get model() { return agent.model; }, set model(m: string) { agent.model = m; },
      setModel: (m) => { agent.model = m; },
      async send(text) {
        ac = new AbortController();
        sink.turnStart();
        let ok = true;
        try { await agent.send(text, ac.signal); } catch (e: any) { ok = false; ac.signal.aborted ? sink.warn("⏹ interrompido") : sink.error(e?.message ?? String(e)); } finally { sink.turnEnd(ok); ac = null; }
      },
      abort: () => ac?.abort(),
      reset: () => { agent.messages = []; agent.contextTokens = 0; agent.recentTurns = []; agent.lastTurn = null; },
      stats: () => ({ usage: agent.usage, contextTokens: agent.contextTokens, contextWindow: contextWindowFor(agent.model), costUsd: 0 }),
      close: async () => { await graph.close(); },
    } as Engine;
  } else {
    const approval = startApprovalServer({ ask });
    closeApproval = approval.close;
    // O banco aceita um único processo com escrita: indexa, lê as stats e solta o banco para o servidor MCP.
    if (!isHome) try {
      const graph = await GraphStore.open(root);
      emit({ t: "info", msg: "sincronizando grafo…" });
      await indexProject(root, graph);
      syms = Number((await graph.run("MATCH (s:Symbol) RETURN count(s) AS n"))[0].n);
      notes = Number((await graph.run("MATCH (s:Note) RETURN count(s) AS n"))[0].n);
      await graph.close();
    } catch (e: any) { emit({ t: "warn", msg: `grafo indisponível: ${e?.message ?? e}` }); }
    const session = new ClaudeSession({
      root, approvalSock: approval.path, stats: graphStatsLine(syms, notes, "start"), sink,
      mcpCommand: { command: process.execPath, args: [...process.execArgv, process.argv[1], "mcp-serve", "-d", root] },
      // Dentro do Electron o executável é o próprio app: este env o faz agir como Node nos filhos (claude → mcp-serve).
      env: process.versions.electron || process.env.ELECTRON_RUN_AS_NODE ? { ELECTRON_RUN_AS_NODE: "1" } : undefined,
    });
    if (resumeId) session.resume(resumeId);
    session.effort = initialEffort();
    engine = {
      kind: "claude",
      get sessionId() { return session.sessionId; },
      get model() { return session.model; },
      get effort() { return session.effort; }, set effort(e: string) { session.effort = e; },
      setModel: (m) => { session.requestedModel = m; session.model = m || "claude (assinatura)"; },
      send: async (text) => { await session.send(text); },
      abort: () => session.abort(),
      reset: () => session.reset(),
      stats: () => ({ usage: session.usage, contextTokens: session.contextTokens, contextWindow: session.contextWindow, costUsd: session.costUsd }),
      close: async () => {},
    } as Engine;
  }

  let busy = false;
  const ready = () => emit({ t: "ready", engine: engine.kind, sessionId: engine.sessionId, model: engine.model, effort: engine.effort, mode: perms.mode, symbols: syms, notes, root });
  ready();

  const rl = readline.createInterface({ input: process.stdin });
  const quit = async () => { closeApproval(); try { await engine.close(); } catch { /* saindo */ } process.exit(0); };
  rl.on("close", quit);
  rl.on("line", async (line) => {
    let m: any;
    try { m = JSON.parse(line); } catch { return; }
    switch (m.t) {
      case "send": {
        if (busy) return emit({ t: "warn", msg: "já existe um turno em andamento" });
        busy = true;
        try { await engine.send(String(m.text ?? "")); } finally {
          busy = false;
          emit({ t: "usage", ...engine.stats(), model: engine.model, sessionId: engine.sessionId });
        }
        break;
      }
      case "abort": engine.abort(); break;
      case "approve": pending.get(m.id)?.(!!m.allow); pending.delete(m.id); break;
      case "config": {
        if (typeof m.model === "string" && m.model) engine.setModel(MODEL_ALIASES[m.model] ?? m.model);
        else if (m.model === "") engine.setModel(engine.kind === "api" ? initialModel() : ""); // padrão = modelo/perfil salvo
        if (m.effort !== undefined) engine.effort = isEffort(m.effort) ? m.effort : "";
        if (["manual", "auto", "plan", "bypass"].includes(m.mode)) perms.mode = m.mode as PermMode;
        ready();
        break;
      }
      case "reset": engine.reset(); ready(); break;
      case "quit": await quit(); break;
    }
  });
}
