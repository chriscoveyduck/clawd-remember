import { describe, expect, it } from "@jest/globals"

import { MemoryManager } from "../src/memory.js"
import type { Embedder, SessionVectorCacheEntry } from "../src/types.js"
import { InMemoryStorageProvider, MockEmbedder, MockExtractor } from "./helpers.js"

class SemanticTestEmbedder implements Embedder {
  public readonly dimensions = 3

  public async embed(text: string): Promise<number[]> {
    const vectors: Record<string, number[]> = {
      "User likes tea": [1, 0, 0],
      "User loves tea": [0.92, Math.sqrt(1 - 0.92 ** 2), 0],
      "User drinks tea sometimes": [0.91, Math.sqrt(1 - 0.91 ** 2), 0],
    }

    return vectors[text] ?? [0, 0, 1]
  }
}

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

  it("deduplicates identical facts across sessions for the same user", async () => {
    const manager = new MemoryManager(
      new InMemoryStorageProvider(),
      new MockEmbedder(),
      new MockExtractor([]),
      { userId: "user-1" },
    )

    await manager.init()
    await manager.add("User prefers SQLite", "user-1", "session-1")
    await manager.add("User prefers SQLite", "user-1", "session-2")

    const facts = await manager.list({ user_id: "user-1" })
    expect(facts).toHaveLength(1)
    expect(facts[0]?.data).toBe("User prefers SQLite")
  })

  it("skips near-duplicates at or above the deduplication threshold during capture", async () => {
    const storage = new InMemoryStorageProvider()
    const manager = new MemoryManager(
      storage,
      new SemanticTestEmbedder(),
      new MockExtractor(["User likes tea", "User loves tea"]),
      {
        userId: "user-1",
        deduplicationThreshold: 0.92,
      },
    )

    await manager.init()
    const captured = await manager.capture([{ role: "user", content: "remember this" }], { sessionId: "session-1" })

    expect(captured).toHaveLength(1)
    expect(await storage.list({ user_id: "user-1" })).toHaveLength(1)
  })

  it("inserts near-duplicates below the deduplication threshold during capture", async () => {
    const storage = new InMemoryStorageProvider()
    const manager = new MemoryManager(
      storage,
      new SemanticTestEmbedder(),
      new MockExtractor(["User likes tea", "User drinks tea sometimes"]),
      {
        userId: "user-1",
        deduplicationThreshold: 0.92,
      },
    )

    await manager.init()
    const captured = await manager.capture([{ role: "user", content: "remember this" }], { sessionId: "session-1" })

    expect(captured).toHaveLength(2)
    expect(await storage.list({ user_id: "user-1" })).toHaveLength(2)
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

  it("prevents re-insertion of a deleted fact within the same session via the session cache", async () => {
    const storage = new InMemoryStorageProvider()
    const sessionVectorCache: SessionVectorCacheEntry[] = []
    const firstCapture = new MemoryManager(
      storage,
      new MockEmbedder(),
      new MockExtractor(["User likes tea"]),
      { userId: "user-1" },
    )
    const secondCapture = new MemoryManager(
      storage,
      new MockEmbedder(),
      new MockExtractor(["User likes tea"]),
      { userId: "user-1" },
    )

    await firstCapture.init()
    await secondCapture.init()

    const created = await firstCapture.capture([{ role: "user", content: "remember this" }], {
      sessionId: "session-1",
      sessionVectorCache,
    })
    expect(created).toHaveLength(1)

    await firstCapture.delete(created[0]!.id)
    const recaptured = await secondCapture.capture([{ role: "user", content: "remember this again" }], {
      sessionId: "session-1",
      sessionVectorCache,
    })

    expect(recaptured).toHaveLength(0)
    expect(await storage.list({ user_id: "user-1" })).toHaveLength(0)
  })

  it("uses the session cache to catch semantic near-duplicates after the original was deleted", async () => {
    const storage = new InMemoryStorageProvider()
    const sessionVectorCache: SessionVectorCacheEntry[] = []
    const firstCapture = new MemoryManager(
      storage,
      new SemanticTestEmbedder(),
      new MockExtractor(["User likes tea"]),
      {
        userId: "user-1",
        deduplicationThreshold: 0.92,
      },
    )
    const secondCapture = new MemoryManager(
      storage,
      new SemanticTestEmbedder(),
      new MockExtractor(["User loves tea"]),
      {
        userId: "user-1",
        deduplicationThreshold: 0.92,
      },
    )

    await firstCapture.init()
    await secondCapture.init()

    const created = await firstCapture.capture([{ role: "user", content: "remember this" }], {
      sessionId: "session-1",
      sessionVectorCache,
    })
    await firstCapture.delete(created[0]!.id)

    const recaptured = await secondCapture.capture([{ role: "user", content: "remember this differently" }], {
      sessionId: "session-1",
      sessionVectorCache,
    })

    expect(recaptured).toHaveLength(0)
    expect(await storage.list({ user_id: "user-1" })).toHaveLength(0)
  })

  it("does not let the session cache block genuinely different facts", async () => {
    const storage = new InMemoryStorageProvider()
    const sessionVectorCache: SessionVectorCacheEntry[] = []
    const firstCapture = new MemoryManager(
      storage,
      new SemanticTestEmbedder(),
      new MockExtractor(["User likes tea"]),
      {
        userId: "user-1",
        deduplicationThreshold: 0.92,
      },
    )
    const secondCapture = new MemoryManager(
      storage,
      new SemanticTestEmbedder(),
      new MockExtractor(["User has a bicycle"]),
      {
        userId: "user-1",
        deduplicationThreshold: 0.92,
      },
    )

    await firstCapture.init()
    await secondCapture.init()

    await firstCapture.capture([{ role: "user", content: "remember this" }], {
      sessionId: "session-1",
      sessionVectorCache,
    })
    const captured = await secondCapture.capture([{ role: "user", content: "remember this too" }], {
      sessionId: "session-1",
      sessionVectorCache,
    })

    expect(captured).toHaveLength(1)
    expect(await storage.list({ user_id: "user-1" })).toHaveLength(2)
  })
})
