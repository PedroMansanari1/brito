import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GraphStore } from "../src/graph/store.js";
import { INDEXED_EXTENSIONS, indexProject } from "../src/graph/indexer.js";

/** Projetos de backend pequenos e realistas: cada linguagem com a estrutura de pastas que a comunidade usa. */
async function indexed(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "brito-langs-"));
  for (const [rel, src] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), src);
  }
  const prev = process.env.BRITO_INDEX_IGNORED;
  process.env.BRITO_INDEX_IGNORED = "1"; // fora de repositório git: indexa tudo
  const store = await GraphStore.open(root);
  await indexProject(root, store);
  const syms = async () => (await store.run("MATCH (s:Symbol) RETURN s.kind AS k, s.name AS n ORDER BY n")).map((r) => `${r.k} ${r.n}`);
  const calls = async () => (await store.run("MATCH (a:Symbol)-[:CALLS]->(b:Symbol) RETURN a.name AS src, b.name AS dst, b.file AS file")).map((r) => `${r.src} -> ${r.dst} (${r.file})`).sort();
  const imports = async () => (await store.run("MATCH (a:File)-[:IMPORTS]->(b:File) RETURN a.path AS src, b.path AS dst")).map((r) => `${r.src} -> ${r.dst}`).sort();
  return {
    syms, calls, imports, store,
    done: async () => {
      await store.close(); fs.rmSync(root, { recursive: true, force: true });
      if (prev === undefined) delete process.env.BRITO_INDEX_IGNORED; else process.env.BRITO_INDEX_IGNORED = prev;
    },
  };
}

test("INDEXED_EXTENSIONS cobre as linguagens de backend comuns", () => {
  for (const e of [".java", ".kt", ".go", ".rb", ".php", ".cs", ".rs"]) assert.ok(INDEXED_EXTENSIONS.includes(e), e);
});

test("Java (Spring): símbolos, import por pacote, this implícito, receptor tipado e import estático", { timeout: 60_000 }, async () => {
  const p = await indexed({
    "src/main/java/com/acme/core/UserRepository.java": `package com.acme.core;
public interface UserRepository {
  User findById(long id);
  void save(User u);
}`,
    "src/main/java/com/acme/util/Strings.java": `package com.acme.util;
public final class Strings { public static String trim(String s) { return s.trim(); } }`,
    "src/main/java/com/acme/users/UserService.java": `package com.acme.users;
import com.acme.core.UserRepository;
import static com.acme.util.Strings.trim;
import java.util.List;
import java.util.*;
@Service
public class UserService extends Base {
  private final UserRepository userRepository;
  public UserService(UserRepository userRepository) { this.userRepository = userRepository; }
  public User find(long id) { audit(); List.of(1); return this.userRepository.findById(id); }
  public void rename(User u, String n) { u.setName(trim(n)); userRepository.save(u); }
  private void audit() {}
  interface Listener {}
}
enum Role { ADMIN }
record Pair(int a, int b) {}`,
  });
  try {
    const syms = await p.syms();
    for (const s of ["class UserService", "method UserService.find", "method UserService.audit", "interface UserRepository", "interface Listener", "enum Role", "class Pair", "method UserRepository.findById", "class Strings", "method Strings.trim"]) assert.ok(syms.includes(s), `falta ${s}\n${syms.join("\n")}`);
    const calls = await p.calls();
    assert.ok(calls.some((c) => c.startsWith("UserService.find -> UserService.audit")), "chamada solta resolve para o método da própria classe");
    assert.ok(calls.some((c) => c.includes("UserService.find -> UserRepository.findById (src/main/java/com/acme/core/UserRepository.java)")), "this.userRepository.findById via tipo pelo nome\n" + calls.join("\n"));
    assert.ok(calls.some((c) => c.includes("UserService.rename -> UserRepository.save")), "userRepository.save");
    assert.ok(calls.some((c) => c.includes("UserService.rename -> Strings.trim (src/main/java/com/acme/util/Strings.java)")), "import estático");
    assert.ok(!calls.some((c) => c.includes("List.of") || c.includes(" -> of")), "pacote externo não gera aresta");
    const imports = await p.imports();
    assert.ok(imports.includes("src/main/java/com/acme/users/UserService.java -> src/main/java/com/acme/core/UserRepository.java"), imports.join("\n"));
    assert.ok(!imports.some((i) => i.includes("java.util")), "java.util é externo");
  } finally { await p.done(); }
});

