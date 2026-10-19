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
