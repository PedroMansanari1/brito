import type Parser from "web-tree-sitter";
import fs from "node:fs";
import path from "node:path";

/**
 * Linguagens de backend além de TS/JS/Python: Java, Kotlin, Go, Ruby, PHP, C# e Rust.
 * Cada uma é um conjunto de "hooks" que diz ao percorredor genérico o que é tipo, função, chamada e import naquela
 * gramática; a resolução (import → arquivo) fica em ProjectIndex. Para suportar outra linguagem: ver o fim do arquivo.
 */
type N = Parser.SyntaxNode;

export interface Sym { id: string; name: string; kind: string; file: string; startLine: number; endLine: number }
/** obj: "" = chamada solta; "@" = chamada solta dentro de classe (this implícito); "this"/"self"; "?" = valor não nomeado */
export interface Call { callerId: string | null; callee: string; obj: string; file: string }
/** [nome local, especificador do módulo, nome importado | "default" | "*"] */
export type Binding = [string, string, string];
export interface Extracted { syms: Sym[]; calls: Call[]; imports: string[]; bindings: Binding[] }

export type ExtraLang = "java" | "kotlin" | "go" | "ruby" | "php" | "c_sharp" | "rust";
export const EXTRA_EXT: Record<string, ExtraLang> = {
  ".java": "java", ".kt": "kotlin", ".go": "go", ".rb": "ruby", ".php": "php", ".cs": "c_sharp", ".rs": "rust",
};
export const isExtraLang = (l: string): l is ExtraLang => l in HOOKS;

interface FuncInfo { name: string; cls?: string; self?: string | null }
interface Acc { imports: string[]; bindings: Binding[] }
interface Hooks {
  /** Chamada solta dentro de classe é chamada em this (Java, Kotlin, C#, Ruby). */
  implicitSelf: boolean;
  type?(n: N): { name: string; kind: string } | null;
  /** Abre um contexto de tipo sem declarar símbolo (impl do Rust). */
  scope?(n: N): string | null;
  func?(n: N): FuncInfo | null;
  call?(n: N, self: string | null): { name: string; obj: string } | null;
  imports?(n: N, acc: Acc): void;
}

const f = (n: N, name: string) => n.childForFieldName(name);
const nameOf = (n: N) => f(n, "name")?.text || null;
const lastSeg = (s: string) => s.split(/[.\\/:]+/).filter(Boolean).pop() ?? s;
const SELF_TYPES = new Set(["this", "this_expression", "self"]);
const IDENT_TYPES = new Set(["identifier", "simple_identifier", "constant", "type_identifier", "name", "field_identifier", "property_identifier"]);

/** x.y / x->y / x::y: separa a base do nome do membro, em qualquer gramática. */
function member(n: N): { base: N; name: string } | null {
  switch (n.type) {
    case "field_access": { const b = f(n, "object"), m = f(n, "field"); return b && m ? { base: b, name: m.text } : null; }
    case "member_access_expression": case "nullsafe_member_access_expression": {
      const b = f(n, "object") ?? f(n, "expression"), m = f(n, "name");
      return b && m ? { base: b, name: m.text } : null;
    }
    case "field_expression": { const b = f(n, "value"), m = f(n, "field"); return b && m ? { base: b, name: m.text } : null; }
    case "selector_expression": { const b = f(n, "operand"), m = f(n, "field"); return b && m ? { base: b, name: m.text } : null; }
    case "navigation_expression": {
      const b = n.namedChild(0), m = n.namedChildren.filter((c) => c.type === "navigation_suffix").pop()?.namedChild(0);
      return b && m ? { base: b, name: m.text } : null;
    }
  }
  return null;
}

const isSelf = (n: N, self: string | null) =>
  SELF_TYPES.has(n.type) || n.text === "$this" || (!!self && n.type === "identifier" && n.text === self);

/** O "obj" de uma chamada: this, o nome da variável/tipo, o nome do campo (this.repo.x() → "repo") ou "?". */
function objOf(o: N | null, self: string | null): string {
  if (!o) return "";
  if (isSelf(o, self)) return "this";
  if (IDENT_TYPES.has(o.type) || o.type === "variable_name") return o.text.replace(/^\$/, "");
  if (o.type === "scoped_identifier" || o.type === "qualified_name" || o.type === "scope_resolution") return lastSeg(o.text);
  const m = member(o);
  if (m && isSelf(m.base, self)) return m.name;
  return "?";
}

