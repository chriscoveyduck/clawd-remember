import { afterEach, beforeEach, describe, expect, it } from "@jest/globals"

import { access, mkdtemp, readdir, rm } from "node:fs/promises"
import { constants } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { pathToFileURL } from "node:url"

import { SqliteStorageProvider } from "../src/storage/sqlite.js"
import { createFactPayload } from "../src/utils.js"

const maybeDescribe = await canRunSqlite() ? describe : describe.skip

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

async function canRunSqlite(): Promise<boolean> {
  return await canImportPackage("better-sqlite3") && await canImportPackage("sqlite-vec")
}

async function canImportPackage(packageName: string): Promise<boolean> {
  const directImports = [
    async () => {
      await import(packageName)
    },
  ]

  for (const load of directImports) {
    try {
      await load()
      return true
    } catch {
      // Fall through to global module paths.
    }
  }

  for (const root of await getGlobalModuleRoots()) {
    for (const entry of [
      join(root, packageName, "lib", "index.js"),
      join(root, packageName, "index.js"),
    ]) {
      try {
        await access(entry, constants.R_OK)
        await import(pathToFileURL(entry).href)
        return true
      } catch {
        // Try the next candidate path.
      }
    }
  }

  return false
}

async function getGlobalModuleRoots(): Promise<string[]> {
  const roots = new Set<string>()
  const nodePath = process.env.NODE_PATH?.split(":").filter(Boolean) ?? []
  for (const candidate of nodePath) {
    roots.add(candidate)
  }

  roots.add(join(process.execPath, "..", "..", "lib", "node_modules"))

  try {
    const versionsDir = join(process.env.HOME ?? "", ".nvm", "versions", "node")
    const versions = await readdir(versionsDir)
    for (const version of versions) {
      roots.add(join(versionsDir, version, "lib", "node_modules"))
    }
  } catch {
    // No nvm-managed global modules available.
  }

  return Array.from(roots)
}
