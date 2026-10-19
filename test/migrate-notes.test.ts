import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { offerNoteMigration, pendingNoteMigration } from "../src/graph/migrate.js";

const proj = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "brito-mig-"));
  fs.mkdirSync(path.join(root, ".brito"));
  return root;
};
const withTTY = async (fn: () => Promise<void>) => {
  const d = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  try { await fn(); } finally { d ? Object.defineProperty(process.stdin, "isTTY", d) : delete (process.stdin as any).isTTY; }
};

test("migração de notas: só é pendente com grafo antigo, sem grafo novo e sem resposta anterior", () => {
  const root = proj();
  try {
    assert.equal(pendingNoteMigration(root), false); // projeto novo
    fs.writeFileSync(path.join(root, ".brito", "graph.kuzu"), "x");
    assert.equal(pendingNoteMigration(root), true);
    fs.writeFileSync(path.join(root, ".brito", "graph.lbug"), "x");
    assert.equal(pendingNoteMigration(root), false); // já usa o motor novo
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("migração de notas: responder não não baixa nada e a pergunta não se repete", async () => {
  const root = proj();
  fs.writeFileSync(path.join(root, ".brito", "graph.kuzu"), "x");
  try {
    await withTTY(async () => {
      let asked = 0; const logs: string[] = [];
      await offerNoteMigration(root, async () => { asked++; return false; }, (m) => logs.push(m));
      await offerNoteMigration(root, async () => { asked++; return true; }, (m) => logs.push(m));
      assert.equal(asked, 1);
      assert.match(logs.join("\n"), /brito migrar-notas/);
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("migração de notas: sem terminal interativo (MCP, scripts) não pergunta", async () => {
  const root = proj();
  fs.writeFileSync(path.join(root, ".brito", "graph.kuzu"), "x");
  try {
    let asked = 0;
    await offerNoteMigration(root, async () => { asked++; return true; }, () => {});
    assert.equal(asked, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
