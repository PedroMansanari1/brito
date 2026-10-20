import type Anthropic from "@anthropic-ai/sdk";
import { toApiTools, execTool, isConcurrent, type ToolContext } from "../tools/registry.js";
import { estimateTokens, summarizeMiddle, trimOldToolResults } from "./context.js";
import { ui as terminalUi } from "../ui/ui.js";
import type { TurnSink } from "./sink.js";
import { initialEffort, initialModel } from "../model.js";
import { providerFor } from "../provider/index.js";
import { compactAtFor, resolveModel } from "../provider/resolve.js";
import type { OutBlock } from "../provider/types.js";
import { fmtBytes, findImages, imageBlock, splitOversize } from "../util/images.js";

export const MODEL = initialModel();

export interface AgentOptions {
  model?: string;
  maxSteps?: number;
  /** allowlist de tools; indefinido = todas */
  tools?: Set<string>;
  /** não imprime o texto em streaming (subagentes) */
  quiet?: boolean;
  log?: (s: string) => void;
  /** destino do texto e das ferramentas do turno; padrão = terminal */
  sink?: TurnSink;
}

/** Registro do último turno, usado pela reflexão que cria/melhora skills. */
export interface TurnRecord {
  messages: Anthropic.MessageParam[];
  toolCalls: number;
  errors: number;
  finished: boolean;
}

export class Agent {
  messages: Anthropic.MessageParam[] = [];
  usage = { input: 0, output: 0, cacheRead: 0, steps: 0 };
  /** tamanho do contexto na última requisição (alimenta a barra de status) */
  contextTokens = 0;
  /** troca em runtime via `/model`; vale a partir da próxima requisição */
  model: string;
  /** esforço de raciocínio (`/reasoning`); `none` desliga o raciocínio em endpoints que permitem */
  effort = initialEffort();
  lastTurn: TurnRecord | null = null;
  /** últimos turnos (o mais novo por último): o anterior dá contexto a correções do usuário */
  recentTurns: TurnRecord[] = [];
  private maxSteps: number;
  private log: (s: string) => void;
  private ui: TurnSink;

  constructor(private system: string | (() => string), private ctx: ToolContext, private opts: AgentOptions = {}) {
    this.model = opts.model ?? MODEL;
    this.maxSteps = opts.maxSteps ?? 40;
    this.ui = opts.sink ?? terminalUi;
    this.log = opts.log ?? ((s) => this.ui.info(s));
  }

  /** Roda um turno completo (até não haver mais tool_use) e devolve o texto final. */
  async send(userText: string, signal?: AbortSignal): Promise<string> {
    try {
      return await this.run(userText, signal);
    } catch (e) {
      if (signal?.aborted) { this.repairAfterAbort(); throw new Error("interrompido"); }
      throw e;
    }
  }

  /** Após Ctrl+C, evita deixar um tool_use sem tool_result no histórico (a API recusaria o próximo turno). */
  private repairAfterAbort() {
    const last = this.messages[this.messages.length - 1];
    if (last?.role !== "assistant" || typeof last.content === "string") return;
    const pending = last.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (pending.length) this.messages.push({ role: "user", content: pending.map((u) => ({ type: "tool_result" as const, tool_use_id: u.id, content: "Interrompido pelo usuário.", is_error: true })) });
  }

