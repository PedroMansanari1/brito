import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Diferenças do Windows que o resto do código não deve conhecer:
 * - `claudeCommand`: o `claude` instalado via npm é um shim `claude.cmd`, que o Node não executa sem shell (ENOENT/EINVAL), e
 *   `shell: true` quebraria as aspas do system prompt e do JSON do --mcp-config. Aqui resolvemos o alvo real do shim.
 * - `shellFor`: `exec` cai no cmd.exe, mas o modelo escreve comandos de bash; usa o Git Bash quando existe.
 */

export interface Command { command: string; args: string[] }

let claudeCache: { command: string; prefix: string[] } | undefined;

/** Alvo real de um shim npm (`claude.cmd`): `"%dp0%\caminho\cli.js"` ou `...\claude.exe`. */
export function resolveCmdShim(shimPath: string, content: string): { command: string; prefix: string[] } | null {
  const target = content.match(/"%dp0%\\([^"]+)"/)?.[1];
  if (!target) return null;
  const file = path.win32.join(path.win32.dirname(shimPath), target);
  if (/\.exe$/i.test(file)) return { command: file, prefix: [] };
  if (/\.(c|m)?js$/i.test(file)) return { command: process.execPath, prefix: [file] };
  return null;
}

function findClaude(): { command: string; prefix: string[] } {
  const found = spawnSync("where", ["claude"], { encoding: "utf8" }).stdout?.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) ?? [];
  const exe = found.find((f) => /\.exe$/i.test(f));
  if (exe) return { command: exe, prefix: [] };
  for (const f of found.filter((x) => /\.cmd$/i.test(x))) {
    try {
      const r = resolveCmdShim(f, fs.readFileSync(f, "utf8"));
      if (r && fs.existsSync(r.prefix[0] ?? r.command)) return r;
    } catch { /* shim ilegível: tenta o próximo */ }
  }
  return { command: "claude", prefix: [] };
}

/** Comando e argumentos para executar o `claude` com segurança em qualquer sistema. */
export function claudeCommand(args: string[]): Command {
  if (process.platform !== "win32") return { command: "claude", args };
  claudeCache ??= findClaude();
  return { command: claudeCache.command, args: [...claudeCache.prefix, ...args] };
}

let shellCache: string | undefined | null = null;

/** Shell para `exec`: `BRITO_SHELL` > Git Bash (só no Windows) > padrão do sistema (undefined). */
export function shellFor(): string | undefined {
  if (process.env.BRITO_SHELL) return process.env.BRITO_SHELL;
  if (process.platform !== "win32") return undefined;
  if (shellCache !== null) return shellCache;
  const roots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs")].filter((r): r is string => !!r);
  shellCache = roots.map((r) => path.join(r, "Git", "bin", "bash.exe")).find((p) => fs.existsSync(p));
  return shellCache;
}

/** Linha para o system prompt dizendo qual shell o comando `bash` usa de fato (só no Windows; nos outros é bash/sh). */
export function shellNote(): string {
  if (process.platform !== "win32") return "";
  return shellFor() ? "\nShell dos comandos: Git Bash (sintaxe bash)." : "\nShell dos comandos: cmd.exe do Windows (não há bash): use dir/type/findstr e sintaxe do cmd, não ls/cat/grep.";
}
