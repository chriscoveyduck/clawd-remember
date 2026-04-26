/**
 * Tests for two-level memory partition key derivation.
 *
 * Partition key format: `{devicePrefix}:{agentId}`
 *   Level 1: first 12 chars of deviceId from ~/.openclaw/identity/device.json
 *            (falls back to hostname if file missing)
 *   Level 2: agentId from session key (e.g. "main"), or config.userId override, or "default"
 */

import { describe, expect, it } from "@jest/globals"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createPlugin, loadInstanceId } from "../src/index.js"
import type { PluginConfig } from "../src/types.js"
import { InMemoryStorageProvider, MockEmbedder, MockExtractor } from "./helpers.js"

function buildConfig(overrides: Partial<PluginConfig> = {}): PluginConfig {
  return {
    storage: { provider: "sqlite", config: { path: "/tmp/test-partition.db" } },
    embedder: { provider: "ollama", config: { url: "http://localhost:11434", model: "nomic-embed-text" } },
    llm: { provider: "openai-compatible", config: { baseURL: "http://localhost:4141/v1", model: "gpt-4o-mini", apiKey: "dummy" } },
    autoRecall: true,
    autoCapture: true,
    topK: 5,
    recallTimeout: 1000,
    captureTimeout: 1000,
    ...overrides,
  }
}