test("Kotlin: classes, funções de topo, import de função e alias", { timeout: 60_000 }, async () => {
  const p = await indexed({
    "src/main/kotlin/com/acme/util/Text.kt": `package com.acme.util
fun slug(s: String) = s.lowercase()
class Clock { fun now() = 1 }`,
    "src/main/kotlin/com/acme/users/UserService.kt": `package com.acme.users
import com.acme.util.slug
import com.acme.util.Clock as Relogio
class UserService(private val clock: Relogio) {
  fun create(name: String): String { validate(name); clock.now(); return slug(name) }
  private fun validate(n: String) {}
}
object Registry { fun all() = 1 }
interface Notifier
fun boot() = UserService(Relogio()).create("x")`,
  });
  try {
    const syms = await p.syms();
    for (const s of ["class UserService", "method UserService.create", "class Registry", "interface Notifier", "function boot", "function slug", "method Clock.now"]) assert.ok(syms.includes(s), `falta ${s}\n${syms.join("\n")}`);
    const calls = await p.calls();
    assert.ok(calls.some((c) => c.startsWith("UserService.create -> UserService.validate")), calls.join("\n"));
    assert.ok(calls.some((c) => c.includes("UserService.create -> slug (src/main/kotlin/com/acme/util/Text.kt)")), "import de função de topo\n" + calls.join("\n"));
    assert.ok(calls.some((c) => c.includes("UserService.create -> Clock.now")), "clock.now() via nome do campo\n" + calls.join("\n"));
  } finally { await p.done(); }
});

test("Go: métodos por receiver, import pelo módulo do go.mod, pacote externo ignorado", { timeout: 60_000 }, async () => {
  const p = await indexed({
    "go.mod": "module github.com/acme/app\n\ngo 1.22\n",
    "internal/repo/repo.go": `package repo
type Store struct{}
func Load(id int) int { return id }
func (s *Store) Close() {}`,
    "internal/users/service.go": `package users
import (
  "fmt"
  "github.com/gin-gonic/gin"
  r "github.com/acme/app/internal/repo"
)
type Service struct{ st *r.Store }
type Finder interface{ Find() }
func New() *Service { return &Service{} }
func (s *Service) Find(id int) int {
  s.audit()
  fmt.Println("x")
  gin.Default()
  return r.Load(id)
}
func (s Service) audit() {}`,
    "cmd/main.go": `package main
import "github.com/acme/app/internal/users"
func main() { users.New() }`,
  });
  try {
    const syms = await p.syms();
    for (const s of ["struct Service", "interface Finder", "method Service.Find", "method Service.audit", "function New", "function Load", "method Store.Close", "function main"]) assert.ok(syms.includes(s), `falta ${s}\n${syms.join("\n")}`);
    const calls = await p.calls();
    assert.ok(calls.some((c) => c.startsWith("Service.Find -> Service.audit")), "s.audit() pelo receiver\n" + calls.join("\n"));
    assert.ok(calls.some((c) => c.includes("Service.Find -> Load (internal/repo/repo.go)")), "r.Load via import com alias\n" + calls.join("\n"));
    assert.ok(calls.some((c) => c.includes("main -> New (internal/users/service.go)")), "users.New\n" + calls.join("\n"));
    assert.ok(!calls.some((c) => c.includes("Println") || c.includes("Default")), "fmt e gin são externos");
    const imports = await p.imports();
    assert.deepEqual(imports, ["cmd/main.go -> internal/users/service.go", "internal/users/service.go -> internal/repo/repo.go"]);
  } finally { await p.done(); }
});

