import { spawn } from "node:child_process";
import os from "node:os";
import type Anthropic from "@anthropic-ai/sdk";
import type { Complete } from "./learn.js";

// Backend sem ANTHROPIC_API_KEY: usa o `claude` oficial (login do usuário). Sem tools nem settings: só julga o transcript.
// O `skill_save` vira saída estruturada ({saves:[…]}) e é convertida de volta em blocos tool_use.

const SCHEMA = {
  type: "object",
  properties: {
    saves: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" }, description: { type: "string" }, body: { type: "string" },
          refs: { type: "array", items: { type: "string" } }, reason: { type: "string" },
          scope: { type: "string", enum: ["project", "global"] },
        },
        required: ["name", "description", "body", "reason"],
      },
    },
  },
  required: ["saves"],
};

const NOTE = `\n\nNeste modo você não chama tools. Em vez de chamar skill_save, devolva JSON {"saves":[…]} com um item por chamada (mesmos campos de skill_save). Se nada vale salvar, devolva {"saves":[]}.`;

export const claudeCliComplete: Complete = ({ model, system, user }) =>
  new Promise((resolve, reject) => {
    const args = ["-p", "--system-prompt", system + NOTE, "--tools", "", "--output-format", "json", "--no-session-persistence",
      "--disable-slash-commands", "--setting-sources", "", "--json-schema", JSON.stringify(SCHEMA)];
    if (model) args.push("--model", model);
    const child = spawn("claude", args, { cwd: os.tmpdir(), stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => {
      try {
        const res = JSON.parse(out);
        if (res.is_error) throw new Error(String(res.result ?? "erro do claude"));
        const saves: Record<string, unknown>[] = res.structured_output?.saves ?? JSON.parse(res.result).saves ?? [];
        resolve(saves.map((s, i) => ({ type: "tool_use", id: `cli-${i}`, name: "skill_save", input: { refs: [], ...s } }) as unknown as Anthropic.ContentBlock));
      } catch (e: any) { reject(new Error(`claude CLI falhou (código ${code}): ${e?.message ?? e} ${err.slice(0, 200)}`)); }
    });
    child.stdin.end(user);
  });
