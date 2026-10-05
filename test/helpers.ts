import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ToolContext } from "../src/tools/registry.js";

/** Projeto e BRITO_HOME temporários, para nada tocar no ~/.brito real. */
export function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "brito-root-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "brito-home-"));
  process.env.BRITO_HOME = home;
  const ctx = { root, graph: {} as any, ask: async () => true, sync: async () => {}, dirty: false, loadedSkills: new Set<string>() } as ToolContext;
  return { root, home, ctx, cleanup: () => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); } };
}

export const GOOD_BODY = "## Quando usar\nAo adicionar uma tool nova.\n\n## Passos\n1. Criar o arquivo em src/tools.\n2. Registrar com defineTool.\n\n## Verificação\nnpm run typecheck";
