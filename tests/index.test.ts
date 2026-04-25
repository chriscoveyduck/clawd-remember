import { describe, expect, it, jest } from "@jest/globals"

import { createPlugin } from "../src/index.js"
import type { Embedder, LLMExtractor, Message, PluginConfig, StorageProvider } from "../src/types.js"
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
      userId: "default",
      autoRecall: true,
      autoCapture: true,
      topK: 10,
      recallTimeout: 10000,
      captureTimeout: 15000,
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
      recallTimeout: 10000,
      captureTimeout: 15000,
    })
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
})
