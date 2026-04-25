import { afterEach, describe, expect, it, jest } from "@jest/globals"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import pluginEntry, { createPlugin } from "../src/index.js"
import type { Message, PluginConfig } from "../src/types.js"
import { MockEmbedder, InMemoryStorageProvider } from "./helpers.js"

class CountingExtractor {
  public calls = 0

  public async extract(conversation: Message[]): Promise<string[]> {
    this.calls += 1
    return conversation.map((message) => `Fact ${this.calls}: ${message.content}`)
  }
}

describe("plugin entry", () => {
  const config: PluginConfig = {
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
  }

  let tempDir: string | undefined

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true })
      tempDir = undefined
    }
  })

  it("registers agent_end only when useConversationAccess is true", () => {
    const api = {
      pluginConfig: { ...config, useConversationAccess: true },
      logger: { warn: jest.fn() },
      registerTool: jest.fn(),
      on: jest.fn(),
    }

    pluginEntry.register(api as never)

    expect(api.on).toHaveBeenCalledWith("before_prompt_build", expect.any(Function))
    expect(api.on).toHaveBeenCalledWith("agent_end", expect.any(Function))
    expect(api.on).not.toHaveBeenCalledWith("before_reset", expect.any(Function))
    expect(api.on).not.toHaveBeenCalledWith("session_end", expect.any(Function))
    expect(api.on).not.toHaveBeenCalledWith("before_compaction", expect.any(Function))
  })

  it("captures facts after an agent turn in conversation mode", async () => {
    const extractor = new CountingExtractor()
    const plugin = createPlugin({
      createStorageProvider: async () => new InMemoryStorageProvider(),
      createEmbedder: () => new MockEmbedder(),
      createExtractor: () => extractor,
    })

    const context = await plugin.hooks.after_agent_turn({
      config: { ...config, useConversationAccess: true },
      messages: [{ role: "user", content: "User likes tea" }],
      logger: { warn: jest.fn() },
    })

    expect(context.messages).toHaveLength(1)
    expect(extractor.calls).toBe(1)
  })

  it("captures on before_reset in hooks mode", async () => {
    const extractor = new CountingExtractor()
    const plugin = createPlugin({
      createStorageProvider: async () => new InMemoryStorageProvider(),
      createEmbedder: () => new MockEmbedder(),
      createExtractor: () => extractor,
    })

    await plugin.hooks.before_reset({
      config,
      messages: [{ role: "user", content: "User likes tea" }],
      sessionId: "session-1",
      logger: { warn: jest.fn() },
    })

    expect(extractor.calls).toBe(1)
  })

  it("skips before_reset capture when messages are empty", async () => {
    const extractor = new CountingExtractor()
    const plugin = createPlugin({
      createStorageProvider: async () => new InMemoryStorageProvider(),
      createEmbedder: () => new MockEmbedder(),
      createExtractor: () => extractor,
    })

    await plugin.hooks.before_reset({
      config,
      messages: [],
      sessionId: "session-1",
      logger: { warn: jest.fn() },
    })

    expect(extractor.calls).toBe(0)
  })

  it("captures transcript messages on session_end in hooks mode", async () => {
    const extractor = new CountingExtractor()
    const plugin = createPlugin({
      createStorageProvider: async () => new InMemoryStorageProvider(),
      createEmbedder: () => new MockEmbedder(),
      createExtractor: () => extractor,
    })

    tempDir = await mkdtemp(join(tmpdir(), "clawd-remember-"))
    const sessionFile = join(tempDir, "session.jsonl")
    await writeFile(sessionFile, [
      JSON.stringify({ type: "message", message: { role: "system", content: "ignore" } }),
      JSON.stringify({ type: "message", message: { role: "user", content: "User likes tea" } }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: [{ text: "Tea noted" }] } }),
      JSON.stringify({ type: "tool", message: { role: "assistant", content: "ignore" } }),
    ].join("\n"))

    await plugin.hooks.session_end({
      config,
      sessionId: "session-1",
      sessionFile,
      logger: { warn: jest.fn() },
    })

    expect(extractor.calls).toBe(1)
  })

  it("deduplicates repeated session_end events for the same session", async () => {
    const extractor = new CountingExtractor()
    const plugin = createPlugin({
      createStorageProvider: async () => new InMemoryStorageProvider(),
      createEmbedder: () => new MockEmbedder(),
      createExtractor: () => extractor,
    })

    tempDir = await mkdtemp(join(tmpdir(), "clawd-remember-"))
    const sessionFile = join(tempDir, "session.jsonl")
    await writeFile(sessionFile, JSON.stringify({
      type: "message",
      message: { role: "user", content: "User likes tea" },
    }))

    const context = {
      config,
      sessionId: "session-1",
      sessionFile,
      logger: { warn: jest.fn() },
    }

    await plugin.hooks.session_end(context)
    await plugin.hooks.session_end(context)

    expect(extractor.calls).toBe(1)
  })

  it("captures on before_compaction in hooks mode", async () => {
    const extractor = new CountingExtractor()
    const plugin = createPlugin({
      createStorageProvider: async () => new InMemoryStorageProvider(),
      createEmbedder: () => new MockEmbedder(),
      createExtractor: () => extractor,
    })

    await plugin.hooks.before_compaction({
      config,
      messages: [{ role: "user", content: "User likes tea" }],
      messageCount: 100,
      sessionId: "session-1",
      logger: { warn: jest.fn() },
    })

    expect(extractor.calls).toBe(1)
  })

  it("injects recall results before prompt build", async () => {
    const extractor = new CountingExtractor()
    const plugin = createPlugin({
      createStorageProvider: async () => new InMemoryStorageProvider(),
      createEmbedder: () => new MockEmbedder(),
      createExtractor: () => extractor,
    })
    const baseContext = {
      config: { ...config, useConversationAccess: true },
      messages: [{ role: "user", content: "User likes tea" }],
      prompt: "What drink does the user prefer?",
      logger: { warn: jest.fn() },
    }

    await plugin.hooks.after_agent_turn(baseContext)
    const updated = await plugin.hooks.before_prompt_build(baseContext)

    expect(updated.prompt).toContain("Relevant memory:")
  })

  it("executes registered tools", async () => {
    const extractor = new CountingExtractor()
    const plugin = createPlugin({
      createStorageProvider: async () => new InMemoryStorageProvider(),
      createEmbedder: () => new MockEmbedder(),
      createExtractor: () => extractor,
    })
    const addTool = plugin.tools.find((tool) => tool.name === "memory_add")
    const searchTool = plugin.tools.find((tool) => tool.name === "memory_search")

    await addTool?.execute({ text: "User likes tea" }, { config, logger: { warn: jest.fn() } })
    const results = await searchTool?.execute({ query: "tea" }, { config, logger: { warn: jest.fn() } }) as Array<{ fact: { data: string } }>

    expect(results[0]?.fact.data).toBe("User likes tea")
  })
})
