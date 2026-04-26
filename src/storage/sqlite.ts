import type { Database as BetterSqlite3Database, Statement } from "better-sqlite3"

import type { FactPayload, Filters, SearchResult, SqliteStorageConfig, StorageProvider } from "../types.js"
import {
  DEFAULT_SQLITE_PATH,
  bufferToVector,
  cosineSimilarity,
  ensureParentDir,
  expandHomePath,
  toJson,
  vectorToBuffer,
} from "../utils.js"

interface SqliteModule {
  default: new (path: string) => BetterSqlite3Database
}

interface SqliteVecModule {
  load(db: BetterSqlite3Database): void
}

type MemoryRow = {
  id: string
  vector: Buffer
  payload: string
}

export class SqliteStorageProvider implements StorageProvider {
  private db?: BetterSqlite3Database

  public constructor(private readonly config: SqliteStorageConfig = {}) {}

  public async init(): Promise<void> {
    if (this.db) {
      return
    }

    const dbPath = expandHomePath(this.config.path ?? DEFAULT_SQLITE_PATH)
    await ensureParentDir(dbPath)

    const Database = await loadBetterSqlite3()
    const sqliteVec = await loadSqliteVec()
    const db = new Database(dbPath)

    try {
      sqliteVec.load(db)
    } catch (error) {
      db.close()
      throw new Error(`Failed to load sqlite-vec extension: ${getErrorMessage(error)}`)
    }

    db.pragma("journal_mode = WAL")
    db.pragma("foreign_keys = ON")
    db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        vector BLOB NOT NULL,
        payload TEXT NOT NULL
      );
    `)

    try {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_memories USING vec0(
          id TEXT PRIMARY KEY,
          embedding FLOAT
        );
      `)
    } catch (vecErr) {
      // Flexible-dimension form not supported by this sqlite-vec version; fall back to fixed dimensions
      const dims = this.config.dimensions ?? 1536
      // Log the fallback so silent failures are visible during debugging
      const warnMsg = `[clawd-remember] sqlite-vec: flexible embedding column not supported, retrying with fixed dimensions ${dims}: ${vecErr instanceof Error ? vecErr.message : String(vecErr)}`
      if (typeof console !== 'undefined') {
        // eslint-disable-next-line no-console
        console.warn(warnMsg)
      }
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_memories USING vec0(
          id TEXT PRIMARY KEY,
          embedding FLOAT[${dims}]
        );
      `)
    }

    this.db = db
  }

  public async insert(id: string, vector: number[], payload: FactPayload): Promise<void> {
    const db = this.getDb()
    const existingByHash = this.findByHash(payload.hash, payload.user_id, payload.session_id)
    const targetId = existingByHash?.id ?? id
    const existingPayload = existingByHash?.payload
    const nextPayload: FactPayload = {
      ...(existingPayload ?? payload),
      ...payload,
      id: targetId,
      created_at: existingPayload?.created_at ?? payload.created_at,
      updated_at: payload.updated_at,
    }

    const upsertMemory = db.prepare(`
      INSERT INTO memories (id, vector, payload)
      VALUES (@id, @vector, @payload)
      ON CONFLICT(id) DO UPDATE SET
        vector = excluded.vector,
        payload = excluded.payload
    `)

    const deleteVector = db.prepare(`DELETE FROM vec_memories WHERE id = ?`)
    const insertVector = db.prepare(`INSERT INTO vec_memories (id, embedding) VALUES (?, ?)`)
    const transaction = db.transaction(() => {
      upsertMemory.run({
        id: targetId,
        vector: vectorToBuffer(vector),
        payload: toJson(nextPayload),
      })
      deleteVector.run(targetId)
      insertVector.run(targetId, toJson(vector))

      if (existingByHash && existingByHash.id !== id) {
        db.prepare(`DELETE FROM memories WHERE id = ?`).run(id)
        deleteVector.run(id)
      }
    })

    transaction()
  }

  public async search(vector: number[], topK: number, filters: Filters = {}): Promise<SearchResult[]> {
    const db = this.getDb()
    const normalizedTopK = Math.max(1, topK)
    const clauses = ["vm.embedding MATCH ?", `vm.k = ${normalizedTopK}`]
    const params: unknown[] = [toJson(vector)]

    if (filters.user_id) {
      clauses.push(`json_extract(m.payload, '$.user_id') = ?`)
      params.push(filters.user_id)
    }

    if (filters.session_id) {
      clauses.push(`json_extract(m.payload, '$.session_id') = ?`)
      params.push(filters.session_id)
    }

    if (filters.categories?.length) {
      for (const category of filters.categories) {
        clauses.push(`
          EXISTS (
            SELECT 1
            FROM json_each(json_extract(m.payload, '$.categories'))
            WHERE value = ?
          )
        `)
        params.push(category)
      }
    }

    const sql = `
      SELECT m.id, m.vector, m.payload, vm.distance
      FROM vec_memories vm
      JOIN memories m ON m.id = vm.id
      WHERE ${clauses.join(" AND ")}
      ORDER BY vm.distance ASC
      LIMIT ${normalizedTopK}
    `

    const rows = db.prepare(sql).all(...params) as Array<MemoryRow & { distance: number }>
    return rows.map((row) => {
      const fact = JSON.parse(row.payload) as FactPayload
      const storedVector = bufferToVector(row.vector)
      const score = cosineSimilarity(vector, storedVector)
      return { fact, score }
    })
  }

  public async get(id: string): Promise<FactPayload | null> {
    const row = this.getRowById(id)
    return row?.payload ?? null
  }

  public async delete(id: string): Promise<void> {
    const db = this.getDb()
    const transaction = db.transaction(() => {
      db.prepare(`DELETE FROM vec_memories WHERE id = ?`).run(id)
      db.prepare(`DELETE FROM memories WHERE id = ?`).run(id)
    })
    transaction()
  }

  public async list(filters: Filters = {}, topK?: number): Promise<FactPayload[]> {
    const db = this.getDb()
    const clauses: string[] = []
    const params: unknown[] = []

    if (filters.user_id) {
      clauses.push(`json_extract(payload, '$.user_id') = ?`)
      params.push(filters.user_id)
    }

    if (filters.session_id) {
      clauses.push(`json_extract(payload, '$.session_id') = ?`)
      params.push(filters.session_id)
    }

    if (filters.categories?.length) {
      for (const category of filters.categories) {
        clauses.push(`
          EXISTS (
            SELECT 1
            FROM json_each(json_extract(payload, '$.categories'))
            WHERE value = ?
          )
        `)
        params.push(category)
      }
    }

    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""
    const limit = topK ? `LIMIT ${Math.max(1, topK)}` : ""
    const rows = db.prepare(`
      SELECT id, payload
      FROM memories
      ${where}
      ORDER BY json_extract(payload, '$.updated_at') DESC
      ${limit}
    `).all(...params) as Array<{ id: string; payload: string }>

    return rows.map((row) => JSON.parse(row.payload) as FactPayload)
  }

  private getDb(): BetterSqlite3Database {
    if (!this.db) {
      throw new Error("SQLite storage has not been initialized")
    }

    return this.db
  }

  private getRowById(id: string): { id: string; payload: FactPayload } | null {
    const db = this.getDb()
    const row = db.prepare(`SELECT id, payload FROM memories WHERE id = ?`).get(id) as
      | { id: string; payload: string }
      | undefined

    if (!row) {
      return null
    }

    return { id: row.id, payload: JSON.parse(row.payload) as FactPayload }
  }

  private findByHash(hash: string, userId: string, sessionId?: string): { id: string; payload: FactPayload } | null {
    const db = this.getDb()
    const sessionClause = sessionId === undefined
      ? `json_extract(payload, '$.session_id') IS NULL`
      : `json_extract(payload, '$.session_id') = ?`
    const params: unknown[] = [hash, userId]
    if (sessionId !== undefined) {
      params.push(sessionId)
    }

    const sql = `
      SELECT id, payload
      FROM memories
      WHERE json_extract(payload, '$.hash') = ?
        AND json_extract(payload, '$.user_id') = ?
        AND ${sessionClause}
      LIMIT 1
    `
    const row = db.prepare(sql).get(...params) as { id: string; payload: string } | undefined
    if (!row) {
      return null
    }

    return { id: row.id, payload: JSON.parse(row.payload) as FactPayload }
  }
}

async function loadBetterSqlite3(): Promise<SqliteModule["default"]> {
  try {
    const module = await import("better-sqlite3") as SqliteModule
    return module.default
  } catch (error) {
    throw new Error(
      "better-sqlite3 is required for the SQLite storage backend.\n" +
      "Install it with: npm install better-sqlite3 sqlite-vec\n" +
      "If you are using a remote backend (postgres/mariadb), set provider accordingly in your config.",
    )
  }
}

async function loadSqliteVec(): Promise<SqliteVecModule> {
  try {
    return await import("sqlite-vec") as SqliteVecModule
  } catch (error) {
    throw new Error(
      `SQLite storage requires sqlite-vec. Install it with \`npm install sqlite-vec\`. ${getErrorMessage(error)}`,
    )
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
