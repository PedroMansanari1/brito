import { z } from "zod";
import { defineTool } from "./registry.js";
import { perms } from "../permissions.js";

defineTool({
  name: "exit_plan",
  description: "Só no modo plano: apresenta o plano final ao usuário e pede aprovação para sair do modo plano e executar.",
  schema: z.object({ plan: z.string().min(10).describe("plano completo em markdown: arquivos, mudanças, riscos, verificação") }),
  async run({ plan }, ctx) {
    if (perms.mode !== "plan") return "Você não está no modo plano; siga com a tarefa.";
    const ok = await ctx.ask(`plano proposto — aprovar e sair do modo plano?\n${plan}`, { force: true });
    if (!ok) return "Plano não aprovado. Pergunte o que o usuário quer ajustar e revise o plano.";
    perms.mode = "manual";
    return "Plano aprovado. Modo manual ativo: execute o plano (edições e comandos pedem aprovação).";
  },
});
