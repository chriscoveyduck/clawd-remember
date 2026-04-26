import { describe, expect, it, jest } from "@jest/globals"

import { captureInChunks, createPlugin } from "../src/index.js"
import type { Embedder, LLMExtractor, Message, PluginConfig, SessionCaptureState, StorageProvider } from "../src/types.js"
import { MockEmbedder, InMemoryStorageProvider } from "./helpers.js"

class TestExtractor {
  public async extract(conversation: Message[]): Promise<string[]> {
    return conversation.map((message) => `Fact: ${message.content}`)
  }
}

class RecordingExtractor implements LLMExtractor {
  public seen: Message[] = []

  public async extract(conversation: Message[]): Promise<string[]> {
    this.seen = conversation
    return []
  }
}

class ThrowingExtractor implements LLMExtractor {
  public async extract(): Promise<string[]> {
    throw new Error("extractor exploded")
  }
}

class ThrowingStorageProvider implements StorageProvider {
  public async init(): Promise<void> {}

  public async insert(): Promise<void> {
    throw new Error("storage insert failed")
  }

  public async search(): Promise<never> {
    throw new Error("storage search failed")
  }

  public async get(): Promise<null> {
    return null
  }

  public async delete(): Promise<void> {}

  public async list(): Promise<[]> {
    return []
  }

  public async getSessionState(): Promise<SessionCaptureState | null> {
    return null
  }

  public async upsertWatermark(): Promise<void> {}

  public async markCompleted(): Promise<void> {}
}

class RecordingStorageProvider extends InMemoryStorageProvider {
  public readonly watermarkUpdates: Array<{ sessionKey: string; watermark: number }> = []
  public readonly completedSessions: string[] = []

  public override async upsertWatermark(sessionKey: string, watermark: number): Promise<void> {
    this.watermarkUpdates.push({ sessionKey, watermark })
    await super.upsertWatermark(sessionKey, watermark)
  }

  public override async markCompleted(sessionKey: string): Promise<void> {
    this.completedSessions.push(sessionKey)
    await super.markCompleted(sessionKey)
  }
}

class ChunkRecordingExtractor implements LLMExtractor {
  public readonly chunkSizes: number[] = []
  public failAtChunk?: number

  public async extract(conversation: Message[]): Promise<string[]> {
    this.chunkSizes.push(conversation.length)
    if (this.failAtChunk !== undefined && this.chunkSizes.length === this.failAtChunk) {
      throw new Error("chunk failed")
    }
    return [`Fact: ${conversation.map((message) => message.content).join(" | ")}`]
  }
}

function buildConfig(overrides: Partial<PluginConfig> = {}): PluginConfig {
  return {
    storage: {
      provider: "sqlite",
      config: { path: "/tmp/test.db" },
    },
    embedder: {
      provider: "ollama",
      config: { url: "http://localhost:11434", model: "nomic-embed-text" },
    },
    llm: {
      provider: "openai-compatible",
      config: { baseURL: "http://localhost:4141/v1", model: "gpt-4o-mini", apiKey: "dummy" },
    },
    userId: "user-1",
    autoRecall: true,
    autoCapture: true,
    topK: 5,
    recallTimeout: 1000,
    captureTimeout: 1000,
    ...overrides,
  }
}