  private async run(userText: string, signal?: AbortSignal): Promise<string> {
    const turn: TurnRecord = { messages: [], toolCalls: 0, errors: 0, finished: false };
    this.lastTurn = turn;
    this.recentTurns = [...this.recentTurns, turn].slice(-3);
    const push = (m: Anthropic.MessageParam) => { this.messages.push(m); turn.messages.push(m); };
    // Imagens arrastadas para o terminal chegam como caminhos no texto: anexa como blocos `image`. O registro do turno
    // (usado na reflexão) guarda só o texto, para não carregar base64.
    const { ok, tooBig } = splitOversize(findImages(userText, this.ctx.root));
    for (const i of tooBig) this.log(`⚠ ${i.name} passa de 5 MB e não foi anexada`);
    if (ok.length) {
      const target = resolveModel(this.model);
      if (target.kind === "openai" && !target.profile!.vision)
        this.log(`⚠ o modelo ${target.label} não aceita imagens; ${ok.length > 1 ? `${ok.length} imagens não foram enviadas` : "a imagem não foi enviada"} (vision: true no perfil liga)`);
      this.log(`🖼 ${ok.map((i) => `${i.name} (${fmtBytes(i.bytes)})`).join(", ")} anexada${ok.length > 1 ? "s" : ""}`);
      this.messages.push({ role: "user", content: [...ok.map(imageBlock), { type: "text", text: userText }] });
      turn.messages.push({ role: "user", content: userText });
    } else push({ role: "user", content: userText });
    await this.compactIfNeeded();
    let finalText = "";

    for (let step = 0; step < this.maxSteps; step++) {
      if (signal?.aborted) throw new Error("abort");
      const msg = await providerFor(this.model).send(
        {
          model: this.model,
          maxTokens: 8192,
          system: typeof this.system === "function" ? this.system() : this.system,
          tools: toApiTools(this.opts.tools),
          messages: this.messages,
          thinking: this.effort !== "none",
        },
        { signal, onText: this.opts.quiet ? undefined : (t) => this.ui.text(t), onThinking: this.opts.quiet ? undefined : (t) => this.ui.thinking(t) },
      );
      this.contextTokens = msg.usage.input;
      this.usage.input += msg.usage.input;
      this.usage.output += msg.usage.output;
      this.usage.cacheRead += msg.usage.cacheRead;
      this.usage.steps++;
      push({ role: "assistant", content: msg.content });

      const text = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      if (text) finalText = text;
      if (!this.opts.quiet) this.ui.textEnd();

      const uses = msg.content.filter((b): b is Extract<OutBlock, { type: "tool_use" }> => b.type === "tool_use");
      if (msg.stopReason !== "tool_use" || uses.length === 0) { turn.finished = true; return finalText; }

      const runOne = async (u: Extract<OutBlock, { type: "tool_use" }>): Promise<Anthropic.ToolResultBlockParam> => {
        const t0 = Date.now();
        if (!this.opts.quiet) this.ui.toolStart(u.id, u.name, u.input);
        const denied = this.opts.tools && !this.opts.tools.has(u.name);
        const r = denied ? { text: `Tool não permitida para este agente: ${u.name}`, isError: true } : await execTool(u.name, u.input, this.ctx);
        if (this.opts.quiet) this.log(terminalUi.toolLine(u.name, u.input, Date.now() - t0, r.isError));
        else this.ui.toolEnd(u.id, r.isError, r.text);
        return { type: "tool_result", tool_use_id: u.id, content: r.text.slice(0, 40_000), is_error: r.isError };
      };

      // Leituras puras rodam em paralelo; qualquer escrita/aprovação força execução em série.
      const results: Anthropic.ToolResultBlockParam[] = uses.every((u) => isConcurrent(u.name, u.input))
        ? await Promise.all(uses.map(runOne))
        : await uses.reduce<Promise<Anthropic.ToolResultBlockParam[]>>(async (acc, u) => [...(await acc), await runOne(u)], Promise.resolve([]));
      turn.toolCalls += results.length;
      turn.errors += results.filter((r) => r.is_error).length;
      push({ role: "user", content: results });
      await this.compactIfNeeded();
    }
    this.ui.warn("Limite de passos atingido.");
    return finalText || "(limite de passos atingido sem resposta final)";
  }

  async compactIfNeeded() {
    if (estimateTokens(this.messages) < compactAtFor(this.model)) return;
    this.messages = trimOldToolResults(this.messages);
    if (estimateTokens(this.messages) < compactAtFor(this.model)) return;
    this.log("compactando contexto…");
    this.messages = await summarizeMiddle(this.model, this.messages);
    this.contextTokens = estimateTokens(this.messages); // até a próxima chamada real, a barra não fica com o valor antigo
  }
}