test("Ruby (Rails): módulos, classes, métodos de classe, self e require_relative", { timeout: 60_000 }, async () => {
  const p = await indexed({
    "app/models/user.rb": `class User < ApplicationRecord
  def self.find_active; where(active: true); end
  def full_name; "x"; end
end`,
    "lib/helper.rb": `module Helper
  def self.fmt(x); x; end
end`,
    "app/controllers/api/users_controller.rb": `require 'json'
require_relative '../../../lib/helper'
module Api
  class UsersController < ApplicationController
    def show
      user = User.find_active
      render json: serialize(user)
      self.audit
      Helper.fmt(1)
    end
    def serialize(u) = u.full_name
    def audit; end
  end
end`,
  });
  try {
    const syms = await p.syms();
    for (const s of ["class User", "module Helper", "module Api", "class UsersController", "method User.find_active", "method UsersController.show"]) assert.ok(syms.includes(s), `falta ${s}\n${syms.join("\n")}`);
    const calls = await p.calls();
    assert.ok(calls.some((c) => c.includes("UsersController.show -> User.find_active (app/models/user.rb)")), "User.find_active via nome do tipo\n" + calls.join("\n"));
    assert.ok(calls.some((c) => c.startsWith("UsersController.show -> UsersController.serialize")), "chamada sem receptor\n" + calls.join("\n"));
    assert.ok(calls.some((c) => c.startsWith("UsersController.show -> UsersController.audit")), "self.audit");
    assert.ok(calls.some((c) => c.includes("UsersController.show -> Helper.fmt (lib/helper.rb)")), "Helper.fmt");
    assert.ok(!calls.some((c) => c.includes("-> render")), "render não existe no projeto");
    assert.deepEqual(await p.imports(), ["app/controllers/api/users_controller.rb -> lib/helper.rb"]);
  } finally { await p.done(); }
});

test("PHP (Laravel): namespace PSR-4, use com alias e em grupo, $this, estático e função", { timeout: 60_000 }, async () => {
  const p = await indexed({
    "app/Models/User.php": `<?php
namespace App\\Models;
class User { public static function make() { return new User(); } public function toArray() { return []; } }`,
    "app/Support/Str.php": `<?php
namespace App\\Support;
class Str { public static function slug($s) { return $s; } }
function helper() {}`,
    "app/Http/Controllers/UserController.php": `<?php
namespace App\\Http\\Controllers;
use App\\Models\\User;
use App\\Support\\{Str, Arr as A};
use Illuminate\\Http\\Request;
class UserController extends Controller {
  public function show(Request $r, $id) {
    $u = User::make();
    $this->audit();
    Str::slug('x');
    return $u->toArray();
  }
  private function audit() {}
}
interface Svc {}
trait Loggable {}`,
  });
  try {
    const syms = await p.syms();
    for (const s of ["class User", "class UserController", "interface Svc", "trait Loggable", "method UserController.show", "method User.make"]) assert.ok(syms.includes(s), `falta ${s}\n${syms.join("\n")}`);
    const calls = await p.calls();
    assert.ok(calls.some((c) => c.includes("UserController.show -> User.make (app/Models/User.php)")), "User::make()\n" + calls.join("\n"));
    assert.ok(calls.some((c) => c.startsWith("UserController.show -> UserController.audit")), "$this->audit()");
    assert.ok(calls.some((c) => c.includes("UserController.show -> Str.slug (app/Support/Str.php)")), "use em grupo\n" + calls.join("\n"));
    assert.ok(calls.some((c) => c.includes("UserController.show -> User.toArray")), "$u->toArray() pelo nome da variável\n" + calls.join("\n"));
    const imports = await p.imports();
    assert.ok(imports.includes("app/Http/Controllers/UserController.php -> app/Models/User.php") && imports.includes("app/Http/Controllers/UserController.php -> app/Support/Str.php"), imports.join("\n"));
  } finally { await p.done(); }
});