describe("plugin entry", () => {
  const config = buildConfig()

  it("captures facts after an agent turn", async () => {
    const plugin = createPlugin({
      createStorageProvider: () => new InMemoryStorageProvider(),
      createEmbedder: () => new MockEmbedder(),
      createExtractor: () => new TestExtractor(),
    })
    const context = await plugin.hooks.after_agent_turn({
      config,
      messages: [{ role: "user", content: "User likes tea" }],
      logger: { warn: jest.fn() },
    })

    expect(context.messages).toHaveLength(1)
  })

  it("injects recall results before prompt build", async () => {
    const plugin = createPlugin({
      createStorageProvider: () => new InMemoryStorageProvider(),
      createEmbedder: () => new MockEmbedder(),
      createExtractor: () => new TestExtractor(),
    })
    const baseContext = {
      config,
      messages: [{ role: "user", content: "User likes tea" }],
      prompt: "What drink does the user prefer?",
      logger: { warn: jest.fn() },
    }

    await plugin.hooks.after_agent_turn(baseContext)
    const updated = await plugin.hooks.before_prompt_build(baseContext)

    expect(updated.prompt).toContain("Relevant memory:")
  })

  it("executes registered tools", async () => {
    const plugin = createPlugin({
      createStorageProvider: () => new InMemoryStorageProvider(),
      createEmbedder: () => new MockEmbedder(),
      createExtractor: () => new TestExtractor(),
    })
    const addTool = plugin.tools.find((tool) => tool.name === "memory_add")
    const searchTool = plugin.tools.find((tool) => tool.name === "memory_search")

    await addTool?.execute({ text: "User likes tea" }, { config, logger: { warn: jest.fn() } })
    const results = await searchTool?.execute({ query: "tea" }, { config, logger: { warn: jest.fn() } }) as Array<{ fact: { data: string } }>

    expect(results[0]?.fact.data).toBe("User likes tea")
  })

  it("lists memories through the memory_list tool", async () => {
    const plugin = createPlugin({
      createStorageProvider: () => new InMemoryStorageProvider(),
      createEmbedder: () => new MockEmbedder(),
      createExtractor: () => new TestExtractor(),
    })
    const addTool = plugin.tools.find((tool) => tool.name === "memory_add")
    const listTool = plugin.tools.find((tool) => tool.name === "memory_list")

    await addTool?.execute({ text: "User likes tea" }, { config, logger: { warn: jest.fn() } })
    await addTool?.execute({ text: "User has a cat" }, { config, logger: { warn: jest.fn() } })
    const results = await listTool?.execute({}, { config, logger: { warn: jest.fn() } }) as Array<{ data: string }>

    expect(results).toHaveLength(2)
    expect(results.map((item) => item.data)).toEqual(expect.arrayContaining(["User likes tea", "User has a cat"]))
  })

  it("deletes memories through the memory_delete tool", async () => {
    const plugin = createPlugin({
      createStorageProvider: () => new InMemoryStorageProvider(),
      createEmbedder: () => new MockEmbedder(),
      createExtractor: () => new TestExtractor(),
    })
    const addTool = plugin.tools.find((tool) => tool.name === "memory_add")
    const deleteTool = plugin.tools.find((tool) => tool.name === "memory_delete")
    const searchTool = plugin.tools.find((tool) => tool.name === "memory_search")

    const created = await addTool?.execute({ text: "User likes tea" }, { config, logger: { warn: jest.fn() } }) as { id: string }
    await deleteTool?.execute({ id: created.id }, { config, logger: { warn: jest.fn() } })
    const results = await searchTool?.execute({ query: "tea" }, { config, logger: { warn: jest.fn() } }) as Array<{ fact: { data: string } }>

    expect(results).toEqual([])
  })
})

describe("safeRun degradation", () => {
  it("returns the original context when capture fails", async () => {
    const logger = { warn: jest.fn() }
    const plugin = createPlugin({
      createStorageProvider: () => new InMemoryStorageProvider(),
      createEmbedder: () => new MockEmbedder(),
      createExtractor: () => new ThrowingExtractor(),
    })
    const context = {
      config: buildConfig(),
      messages: [{ role: "user", content: "User likes tea" }],
      logger,
    }

    await expect(plugin.hooks.after_agent_turn(context)).resolves.toBe(context)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("agent_end"))
  })

  it("skips capture when agent turn was unsuccessful", async () => {
    const plugin = createPlugin({
      createStorageProvider: () => new InMemoryStorageProvider(),
      createEmbedder: () => new MockEmbedder(),
      createExtractor: () => new TestExtractor(),
    })
    const context = {
      config: buildConfig(),
      messages: [{ role: "user", content: "User likes tea" }],
      success: false,
      logger: { warn: jest.fn() },
    }
    const searchTool = plugin.tools.find((tool) => tool.name === "memory_search")

    await expect(plugin.hooks.after_agent_turn(context)).resolves.toBe(context)
    await expect(searchTool?.execute({ query: "tea" }, { config: buildConfig(), logger: { warn: jest.fn() } })).resolves.toEqual([])
  })

  it("returns the original context when recall fails", async () => {
    const logger = { warn: jest.fn() }
    const plugin = createPlugin({
      createStorageProvider: () => new ThrowingStorageProvider(),
      createEmbedder: () => new MockEmbedder(),
      createExtractor: () => new TestExtractor(),
    })
    const context = {
      config: buildConfig(),
      prompt: "What does the user prefer?",
      logger,
    }

    await expect(plugin.hooks.before_prompt_build(context)).resolves.toBe(context)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("before_prompt_build"))
  })

  it("returns [] from memory_search when storage throws", async () => {
    const logger = { warn: jest.fn() }
    const plugin = createPlugin({
      createStorageProvider: () => new ThrowingStorageProvider(),
      createEmbedder: () => new MockEmbedder(),
      createExtractor: () => new TestExtractor(),
    })
    const searchTool = plugin.tools.find((tool) => tool.name === "memory_search")

    await expect(searchTool?.execute({ query: "tea" }, { config: buildConfig(), logger })).resolves.toEqual([])
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("memory_search tool"))
  })

  it("returns null from memory_add when storage throws", async () => {
    const logger = { warn: jest.fn() }
    const plugin = createPlugin({
      createStorageProvider: () => new ThrowingStorageProvider(),
      createEmbedder: () => new MockEmbedder(),
      createExtractor: () => new TestExtractor(),
    })
    const addTool = plugin.tools.find((tool) => tool.name === "memory_add")

    await expect(addTool?.execute({ text: "User likes tea" }, { config: buildConfig(), logger })).resolves.toBeNull()
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("memory_add tool"))
  })
})