describe("partition key derivation", () => {
  it("uses {devicePrefix}:{agentId} when session key is present", async () => {
    const storage = new InMemoryStorageProvider()
    const plugin = createPlugin({
      createStorageProvider: () => storage,
      createEmbedder: () => new MockEmbedder(),
      createExtractor: () => new MockExtractor(["fact from session"]),
      devicePrefix: "testdevice01",
    })

    const addTool = plugin.tools.find((t) => t.name === "memory_add")!
    await addTool.execute(
      { text: "User likes tea" },
      { config: buildConfig(), sessionId: "agent:main:telegram:direct:123" },
    )

    const listTool = plugin.tools.find((t) => t.name === "memory_list")!
    const results = await listTool.execute(
      {},
      { config: buildConfig(), sessionId: "agent:main:telegram:direct:123" },
    ) as Array<{ data: string; user_id: string }>

    expect(results).toHaveLength(1)
    expect(results[0]!.user_id).toBe("testdevice01:main")
  })

  it("falls back to 'default' as agentId when no session key is provided", async () => {
    const storage = new InMemoryStorageProvider()
    const plugin = createPlugin({
      createStorageProvider: () => storage,
      createEmbedder: () => new MockEmbedder(),
      createExtractor: () => new MockExtractor(["fallback fact"]),
      devicePrefix: "testdevice01",
    })

    const addTool = plugin.tools.find((t) => t.name === "memory_add")!
    await addTool.execute(
      { text: "No session key" },
      { config: buildConfig() },
    )

    const listTool = plugin.tools.find((t) => t.name === "memory_list")!
    const results = await listTool.execute(
      {},
      { config: buildConfig() },
    ) as Array<{ data: string; user_id: string }>

    expect(results).toHaveLength(1)
    expect(results[0]!.user_id).toBe("testdevice01:default")
  })

  it("config.userId overrides the parsed agentId (Level 2)", async () => {
    const storage = new InMemoryStorageProvider()
    const plugin = createPlugin({
      createStorageProvider: () => storage,
      createEmbedder: () => new MockEmbedder(),
      createExtractor: () => new MockExtractor(["override fact"]),
      devicePrefix: "testdevice01",
    })

    const addTool = plugin.tools.find((t) => t.name === "memory_add")!
    // Session key says agentId=cron, but config.userId="main" — should use "main"
    await addTool.execute(
      { text: "Cron reading main memory" },
      { config: buildConfig({ userId: "main" }), sessionId: "agent:cron:run:job1" },
    )

    const listTool = plugin.tools.find((t) => t.name === "memory_list")!
    const results = await listTool.execute(
      {},
      { config: buildConfig({ userId: "main" }), sessionId: "agent:cron:run:job1" },
    ) as Array<{ data: string; user_id: string }>

    expect(results).toHaveLength(1)
    expect(results[0]!.user_id).toBe("testdevice01:main")
  })

  it("explicit userId input param overrides partition key entirely", async () => {
    const storage = new InMemoryStorageProvider()
    const plugin = createPlugin({
      createStorageProvider: () => storage,
      createEmbedder: () => new MockEmbedder(),
      createExtractor: () => new MockExtractor(["explicit override"]),
      devicePrefix: "testdevice01",
    })

    const addTool = plugin.tools.find((t) => t.name === "memory_add")!
    await addTool.execute(
      { text: "Explicit user", userId: "custom:user" },
      { config: buildConfig(), sessionId: "agent:main:telegram:direct:123" },
    )

    const listTool = plugin.tools.find((t) => t.name === "memory_list")!
    const results = await listTool.execute(
      { userId: "custom:user" },
      { config: buildConfig() },
    ) as Array<{ data: string; user_id: string }>

    expect(results).toHaveLength(1)
    expect(results[0]!.user_id).toBe("custom:user")
  })

  it("two different agents have isolated memory pools", async () => {
    const storage = new InMemoryStorageProvider()
    const plugin = createPlugin({
      createStorageProvider: () => storage,
      createEmbedder: () => new MockEmbedder(),
      createExtractor: () => new MockExtractor(["agent fact"]),
      devicePrefix: "testdevice01",
    })

    const addTool = plugin.tools.find((t) => t.name === "memory_add")!
    const listTool = plugin.tools.find((t) => t.name === "memory_list")!

    await addTool.execute(
      { text: "Main agent memory" },
      { config: buildConfig(), sessionId: "agent:main:telegram:direct:123" },
    )
    await addTool.execute(
      { text: "Bob agent memory" },
      { config: buildConfig(), sessionId: "agent:bob:telegram:direct:456" },
    )

    const mainResults = await listTool.execute(
      {},
      { config: buildConfig(), sessionId: "agent:main:telegram:direct:123" },
    ) as Array<{ data: string; user_id: string }>

    const bobResults = await listTool.execute(
      {},
      { config: buildConfig(), sessionId: "agent:bob:telegram:direct:456" },
    ) as Array<{ data: string; user_id: string }>

    expect(mainResults).toHaveLength(1)
    expect(mainResults[0]!.user_id).toBe("testdevice01:main")
    expect(bobResults).toHaveLength(1)
    expect(bobResults[0]!.user_id).toBe("testdevice01:bob")
  })

  it("loadInstanceId: generates and persists a UUID when file does not exist", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawd-remember-test-"))
    const instanceIdPath = path.join(tmpDir, "clawd-remember-instance-id")

    try {
      const id1 = await loadInstanceId(instanceIdPath)
      const id2 = await loadInstanceId(instanceIdPath)

      // Stable across calls
      expect(id1).toBe(id2)
      // First 12 chars of a UUID v4
      expect(id1.length).toBe(12)

      // File was persisted as a full UUID v4
      const raw = await fs.readFile(instanceIdPath, "utf-8")
      expect(raw.trim()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
      // The prefix is the first 12 chars of the persisted UUID
      expect(raw.trim().slice(0, 12)).toBe(id1)
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })

  it("loadInstanceId: reads existing UUID from file without regenerating", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawd-remember-test-"))
    const instanceIdPath = path.join(tmpDir, "clawd-remember-instance-id")

    try {
      const knownUUID = "aabbccdd-1122-4000-8000-ffeeddccbbaa"
      await fs.writeFile(instanceIdPath, knownUUID, "utf-8")

      const id = await loadInstanceId(instanceIdPath)
      expect(id).toBe("aabbccdd-112")  // first 12 chars of the known UUID
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })

  it("plugin uses instanceIdPath injectable for stable partition prefix", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawd-remember-test-"))
    const instanceIdPath = path.join(tmpDir, "clawd-remember-instance-id")

    try {
      const storage = new InMemoryStorageProvider()
      const plugin = createPlugin({
        createStorageProvider: () => storage,
        createEmbedder: () => new MockEmbedder(),
        createExtractor: () => new MockExtractor(["instance id fact"]),
        instanceIdPath,
      })

      const addTool = plugin.tools.find((t) => t.name === "memory_add")!
      await addTool.execute(
        { text: "Instance ID test" },
        { config: buildConfig(), sessionId: "agent:main:telegram:direct:999" },
      )

      const listTool = plugin.tools.find((t) => t.name === "memory_list")!
      const results = await listTool.execute(
        {},
        { config: buildConfig(), sessionId: "agent:main:telegram:direct:999" },
      ) as Array<{ data: string; user_id: string }>

      expect(results).toHaveLength(1)
      // The key should be {first 12 chars of generated UUID}:main
      expect(results[0]!.user_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{3}:main$/)
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })
})
