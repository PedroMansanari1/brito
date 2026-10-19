import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { GraphLockedError, GraphStore } from "../src/graph/store.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Processo externo segurando o lock de escrita do Kùzu. O filho abre o banco, avisa READY e solta depois de holdMs. */
function holder(root: string, holdMs: number) {
  const code = `const kuzu = (await import("@ladybugdb/core")).default;
    const fs = await import("node:fs"); const path = await import("node:path");
    fs.mkdirSync(path.join(${JSON.stringify(root)}, ".brito"), { recursive: true });
    const db = new kuzu.Database(path.join(${JSON.stringify(root)}, ".brito", "graph.lbug"));
    const conn = new kuzu.Connection(db);
    await (await conn.query("CREATE NODE TABLE IF NOT EXISTS T(id STRING, PRIMARY KEY(id))")).close();
    console.log("READY");
    setTimeout(async () => { await conn.close(); await db.close(); process.exit(0); }, ${holdMs});`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
  const ready = new Promise<void>((resolve, reject) => {
    child.stdout.on("data", (d) => { if (String(d).includes("READY")) resolve(); });
    child.on("exit", (c) => reject(new Error(`o processo que segura o banco saiu antes de ficar pronto (${c})`)));
  });
  const exited = new Promise<void>((r) => child.on("exit", () => r()));
  return { ready, exited, kill: () => child.kill("SIGKILL") };
}

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "brito-lock-"));

test("GraphStore.open: com o banco preso por outro processo, desiste com GraphLockedError claro (sem a stack do kuzu)", { timeout: 60_000 }, async () => {
  const root = tmpRoot();
  const h = holder(root, 30_000);
  try {
    await h.ready;
    const t = Date.now();
    await assert.rejects(GraphStore.open(root, 600), (e: Error) => {
      assert.ok(e instanceof GraphLockedError);
      assert.match(e.message, /gravando no grafo deste projeto/);
      assert.doesNotMatch(e.message, /Could not set lock|IO exception/);
      return true;
    });
    assert.ok(Date.now() - t >= 500, "esperou antes de desistir");
  } finally { h.kill(); await h.exited; fs.rmSync(root, { recursive: true, force: true }); }
});

test("GraphStore.open: se o outro processo soltar o banco dentro da espera, abre normalmente", { timeout: 60_000 }, async () => {
  const root = tmpRoot();
  const h = holder(root, 1200);
  try {
    await h.ready;
    const g = await GraphStore.open(root, 15_000);
    assert.deepEqual(await g.run("MATCH (f:File) RETURN count(f) AS n"), [{ n: 0 }]);
    await g.close();
  } finally { h.kill(); await h.exited; fs.rmSync(root, { recursive: true, force: true }); }
});

test("GraphStore: dois processos no mesmo projeto convivem (o lock só dura enquanto há consulta)", { timeout: 60_000 }, async () => {
  const root = tmpRoot();
  const writer = (tag: string) => new Promise<number>((resolve) => {
    const code = `const { GraphStore } = await import("./src/graph/store.ts");
      const g = await GraphStore.open(${JSON.stringify(root)});
      for (let i = 0; i < 15; i++) {
        await g.run("CREATE (:Note {id:$id, kind:'t', text:'x', refs:[], ts:1})", { id: "${tag}" + i });
        await g.run("MATCH (n:Note) RETURN count(n) AS n");
        await new Promise((r) => setTimeout(r, 40));
      }
      await g.close();`;
    spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { cwd: REPO, stdio: "ignore" }).on("exit", (c) => resolve(c ?? 1));
  });
  try {
    const codes = await Promise.all([writer("a"), writer("b")]);
    assert.deepEqual(codes, [0, 0]);
    const g = await GraphStore.open(root);
    assert.deepEqual(await g.run("MATCH (n:Note) RETURN count(n) AS n"), [{ n: 30 }]);
    await g.close();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