describe("normalizeConfig", () => {
  it("applies defaults when config is omitted", async () => {
    let seenConfig: PluginConfig | undefined
    const plugin = createPlugin({
      createStorageProvider: (currentConfig) => {
        seenConfig = currentConfig
        return new InMemoryStorageProvider()
      },
      createEmbedder: () => new MockEmbedder(),
      createExtractor: () => new TestExtractor(),
    })

    const searchTool = plugin.tools.find((tool) => tool.name === "memory_search")
    await searchTool?.execute({ query: "tea" }, { logger: { warn: jest.fn() } })

    expect(seenConfig).toMatchObject({
      storage: { provider: "sqlite", config: { path: "~/.openclaw/clawd-remember.db" } },
      embedder: { provider: "ollama", config: { url: "http://localhost:11434", model: "nomic-embed-text" } },
      llm: {
        provider: "openai-compatible",
        config: { baseURL: "http://localhost:4141/v1", model: "gpt-4o-mini", apiKey: "dummy" },
      },
      // userId is now undefined by default (partition key derived from session key)
      // userId: undefined,
      autoRecall: true,
      autoCapture: true,
      topK: 10,
      deduplicationThreshold: undefined,
      recallTimeout: 10000,
      captureTimeout: 45000,
      chunkSize: 20,
    })
  })

  it("fills missing fields from a partial config", async () => {
    let seenConfig: PluginConfig | undefined
    const plugin = createPlugin({
      createStorageProvider: (currentConfig) => {
        seenConfig = currentConfig
        return new InMemoryStorageProvider()
      },
      createEmbedder: () => new MockEmbedder(),
      createExtractor: () => new TestExtractor(),
    })

    const partialConfig = {
      storage: {
        provider: "sqlite",
        config: { path: "/tmp/custom.db" },
      },
      embedder: {
        provider: "ollama",
        config: { url: "http://ollama.internal" },
      },
      llm: {
        provider: "openai-compatible",
        config: { apiKey: "secret" },
      },
      userId: "user-9",
      autoCapture: false,
      deduplicationThreshold: 0.95,
    } as PluginConfig

    const searchTool = plugin.tools.find((tool) => tool.name === "memory_search")
    await searchTool?.execute({ query: "tea" }, { config: partialConfig, logger: { warn: jest.fn() } })

    expect(seenConfig).toMatchObject({
      storage: { provider: "sqlite", config: { path: "/tmp/custom.db" } },
      embedder: { provider: "ollama", config: { url: "http://ollama.internal", model: "nomic-embed-text" } },
      llm: {
        provider: "openai-compatible",
        config: { baseURL: "http://localhost:4141/v1", model: "gpt-4o-mini", apiKey: "secret" },
      },
      userId: "user-9",
      autoRecall: true,
      autoCapture: false,
      topK: 10,
      deduplicationThreshold: 0.95,
      recallTimeout: 10000,
      captureTimeout: 45000,
      chunkSize: 20,
    })
  })

  it("uses 45000ms as the default capture timeout when not configured", async () => {
    const setTimeoutSpy = jest.spyOn(global, "setTimeout")
    const plugin = createPlugin({
      createStorageProvider: () => new InMemoryStorageProvider(),
      createEmbedder: () => new MockEmbedder(),
      createExtractor: () => new RecordingExtractor(),
    })

    await plugin.hooks.after_agent_turn({
      config: {
        ...buildConfig(),
        captureTimeout: undefined,
      },
      messages: [{ role: "user", content: "User likes tea" }],
      logger: { warn: jest.fn() },
    })

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 45000)
    setTimeoutSpy.mockRestore()
  })
})

