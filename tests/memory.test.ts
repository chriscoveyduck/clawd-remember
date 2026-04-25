import { describe, expect, it } from "@jest/globals"

import { MemoryManager } from "../src/memory.js"
import { InMemoryStorageProvider, MockEmbedder, MockExtractor } from "./helpers.js"

describe("MemoryManager", () => {
  it("captures extracted facts and supports recall", async () => {
    const manager = new MemoryManager(
      new InMemoryStorageProvider(),
      new MockEmbedder(),
      new MockExtractor([
        "User maintains a blog project",
        "User deploys to Cloudflare Workers",
      ]),
      {
        userId: "user-1",
        topK: 5,
      },
    )

    await manager.init()
    const captured = await manager.capture([{ role: "user", content: "remember this" }])
    expect(captured).toHaveLength(2)

    const results = await manager.recall("blog project", { user_id: "user-1", topK: 2 })
    expect(results).toHaveLength(2)
    expect(results[0]?.fact.user_id).toBe("user-1")
  })

  it("adds and deletes facts manually", async () => {
    const manager = new MemoryManager(
      new InMemoryStorageProvider(),
      new MockEmbedder(),
      new MockExtractor([]),
      { userId: "user-1" },
    )

    await manager.init()
    const fact = await manager.add("User prefers SQLite", "user-1")
    expect(await manager.list({ user_id: "user-1" })).toHaveLength(1)

    await manager.delete(fact.id)
    expect(await manager.list({ user_id: "user-1" })).toHaveLength(0)
  })

  it("deduplicates identical facts for the same user", async () => {
    const manager = new MemoryManager(
      new InMemoryStorageProvider(),
      new MockEmbedder(),
      new MockExtractor([]),
      { userId: "user-1" },
    )

    await manager.init()
    await manager.add("User prefers SQLite", "user-1")
    await manager.add("User prefers SQLite", "user-1")

    const facts = await manager.list({ user_id: "user-1" })
    expect(facts).toHaveLength(1)
    expect(facts[0]?.data).toBe("User prefers SQLite")
  })

  it("stores identical facts separately for different users", async () => {
    const manager = new MemoryManager(
      new InMemoryStorageProvider(),
      new MockEmbedder(),
      new MockExtractor([]),
      { userId: "user-1" },
    )

    await manager.init()
    await manager.add("User prefers SQLite", "user-1")
    await manager.add("User prefers SQLite", "user-2")

    expect(await manager.list({ user_id: "user-1" })).toHaveLength(1)
    expect(await manager.list({ user_id: "user-2" })).toHaveLength(1)
    expect(await manager.list()).toHaveLength(2)
  })
})
