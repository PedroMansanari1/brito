import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { GraphLockedError, GraphStore } from "../src/graph/store.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Dois processos no mesmo projeto: o Kùzu só deixa um com o banco aberto. O filho abre o grafo, avisa READY e solta depois de holdMs. */
function holder(root: string, holdMs: number) {
  const code = `const { GraphStore } = await import("./src/graph/store.ts");
    const g = await GraphStore.open(${JSON.stringify(root)});
    console.log("READY");
    setTimeout(async () => { await g.close(); process.exit(0); }, ${holdMs});`;
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
      assert.match(e.message, /em uso por outro processo do Brito/);
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