test("C#: namespaces, métodos, this implícito, campo tipado e estático", { timeout: 60_000 }, async () => {
  const p = await indexed({
    "src/Acme.Core/Repo.cs": `namespace Acme.Core {
  public class Repo { public User Load(long id) { return null; } public static Repo Create() { return new Repo(); } }
}`,
    "src/Users/UserService.cs": `using System;
using Acme.Core;
namespace Acme.Users {
  public class UserService : IService {
    private readonly Repo _repo;
    public UserService(Repo r) { _repo = r; }
    public User Find(long id) { Helper(); Repo.Create(); this.Audit(); return _repo.Load(id); }
    private void Helper() {}
    private void Audit() {}
  }
  public interface IService {}
  public struct Point {}
  public record Dto(int X);
  public enum Role { A }
}`,
  });
  try {
    const syms = await p.syms();
    for (const s of ["class UserService", "interface IService", "struct Point", "class Dto", "enum Role", "method UserService.Find", "method Repo.Load"]) assert.ok(syms.includes(s), `falta ${s}\n${syms.join("\n")}`);
    const calls = await p.calls();
    assert.ok(calls.some((c) => c.startsWith("UserService.Find -> UserService.Helper")), "chamada solta\n" + calls.join("\n"));
    assert.ok(calls.some((c) => c.startsWith("UserService.Find -> UserService.Audit")), "this.Audit()");
    assert.ok(calls.some((c) => c.includes("UserService.Find -> Repo.Create (src/Acme.Core/Repo.cs)")), "Repo.Create()\n" + calls.join("\n"));
    assert.ok(calls.some((c) => c.includes("UserService.Find -> Repo.Load")), "_repo.Load pelo nome do campo\n" + calls.join("\n"));
  } finally { await p.done(); }
});

test("Rust: impl vira métodos do tipo, use crate::, Self e módulo::função", { timeout: 60_000 }, async () => {
  const p = await indexed({
    "src/repo.rs": `pub struct Repo;
impl Repo { pub fn create() -> Repo { Repo } pub fn load(&self, id: u64) -> u64 { id } }
pub fn connect() {}`,
    "src/service.rs": `use crate::repo::Repo;
use crate::repo;
use std::collections::{HashMap, HashSet};
pub trait Named { fn name(&self) -> String; }
pub enum Mode { A }
pub struct Service { r: Repo }
impl<T> Service {
  pub fn find(&self, id: u64) -> u64 { self.helper(); Self::build(); repo::connect(); let m: HashMap<u8,u8> = HashMap::new(); self.r.load(id) }
  fn helper(&self) {}
  fn build() {}
}
fn free() { Repo::create(); println!("x"); }`,
  });
  try {
    const syms = await p.syms();
    for (const s of ["struct Service", "trait Named", "enum Mode", "method Service.find", "method Service.helper", "method Repo.load", "function connect", "function free"]) assert.ok(syms.includes(s), `falta ${s}\n${syms.join("\n")}`);
    const calls = await p.calls();
    assert.ok(calls.some((c) => c.startsWith("Service.find -> Service.helper")), "self.helper()\n" + calls.join("\n"));
    assert.ok(calls.some((c) => c.startsWith("Service.find -> Service.build")), "Self::build()");
    assert.ok(calls.some((c) => c.includes("Service.find -> connect (src/repo.rs)")), "repo::connect()\n" + calls.join("\n"));
    assert.ok(calls.some((c) => c.includes("free -> Repo.create (src/repo.rs)")), "Repo::create() via use crate::\n" + calls.join("\n"));
    assert.ok(calls.some((c) => c.includes("Service.find -> Repo.load")), "self.r.load pelo campo\n" + calls.join("\n"));
    assert.ok(!calls.some((c) => c.includes("HashMap")), "std é externo");
    assert.ok((await p.imports()).includes("src/service.rs -> src/repo.rs"));
  } finally { await p.done(); }
});

test("pastas de build/vendor das linguagens de backend não entram no grafo", { timeout: 60_000 }, async () => {
  const p = await indexed({
    "src/Main.java": "class Main { void a() {} }",
    "target/generated/Gen.java": "class Gen {}",
    "vendor/lib/lib.go": "package lib\nfunc X() {}",
    "obj/Debug/Info.g.cs": "class Info {}",
    "api/schema.pb.go": "package api\nfunc Y() {}",
  });
  try {
    const files = (await p.store.run("MATCH (f:File) RETURN f.path AS p ORDER BY p")).map((r) => r.p);
    assert.deepEqual(files, ["src/Main.java"]);
  } finally { await p.done(); }
});
