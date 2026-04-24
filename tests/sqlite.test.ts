import { afterEach, beforeEach, describe, expect, it } from "@jest/globals"

import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { SqliteStorageProvider } from "../src/storage/sqlite.js"
import { createFactPayload } from "../src/utils.js"

const maybeDescribe = canRunSqlite() ? describe : describe.skip

maybeDescribe("SqliteStorageProvider", () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "clawd-remember-"))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("stores, searches, and deletes memories end to end", async () => {
    const provider = new SqliteStorageProvider({
      path: join(dir, "memory.db"),
    })
    await provider.init()

    const payload1 = createFactPayload("User prefers tea", "user-1")
    const payload2 = createFactPayload("User deploys to Cloudflare Workers", "user-1")
    await provider.insert(payload1.id, [1, 0, 0], payload1)
    await provider.insert(payload2.id, [0, 1, 0], payload2)

    const results = await provider.search([1, 0, 0], 2, { user_id: "user-1" })
    expect(results[0]?.fact.data).toBe("User prefers tea")

    const list = await provider.list({ user_id: "user-1" })
    expect(list).toHaveLength(2)

    await provider.delete(payload1.id)
    expect(await provider.get(payload1.id)).toBeNull()
  })
})

function canRunSqlite(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require("better-sqlite3")
    return true
  } catch {
    return false
  }
}