function ofTypes(map: Record<string, string>) {
  return (n: N) => {
    const kind = map[n.type];
    const name = kind ? nameOf(n) : null;
    return name ? { name, kind } : null;
  };
}

// ───────────── Java ─────────────

const java: Hooks = {
  implicitSelf: true,
  type: ofTypes({ class_declaration: "class", interface_declaration: "interface", enum_declaration: "enum", record_declaration: "class", annotation_type_declaration: "interface" }),
  func: (n) => (n.type === "method_declaration" || n.type === "constructor_declaration") && nameOf(n) ? { name: nameOf(n)! } : null,
  call: (n, self) => {
    if (n.type !== "method_invocation") return null;
    const name = nameOf(n);
    return name ? { name, obj: objOf(f(n, "object"), self) } : null;
  },
  imports: (n, acc) => {
    if (n.type !== "import_declaration") return;
    const id = n.namedChildren.find((c) => c.type === "scoped_identifier" || c.type === "identifier");
    if (!id) return;
    acc.imports.push(id.text);
    if (!n.children.some((c) => c.type === "asterisk")) acc.bindings.push([lastSeg(id.text), id.text, lastSeg(id.text)]);
  },
};

// ───────────── Kotlin ─────────────

const kotlin: Hooks = {
  implicitSelf: true,
  type: (n) => {
    if (n.type !== "class_declaration" && n.type !== "object_declaration") return null;
    const name = n.namedChildren.find((c) => c.type === "type_identifier")?.text;
    if (!name) return null;
    const kind = n.children.some((c) => c.type === "interface") ? "interface" : /\benum\b/.test(n.namedChildren.find((c) => c.type === "modifiers")?.text ?? "") ? "enum" : "class";
    return { name, kind };
  },
  func: (n) => {
    const name = n.type === "function_declaration" ? n.namedChildren.find((c) => c.type === "simple_identifier")?.text : null;
    return name ? { name } : null;
  },
  call: (n, self) => {
    if (n.type !== "call_expression") return null;
    const callee = n.namedChild(0);
    if (!callee) return null;
    if (callee.type === "simple_identifier") return { name: callee.text, obj: "" };
    const m = member(callee);
    return m ? { name: m.name, obj: objOf(m.base, self) } : null;
  },
  imports: (n, acc) => {
    if (n.type !== "import_header") return;
    const id = n.namedChildren.find((c) => c.type === "identifier");
    if (!id) return;
    acc.imports.push(id.text);
    if (!n.text.includes("*")) {
      const alias = n.namedChildren.find((c) => c.type === "import_alias")?.namedChild(0)?.text;
      acc.bindings.push([alias ?? lastSeg(id.text), id.text, lastSeg(id.text)]);
    }
  },
};

// ───────────── Go ─────────────

/** Nome do tipo do receiver: `(s *Service)` → "Service". */
function goReceiver(n: N): { type: string; self: string | null } | null {
  const p = f(n, "receiver")?.namedChildren.find((c) => c.type === "parameter_declaration");
  if (!p) return null;
  let t: N | null = f(p, "type");
  while (t && t.type !== "type_identifier") t = t.namedChild(0);
  return t ? { type: t.text, self: f(p, "name")?.text ?? null } : null;
}