describe("message normalization", () => {
  it("normalizes array content blocks and filters invalid messages", async () => {
    const extractor = new RecordingExtractor()
    const plugin = createPlugin({
      createStorageProvider: () => new InMemoryStorageProvider(),
      createEmbedder: () => new MockEmbedder(),
      createExtractor: () => extractor,
    })

    await plugin.hooks.after_agent_turn({
      config: buildConfig(),
      messages: [
        { role: "user", content: [{ type: "text", text: "hello" }] },
        { role: "assistant", content: "" },
        42,
        null,
        { role: "user", content: [{ type: "text", text: "" }] },
      ] as unknown as Message[],
      logger: { warn: jest.fn() },
    })

    expect(extractor.seen).toEqual([{ role: "user", content: "hello" }])
  })

  it("captureInChunks processes messages in configured chunk sizes", async () => {
    const extractor = new ChunkRecordingExtractor()
    const storage = new InMemoryStorageProvider()
    const manager = {
      async capture(messages: Message[]) {
        return extractor.extract(messages).then((facts) => facts.map((fact, index) => ({
          id: `${index}`,
          data: fact,
          hash: fact,
          user_id: "user-1",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })))
      },
    }

    const total = await captureInChunks(
      manager,
      Array.from({ length: 45 }, (_, index) => ({ role: "user", content: `message-${index + 1}` })),
      { userId: "user-1", sessionId: "session-1" },
      20,
    )

    expect(total).toBe(3)
    expect(extractor.chunkSizes).toEqual([20, 20, 5])
    expect(await storage.getSessionState("session-1")).toBeNull()
  })

  it("agentEnd reads watermark and only captures the delta", async () => {
    const storage = new RecordingStorageProvider()
    await storage.upsertWatermark("agent:main:test:1", 2)
    const extractor = new ChunkRecordingExtractor()
    const plugin = createPlugin({
      createStorageProvider: () => storage,
      createEmbedder: () => new MockEmbedder(),
      createExtractor: () => extractor,
      devicePrefix: "testdevice01",
    })

    await plugin.hooks.after_agent_turn({
      config: buildConfig({ chunkSize: 2 }),
      sessionId: "agent:main:test:1",
      messages: [
        { role: "user", content: "m1" },
        { role: "assistant", content: "m2" },
        { role: "user", content: "m3" },
        { role: "assistant", content: "m4" },
        { role: "user", content: "m5" },
      ],
      logger: { warn: jest.fn() },
    })

    expect(extractor.chunkSizes).toEqual([2, 1])
    expect(storage.watermarkUpdates.map((item) => item.watermark)).toEqual([2, 4, 5])
    const state = await storage.getSessionState("agent:main:test:1")
    expect(state).toMatchObject({ watermark: 5, completedAt: null })
  })

  it("filters tool messages before extraction", async () => {
    const extractor = new RecordingExtractor()
    const plugin = createPlugin({
      createStorageProvider: () => new InMemoryStorageProvider(),
      createEmbedder: () => new MockEmbedder(),
      createExtractor: () => extractor,
    })

    await plugin.hooks.after_agent_turn({
      config: buildConfig(),
      messages: [
        { role: "user", content: "m1" },
        { role: "toolResult", content: "large tool payload" },
        { role: "tool", content: "tool invocation" },
        { role: "assistant", content: "m2" },
      ],
      logger: { warn: jest.fn() },
    })

    expect(extractor.seen).toEqual([
      { role: "user", content: "m1" },
      { role: "assistant", content: "m2" },
    ])
  })

  it("advances the watermark when a delta chunk only contains tool messages", async () => {
    const storage = new RecordingStorageProvider()
    const extractor = new ChunkRecordingExtractor()
    const plugin = createPlugin({
      createStorageProvider: () => storage,
      createEmbedder: () => new MockEmbedder(),
      createExtractor: () => extractor,
      devicePrefix: "testdevice01",
    })

    await plugin.hooks.after_agent_turn({
      config: buildConfig({ chunkSize: 2 }),
      sessionId: "agent:main:test:tool-only",
      messages: [
        { role: "toolResult", content: "payload-1" },
        { role: "tool", content: "payload-2" },
      ],
      logger: { warn: jest.fn() },
    })

    expect(extractor.chunkSizes).toEqual([])
    expect(storage.watermarkUpdates.map((item) => item.watermark)).toEqual([2])
    const state = await storage.getSessionState("agent:main:test:tool-only")
    expect(state).toMatchObject({ watermark: 2, completedAt: null })
  })

  it("beforeReset marks the session completed after capture", async () => {
    const storage = new RecordingStorageProvider()
    const extractor = new ChunkRecordingExtractor()
    const plugin = createPlugin({
      createStorageProvider: () => storage,
      createEmbedder: () => new MockEmbedder(),
      createExtractor: () => extractor,
      devicePrefix: "testdevice01",
    })

    await plugin.hooks.before_reset({
      config: buildConfig({ chunkSize: 2 }),
      sessionId: "agent:main:test:2",
      messages: [
        { role: "user", content: "m1" },
        { role: "assistant", content: "m2" },
        { role: "user", content: "m3" },
      ],
      logger: { warn: jest.fn() },
    })

    expect(extractor.chunkSizes).toEqual([2, 1])
    expect(storage.completedSessions).toEqual(["agent:main:test:2"])
    const state = await storage.getSessionState("agent:main:test:2")
    expect(state?.watermark).toBe(3)
    expect(state?.completedAt).toEqual(expect.any(String))
  })

  it("beforeReset skips capture when the session is already completed", async () => {
    const storage = new RecordingStorageProvider()
    await storage.upsertWatermark("agent:main:test:3", 2)
    await storage.markCompleted("agent:main:test:3")
    const extractor = new ChunkRecordingExtractor()
    const plugin = createPlugin({
      createStorageProvider: () => storage,
      createEmbedder: () => new MockEmbedder(),
      createExtractor: () => extractor,
      devicePrefix: "testdevice01",
    })

    await plugin.hooks.before_reset({
      config: buildConfig(),
      sessionId: "agent:main:test:3",
      messages: [
        { role: "user", content: "m1" },
        { role: "assistant", content: "m2" },
        { role: "user", content: "m3" },
      ],
      logger: { warn: jest.fn() },
    })

    expect(extractor.chunkSizes).toEqual([])
    expect(storage.completedSessions).toEqual(["agent:main:test:3"])
    const state = await storage.getSessionState("agent:main:test:3")
    expect(state).toMatchObject({ watermark: 2 })
    expect(state?.completedAt).toEqual(expect.any(String))
  })

  it("compaction resets the watermark to 0 after the post-compaction callback", async () => {
    const storage = new RecordingStorageProvider()
    const handlers = new Map<string, (event: unknown, ctx: { sessionKey?: string; agentId?: string }) => Promise<unknown> | unknown>()
    const pluginEntry = (await import("../src/index.js")).default

    pluginEntry.register({
      pluginConfig: buildConfig({ useConversationAccess: false, chunkSize: 2 }) as unknown as Record<string, unknown>,
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
      registerTool: () => undefined,
      on(event: string, handler: (event: unknown, ctx: { sessionKey?: string; agentId?: string }) => Promise<unknown> | unknown) {
        handlers.set(event, handler)
      },
    } as never)

    const runtimePlugin = createPlugin({
      createStorageProvider: () => storage,
      createEmbedder: () => new MockEmbedder(),
      createExtractor: () => new ChunkRecordingExtractor(),
      devicePrefix: "testdevice01",
    })

    await runtimePlugin.hooks.before_compaction({
      config: buildConfig({ chunkSize: 2 }),
      sessionId: "agent:main:test:4",
      messages: [
        { role: "user", content: "m1" },
        { role: "assistant", content: "m2" },
        { role: "user", content: "m3" },
      ],
      logger: { warn: jest.fn() },
    })

    const stateBeforeReset = await storage.getSessionState("agent:main:test:4")
    expect(stateBeforeReset).toMatchObject({ watermark: 3, completedAt: null })

    await runtimePlugin.hooks.after_compaction({
      config: buildConfig({ chunkSize: 2 }),
      sessionId: "agent:main:test:4",
      logger: { warn: jest.fn() },
    })

    const stateAfterReset = await storage.getSessionState("agent:main:test:4")
    expect(stateAfterReset).toMatchObject({ watermark: 0, completedAt: null })
    expect(handlers.has("after_compaction")).toBe(true)
  })
})
