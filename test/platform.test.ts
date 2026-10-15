import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveCmdShim, shellFor, shellNote } from "../src/util/platform.js";

const SHIM_JS = `@ECHO off\r\nSET dp0=%~dp0\r\n"%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n`;
const SHIM_EXE = `@ECHO off\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n`;

test("resolveCmdShim: shim npm aponta para cli.js (roda via node) ou para claude.exe", () => {
  const js = resolveCmdShim("C:\\Users\\a\\AppData\\Roaming\\npm\\claude.cmd", SHIM_JS);
  assert.equal(js?.command, process.execPath);
  assert.equal(js?.prefix[0], "C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js");
  const exe = resolveCmdShim("C:\\Users\\a\\AppData\\Roaming\\npm\\claude.cmd", SHIM_EXE);
  assert.equal(exe?.command, "C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe");
  assert.deepEqual(exe?.prefix, []);
  assert.equal(resolveCmdShim("C:\\x\\claude.cmd", "@echo nada"), null);
});

test("shellFor: BRITO_SHELL tem prioridade; fora do Windows usa o padrão do sistema", () => {
  const prev = process.env.BRITO_SHELL;
  try {
    process.env.BRITO_SHELL = "C:\\Git\\bin\\bash.exe";
    assert.equal(shellFor(), "C:\\Git\\bin\\bash.exe");
    delete process.env.BRITO_SHELL;
    if (process.platform !== "win32") { assert.equal(shellFor(), undefined); assert.equal(shellNote(), ""); }
  } finally { if (prev === undefined) delete process.env.BRITO_SHELL; else process.env.BRITO_SHELL = prev; }
});
