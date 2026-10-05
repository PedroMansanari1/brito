import kuzu from "kuzu";
import fs from "node:fs";
import path from "node:path";

export type Row = Record<string, any>;

/** Lê as linhas e fecha cada QueryResult na hora: o finalizer do GC depois de db.close() derruba o processo (segfault). */
async function drain(r: any, read = true): Promise<Row[]> {
  const all = Array.isArray(r) ? r : [r];
  try { return read ? await all[all.length - 1].getAll() : []; }
  finally { for (const x of all) x.close(); }
}

export class GraphStore {
  private db: kuzu.Database;
  private conn: kuzu.Connection;
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(db: kuzu.Database, conn: kuzu.Connection) {
    this.db = db;
    this.conn = conn;
  }

  static async open(root: string): Promise<GraphStore> {
    const dir = path.join(root, ".brito");
    fs.mkdirSync(dir, { recursive: true });
    const db = new kuzu.Database(path.join(dir, "graph.kuzu"));
    const store = new GraphStore(db, new kuzu.Connection(db));
    await store.migrate();
    return store;
  }

  private async migrate() {
    const ddl = [
      "CREATE NODE TABLE IF NOT EXISTS File(path STRING, lang STRING, hash STRING, calls STRING[], imports STRING[], bindings STRING[], PRIMARY KEY(path))",
      "CREATE NODE TABLE IF NOT EXISTS Symbol(id STRING, name STRING, kind STRING, file STRING, startLine INT64, endLine INT64, PRIMARY KEY(id))",
      "CREATE NODE TABLE IF NOT EXISTS Note(id STRING, kind STRING, text STRING, refs STRING[], ts INT64, PRIMARY KEY(id))",
      "CREATE REL TABLE IF NOT EXISTS DEFINES(FROM File TO Symbol)",
      "CREATE REL TABLE IF NOT EXISTS CALLS(FROM Symbol TO Symbol)",
      "CREATE REL TABLE IF NOT EXISTS IMPORTS(FROM File TO File)",
    ];
    for (const q of ddl) await drain(await this.conn.query(q), false);
    // Bancos criados antes do indexador incremental não têm estas colunas.
    for (const col of ["calls", "imports", "bindings"]) await drain(await this.conn.query(`ALTER TABLE File ADD IF NOT EXISTS ${col} STRING[] DEFAULT []`), false);
  }

  /** Serializa as queries: leituras paralelas de subagentes dividem uma única Connection. */
  run(cypher: string, params: Record<string, any> = {}): Promise<Row[]> {
    const next = this.queue.then(() => this.exec(cypher, params));
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async exec(cypher: string, params: Record<string, any>): Promise<Row[]> {
    if (Object.keys(params).length === 0) {
      return drain(await this.conn.query(cypher));
    }
    const ps = await this.conn.prepare(cypher);
    if (!ps.isSuccess()) throw new Error(ps.getErrorMessage());
    return drain(await this.conn.execute(ps, params));
  }

  /** Apaga só o grafo de código; notas (memória) são preservadas. */
  async clearCode() {
    await this.run("MATCH (s:Symbol) DETACH DELETE s");
    await this.run("MATCH (f:File) DETACH DELETE f");
  }

  async close() {
    await this.conn.close();
    await this.db.close();
  }
}
