import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { GraphStore } from "./store.js";

type OldNote = { id: string; kind: string; text: string; refs: string[]; ts: number };

const READER = `const k = require("kuzu");
const db = new k.Database(process.argv[2], 0, true, true);
const c = new k.Connection(db);
c.query("MATCH (n:Note) RETURN n.id AS id, n.kind AS kind, n.text AS text, n.refs AS refs, n.ts AS ts").then((r) => r.getAll()).then((rows) => {
  process.stdout.write(JSON.stringify(rows, (_, v) => (typeof v === "bigint" ? Number(v) : v)));
  process.exit(0);
});`;

export type MigrateResult = { found: number; added: number; skipped: number } | { none: string };

/** Copia as notas (memória) do grafo antigo (.brito/graph.kuzu) para o novo (.brito/graph.lbug).
 *  O Kùzu só é instalado numa pasta temporária, durante esta chamada: o pacote principal não depende mais dele. */
export async function migrateNotes(root: string, log: (m: string) => void = () => {}): Promise<MigrateResult> {
  const dir = path.join(root, ".brito");
  const old = path.join(dir, "graph.kuzu");
  if (!fs.existsSync(old)) return { none: "não há grafo antigo (.brito/graph.kuzu) neste projeto" };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "brito-migrar-"));
  try {
    // cópia: o original fica intocado e o Kùzu não precisa de lock sobre ele
    fs.copyFileSync(old, path.join(tmp, "g.kuzu"));
    for (const ext of [".wal", ".shadow"]) if (fs.existsSync(old + ext)) fs.copyFileSync(old + ext, path.join(tmp, "g.kuzu" + ext));
    fs.writeFileSync(path.join(tmp, "package.json"), '{"name":"brito-migrar","private":true}');
    fs.writeFileSync(path.join(tmp, "read.cjs"), READER);

    log("baixando o Kùzu (só para esta migração)…");
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const inst = spawnSync(npm, ["i", "kuzu@0.11.3", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: tmp, encoding: "utf8" });
    if (inst.status !== 0) throw new Error(`não consegui instalar o kuzu para ler o banco antigo:\n${inst.stderr || inst.error}`);

    const run = spawnSync(process.execPath, ["read.cjs", "g.kuzu"], { cwd: tmp, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    if (run.status !== 0) throw new Error(`falha ao ler as notas do banco antigo:\n${run.stderr}`);
    const notes: OldNote[] = JSON.parse(run.stdout || "[]");

    const g = await GraphStore.open(root);
    try {
      let added = 0;
      for (const n of notes) {
        const [{ c }] = await g.run("MATCH (x:Note {id:$id}) RETURN count(x) AS c", { id: n.id });
        if (Number(c) > 0) continue; // idempotente: rodar de novo não duplica
        await g.run("CREATE (:Note {id:$id, kind:$k, text:$t, refs:$r, ts:$ts})", { id: n.id, k: n.kind, t: n.text, r: n.refs ?? [], ts: n.ts ?? 0 });
        added++;
      }
      return { found: notes.length, added, skipped: notes.length - added };
    } finally { await g.close(); }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

const markerOf = (root: string) => path.join(root, ".brito", ".notas-migradas");

/** Só no primeiro uso depois da troca de motor: há grafo antigo, ainda não há grafo novo e a pergunta não foi respondida. */
export function pendingNoteMigration(root: string): boolean {
  const dir = path.join(root, ".brito");
  return fs.existsSync(path.join(dir, "graph.kuzu")) && !fs.existsSync(path.join(dir, "graph.lbug")) && !fs.existsSync(markerOf(root));
}

/** Pergunta (uma vez por projeto) e migra as notas. Qualquer resposta, inclusive "não", encerra a pergunta; `brito migrar-notas` continua disponível. */
export async function offerNoteMigration(root: string, ask: (q: string) => Promise<boolean>, log: (m: string) => void): Promise<void> {
  if (!process.stdin.isTTY || !pendingNoteMigration(root)) return;
  const yes = await ask("Este projeto tem um grafo antigo (Kùzu), que pode ter notas (memória). Copiar as notas para o grafo novo? Baixa o Kùzu (~100 MB) só desta vez.");
  fs.writeFileSync(markerOf(root), new Date().toISOString());
  if (!yes) { log("ok, nada copiado. Quando quiser: brito migrar-notas"); return; }
  try {
    const r = await migrateNotes(root, log);
    log("none" in r ? r.none : `${r.added} nota(s) copiada(s) do grafo antigo.`);
  } catch (e) {
    fs.rmSync(markerOf(root), { force: true }); // falhou: pergunta de novo na próxima
    log(`não consegui migrar as notas (${(e as Error).message.split("\n")[0]}). Tente: brito migrar-notas`);
  }
}