const go: Hooks = {
  implicitSelf: false,
  type: (n) => {
    if (n.type !== "type_spec" && n.type !== "type_alias") return null;
    const name = nameOf(n);
    if (!name) return null;
    const t = f(n, "type")?.type;
    return { name, kind: t === "struct_type" ? "struct" : t === "interface_type" ? "interface" : "type" };
  },
  func: (n) => {
    const name = nameOf(n);
    if (!name) return null;
    if (n.type === "function_declaration") return { name };
    if (n.type !== "method_declaration") return null;
    const r = goReceiver(n);
    return { name, cls: r?.type, self: r?.self ?? null };
  },
  call: (n, self) => {
    if (n.type !== "call_expression") return null;
    const fn = f(n, "function");
    if (!fn) return null;
    if (fn.type === "identifier") return { name: fn.text, obj: "" };
    const m = member(fn);
    return m ? { name: m.name, obj: objOf(m.base, self) } : null;
  },
  imports: (n, acc) => {
    if (n.type !== "import_spec") return;
    const spec = f(n, "path")?.text.replace(/^["`]|["`]$/g, "");
    if (!spec) return;
    acc.imports.push(spec);
    const alias = f(n, "name")?.text;
    if (alias === "_" || alias === ".") return;
    const segs = spec.split("/");
    const last = /^v\d+$/.test(segs[segs.length - 1]) && segs.length > 1 ? segs[segs.length - 2] : segs[segs.length - 1];
    acc.bindings.push([alias ?? last.replace(/^go-|\.go$/g, "").replace(/[.-].*$/, ""), spec, "*"]);
  },
};

// ───────────── Ruby ─────────────

const RUBY_SKIP = new Set(["require", "require_relative", "load", "include", "extend", "prepend", "attr_accessor", "attr_reader", "attr_writer", "private", "public", "protected", "module_function", "raise", "puts", "p", "print"]);

const ruby: Hooks = {
  implicitSelf: true,
  type: (n) => {
    if (n.type !== "class" && n.type !== "module") return null;
    const name = f(n, "name");
    return name ? { name: lastSeg(name.text), kind: n.type === "module" ? "module" : "class" } : null;
  },
  func: (n) => (n.type === "method" || n.type === "singleton_method") && nameOf(n) ? { name: nameOf(n)! } : null,
  call: (n, self) => {
    if (n.type !== "call") return null;
    const name = f(n, "method")?.text;
    if (!name) return null;
    const recv = f(n, "receiver");
    if (!recv && RUBY_SKIP.has(name)) return null;
    return { name, obj: objOf(recv, self) };
  },
  imports: (n, acc) => {
    if (n.type !== "call" || f(n, "receiver")) return;
    const m = f(n, "method")?.text;
    if (m !== "require" && m !== "require_relative" && m !== "load") return;
    const arg = f(n, "arguments")?.namedChild(0);
    const spec = arg?.type === "string" ? arg.namedChildren.find((c) => c.type === "string_content")?.text : null;
    if (spec) acc.imports.push(m === "require_relative" ? (spec.startsWith(".") ? spec : "./" + spec) : spec);
  },
};

// ───────────── PHP ─────────────

const php: Hooks = {
  implicitSelf: false,
  type: ofTypes({ class_declaration: "class", interface_declaration: "interface", trait_declaration: "trait", enum_declaration: "enum" }),
  func: (n) => (n.type === "method_declaration" || n.type === "function_definition") && nameOf(n) ? { name: nameOf(n)! } : null,
  call: (n, self) => {
    switch (n.type) {
      case "function_call_expression": {
        const fn = f(n, "function");
        return fn && (fn.type === "name" || fn.type === "qualified_name") ? { name: lastSeg(fn.text), obj: "" } : null;
      }
      case "member_call_expression": case "nullsafe_member_call_expression": {
        const name = nameOf(n);
        return name ? { name, obj: objOf(f(n, "object"), self) } : null;
      }
      case "scoped_call_expression": {
        const name = nameOf(n), scope = f(n, "scope");
        if (!name || !scope) return null;
        return { name, obj: scope.type === "relative_scope" ? "this" : lastSeg(scope.text) };
      }
    }
    return null;
  },
  imports: (n, acc) => {
    if (n.type !== "namespace_use_declaration") return;
    const add = (spec: string, alias?: string) => {
      spec = spec.replace(/^\\/, "");
      acc.imports.push(spec);
      acc.bindings.push([alias ?? lastSeg(spec), spec, lastSeg(spec)]);
    };
    const aliasOf = (c: N) => c.namedChildren.find((x) => x.type === "namespace_aliasing_clause")?.namedChild(0)?.text;
    const group = n.namedChildren.find((c) => c.type === "namespace_use_group");
    if (group) {
      const prefix = n.namedChildren.find((c) => c.type === "namespace_name")?.text.replace(/\\$/, "") ?? "";
      for (const c of group.namedChildren) {
        const nm = c.namedChildren.find((x) => x.type === "namespace_name" || x.type === "name" || x.type === "qualified_name");
        if (nm) add(`${prefix}\\${nm.text}`, aliasOf(c));
      }
      return;
    }
    for (const c of n.namedChildren.filter((x) => x.type === "namespace_use_clause")) {
      const q = c.namedChildren.find((x) => x.type === "qualified_name" || x.type === "name");
      if (q) add(q.text, aliasOf(c));
    }
  },
};

// ───────────── C# ─────────────

const csharp: Hooks = {
  implicitSelf: true,
  type: ofTypes({ class_declaration: "class", interface_declaration: "interface", struct_declaration: "struct", record_declaration: "class", record_struct_declaration: "struct", enum_declaration: "enum" }),
  func: (n) => (n.type === "method_declaration" || n.type === "constructor_declaration" || n.type === "local_function_statement") && nameOf(n) ? { name: nameOf(n)! } : null,
  call: (n, self) => {
    if (n.type !== "invocation_expression") return null;
    const fn = f(n, "function");
    if (!fn) return null;
    if (fn.type === "identifier") return { name: fn.text, obj: "" };
    if (fn.type === "generic_name") return { name: fn.namedChild(0)?.text ?? fn.text, obj: "" };
    const m = member(fn);
    return m ? { name: m.name.replace(/<.*$/, ""), obj: objOf(m.base, self) } : null;
  },
  imports: (n, acc) => {
    if (n.type !== "using_directive") return;
    const id = n.namedChildren.filter((c) => c.type === "identifier" || c.type === "qualified_name").pop();
    if (id && !n.namedChildren.some((c) => c.type === "name_equals")) acc.imports.push(id.text);
  },
};

// ───────────── Rust ─────────────

function rustTypeName(t: N | null): string | null {
  for (let i = 0; t && i < 6; i++) {
    if (t.type === "type_identifier") return t.text;
    t = f(t, "type") ?? f(t, "name") ?? t.namedChild(0);
  }
  return null;
}

interface RustUse { path: string[]; alias?: string; wildcard?: boolean }
function rustUses(a: N, prefix: string[], out: RustUse[]): void {
  switch (a.type) {
    case "scoped_use_list": {
      const p = prefix.concat(f(a, "path")?.text.split("::") ?? []);
      for (const c of f(a, "list")?.namedChildren ?? []) rustUses(c, p, out);
      break;
    }
    case "use_as_clause": out.push({ path: prefix.concat(f(a, "path")?.text.split("::") ?? []), alias: f(a, "alias")?.text }); break;
    case "use_wildcard": out.push({ path: prefix.concat(a.text.replace(/\*$/, "").split("::").filter(Boolean)), wildcard: true }); break;
    case "identifier": case "scoped_identifier": case "self": case "crate": out.push({ path: prefix.concat(a.text.split("::")) }); break;
  }
}

const rust: Hooks = {
  implicitSelf: false,
  type: ofTypes({ struct_item: "struct", enum_item: "enum", trait_item: "trait", union_item: "struct" }),
  scope: (n) => (n.type === "impl_item" ? rustTypeName(f(n, "type")) : null),
  func: (n) => (n.type === "function_item" || n.type === "function_signature_item") && nameOf(n) ? { name: nameOf(n)! } : null,
  call: (n, self) => {
    if (n.type !== "call_expression") return null;
    let fn = f(n, "function");
    if (fn?.type === "generic_function") fn = f(fn, "function");
    if (!fn) return null;
    if (fn.type === "identifier") return { name: fn.text, obj: "" };
    if (fn.type === "scoped_identifier") {
      const name = nameOf(fn), owner = lastSeg(f(fn, "path")?.text ?? "");
      if (!name) return null;
      // Tipo::f() é método associado; modulo::f() é função solta.
      return { name, obj: owner === "Self" ? "this" : /^[A-Z]/.test(owner) ? owner : "" };
    }
    const m = member(fn);
    return m ? { name: m.name, obj: objOf(m.base, self) } : null;
  },
  imports: (n, acc) => {
    if (n.type !== "use_declaration") return;
    const arg = f(n, "argument");
    if (!arg) return;
    const uses: RustUse[] = [];
    rustUses(arg, [], uses);
    for (const u of uses) {
      if (u.path[u.path.length - 1] === "self") u.path.pop();
      if (!u.path.length) continue;
      const spec = u.path.join("::");
      acc.imports.push(spec);
      if (!u.wildcard) acc.bindings.push([u.alias ?? u.path[u.path.length - 1], spec, u.path[u.path.length - 1]]);
    }
  },
};

const HOOKS: Record<ExtraLang, Hooks> = { java, kotlin, go, ruby, php, c_sharp: csharp, rust };

export function extractLang(root: N, lang: ExtraLang, file: string): Extracted {
  const h = HOOKS[lang];
  const syms: Sym[] = [], calls: Call[] = [];
  const acc: Acc = { imports: [], bindings: [] };
  const mk = (name: string, kind: string, n: N): Sym => {
    const id = `${file}::${name}:${n.startPosition.row + 1}`;
    const dup = syms.find((x) => x.id === id); // getter+setter (ou overloads) na mesma linha: id único
    if (dup) { dup.endLine = Math.max(dup.endLine, n.endPosition.row + 1); return dup; }
    const s = { id, name, kind, file, startLine: n.startPosition.row + 1, endLine: n.endPosition.row + 1 };
    syms.push(s);
    return s;
  };
  const walk = (n: N, owner: Sym | null, cls: string | null, self: string | null) => {
    let nextOwner = owner, nextCls = cls, nextSelf = self;
    const t = h.type?.(n);
    if (t) { nextOwner = mk(t.name, t.kind, n); nextCls = t.name; }
    else {
      const sc = h.scope?.(n);
      if (sc) nextCls = sc;
      const fn = h.func?.(n);
      if (fn) {
        const c = fn.cls ?? cls;
        nextOwner = mk(c ? `${c}.${fn.name}` : fn.name, c ? "method" : "function", n);
        if (fn.cls) nextCls = fn.cls;
        if (fn.self !== undefined) nextSelf = fn.self;
      }
    }
    const c = h.call?.(n, nextSelf);
    if (c && nextOwner) calls.push({ callerId: nextOwner.id, callee: c.name, obj: !c.obj && h.implicitSelf && nextCls ? "@" : c.obj, file });
    h.imports?.(n, acc);
    for (const ch of n.namedChildren) walk(ch, nextOwner, nextCls, nextSelf);
  };
  walk(root, null, null, null);
  return { syms, calls, imports: acc.imports, bindings: acc.bindings };
}

// ───────────── Resolução de imports ─────────────

type Family = "jvm" | "go" | "ruby" | "php" | "cs" | "rust";
const FAMILY: Record<string, Family> = { ".java": "jvm", ".kt": "jvm", ".go": "go", ".rb": "ruby", ".php": "php", ".cs": "cs", ".rs": "rust" };
const MAX_TARGETS = 40;

interface Probe { trail: number; lead: number; minLen?: number }

/**
 * Nessas linguagens o import nomeia um pacote/namespace/módulo, não um caminho. O índice casa o especificador com o
 * final do caminho dos arquivos do projeto (com.acme.Repo ↔ src/main/java/com/acme/Repo.java), sem depender de
 * convenção de build. Pacote externo (java.util, serde, github.com/gin-gonic/gin) não casa com nada e volta [].
 */
export class ProjectIndex {
  private files = new Map<string, Set<string>>();
  private dirs = new Map<string, Set<string>>();
  private dirsFull = new Map<string, Set<string>>();
  private goModule: string | null = null;

  constructor(private root: string, private known: Set<string>) {
    for (const file of known) {
      const ext = path.posix.extname(file);
      if (!FAMILY[ext]) continue;
      let base = file.slice(0, -ext.length).toLowerCase();
      if (ext === ".rs" && base.endsWith("/mod")) base = base.slice(0, -4);
      this.addSuffixes(this.files, base, file);
      const dir = path.posix.dirname(file).toLowerCase();
      if (dir !== ".") this.addSuffixes(this.dirs, dir, file);
      (this.dirsFull.get(dir) ?? this.dirsFull.set(dir, new Set()).get(dir)!).add(file);
    }
    try { this.goModule = fs.readFileSync(path.join(root, "go.mod"), "utf8").match(/^module\s+(\S+)/m)?.[1] ?? null; } catch { /* sem go.mod */ }
  }

  private addSuffixes(map: Map<string, Set<string>>, p: string, file: string) {
    const segs = p.split("/");
    for (let i = 0; i < segs.length; i++) {
      const k = segs.slice(i).join("/");
      (map.get(k) ?? map.set(k, new Set()).get(k)!).add(file);
    }
  }

  /** Tenta o especificador inteiro e depois sem os últimos (membro/classe aninhada) e os primeiros (prefixo raiz) segmentos. */
  private find(map: Map<string, Set<string>>, parts: string[], fam: Family, p: Probe): string[] {
    const minLen = p.minLen ?? (parts.length >= 2 ? 2 : 1);
    const keys = parts.map((x) => x.toLowerCase());
    for (let t = 0; t <= p.trail; t++) {
      for (let l = 0; l <= p.lead && keys.length - t - l >= minLen; l++) {
        const hit = [...(map.get(keys.slice(l, keys.length - t).join("/")) ?? [])].filter((x) => FAMILY[path.posix.extname(x)] === fam && !x.endsWith("_test.go"));
        if (hit.length) return hit;
      }
    }
    return [];
  }

  /** null = o arquivo de origem não é de uma linguagem tratada aqui (quem resolve é o resolveImport de TS/Python). */
  resolve(from: string, spec: string): string[] | null {
    const fam = FAMILY[path.posix.extname(from)];
    if (!fam) return null;
    let hits: string[] = [];
    switch (fam) {
      case "jvm": {
        const parts = spec.split(".");
        hits = this.find(this.files, parts, fam, { trail: 2, lead: 0 });
        if (!hits.length) hits = this.find(this.dirs, parts, fam, { trail: 1, lead: 0 });
        break;
      }
      case "php": hits = this.find(this.files, spec.replace(/^\\/, "").split("\\"), fam, { trail: 0, lead: 3 }); break;
      case "cs": {
        const parts = spec.split(".");
        hits = this.find(this.dirs, parts, fam, { trail: 0, lead: 2 });
        if (!hits.length) hits = this.find(this.files, parts, fam, { trail: 1, lead: 2 });
        break;
      }
      case "rust": {
        const parts = spec.split("::");
        while (["crate", "self", "super"].includes(parts[0])) parts.shift();
        if (!parts.length || ["std", "core", "alloc"].includes(parts[0])) break;
        hits = this.find(this.files, parts, fam, { trail: 2, lead: 0, minLen: 1 });
        break;
      }
      case "ruby": {
        if (spec.startsWith(".")) {
          const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec)).replace(/\.rb$/, "") + ".rb";
          hits = this.known.has(base) ? [base] : [];
        } else hits = this.find(this.files, spec.replace(/\.rb$/, "").split("/"), fam, { trail: 0, lead: 0 });
        break;
      }
      case "go": {
        const m = this.goModule;
        if (m && (spec === m || spec.startsWith(m + "/"))) {
          const rel = (spec === m ? "." : spec.slice(m.length + 1)).toLowerCase();
          hits = [...(this.dirsFull.get(rel) ?? [])].filter((x) => !x.endsWith("_test.go") && x.endsWith(".go"));
          if (!hits.length) hits = this.find(this.dirs, rel.split("/"), fam, { trail: 0, lead: 0, minLen: 1 });
        } else if (!m) hits = this.find(this.dirs, spec.split("/"), fam, { trail: 0, lead: 4 });
        break;
      }
    }
    return hits.slice(0, MAX_TARGETS);
  }
}

// Para suportar outra linguagem (Scala, Swift, Elixir…): 1) acrescente a extensão em EXTRA_EXT e ExtraLang (a gramática
// precisa existir em tree-sitter-wasms/out); 2) escreva os hooks (use scripts de dump da AST para achar os tipos de nó);
// 3) registre-os em HOOKS e a família de resolução em FAMILY/ProjectIndex.resolve.
