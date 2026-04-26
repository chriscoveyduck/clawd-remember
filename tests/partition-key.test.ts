/**
 * Tests for two-level memory partition key derivation.
 *
 * Partition key format: `{devicePrefix}:{agentId}`
 *   Level 1: first 12 chars of deviceId from ~/.openclaw/identity/device.json
 *            (falls back to hostname if file missing)
 *   Level 2: agentId from session key (e.g. "main"), or config.userId override, or "default"
 */

import { describe, expect, it } from "@jest/globals"
import { createPlugin } from "../src/index.js"
import type { PluginConfig } from "../src/types.js"
import { InMemoryStorageProvider, MockEmbedder, MockExtractor } from "./helpers.js"
import os from "node:os"

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

  it("falls back to hostname prefix when device.json is missing", async () => {
    // No devicePrefix injected — it will try to read device.json which won't be at a test path.
    // We can't fully test loadDevicePrefix() without mocking fs, so we test the hostname fallback
    // by verifying the plugin works and the key is structured correctly.
    // This test just validates behaviour when devicePrefix injectable is NOT provided — the
    // real loadDevicePrefix() will either succeed (if device.json exists) or use hostname.
    const storage = new InMemoryStorageProvider()
    const plugin = createPlugin({
      createStorageProvider: () => storage,
      createEmbedder: () => new MockEmbedder(),
      createExtractor: () => new MockExtractor(["hostname fallback fact"]),
      // NOTE: no devicePrefix — uses real loadDevicePrefix()
    })

    const addTool = plugin.tools.find((t) => t.name === "memory_add")!
    await addTool.execute(
      { text: "Hostname fallback" },
      { config: buildConfig(), sessionId: "agent:main:telegram:direct:999" },
    )

    const listTool = plugin.tools.find((t) => t.name === "memory_list")!
    const results = await listTool.execute(
      {},
      { config: buildConfig(), sessionId: "agent:main:telegram:direct:999" },
    ) as Array<{ data: string; user_id: string }>

    expect(results).toHaveLength(1)
    // The user_id should be `{prefix}:main` — prefix is either real deviceId or hostname
    expect(results[0]!.user_id).toMatch(/^.{1,12}:main$/)
  })
})
