import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry"
import { readFile } from "node:fs/promises"
import { Type } from "@sinclair/typebox"

import { MemoryManager } from "./memory.js"
import { OllamaEmbedder } from "./embedders/ollama.js"
import { OpenAICompatibleExtractor } from "./extractors/openai.js"
import { PostgresStorageProvider } from "./storage/postgres.js"
import type { Embedder, LLMExtractor, Message, PluginConfig, RecallOptions, StorageProvider } from "./types.js"
import { withTimeout } from "./utils.js"

type LoggerLike = {
  warn?: (message: string) => void
}

type RuntimeContext = {
  logger?: LoggerLike
  sessionKey?: string
}

type ToolContext = RuntimeContext

type ToolInput = Record<string, unknown>

type PluginDependencies = {
  createStorageProvider?: (config: PluginConfig) => Promise<StorageProvider>
  createEmbedder?: (config: PluginConfig) => Embedder
  createExtractor?: (config: PluginConfig) => LLMExtractor
}

type LegacyHookContext = {
  config?: PluginConfig
  logger?: LoggerLike
  prompt?: string
  input?: string
  messages?: Message[]
  conversation?: Message[]
  userId?: string
  sessionId?: string
  sessionFile?: string
  reason?: string
  messageCount?: number
}

type SessionMessageEvent = {
  messages?: unknown
  sessionFile?: string
}

type SessionEndEvent = {
  sessionFile?: string
  sessionId: string
  reason?: string
}

async function createManager(config: PluginConfig, dependencies: PluginDependencies = {}): Promise<MemoryManager> {
  const storage = await (dependencies.createStorageProvider ?? createStorageProvider)(config)
  const embedder = (dependencies.createEmbedder ?? ((currentConfig) => new OllamaEmbedder(currentConfig.embedder.config)))(config)
  const extractor = (dependencies.createExtractor ?? ((currentConfig) => new OpenAICompatibleExtractor(currentConfig.llm.config)))(config)
  const manager = new MemoryManager(storage, embedder, extractor, {
    userId: config.userId,
    sessionId: config.sessionId,
    categories: config.categories,
    topK: config.topK,
  })
  await manager.init()
  return manager
}

async function createStorageProvider(config: PluginConfig): Promise<StorageProvider> {
  if (config.storage.provider === "postgres") {
    return new PostgresStorageProvider(config.storage.config)
  }
  if (config.storage.provider === "sqlite") {
    // Dynamic import to avoid module-level resolution of optional better-sqlite3
    const { SqliteStorageProvider } = await import("./storage/sqlite.js") as { SqliteStorageProvider: new (c: unknown) => StorageProvider }
    return new SqliteStorageProvider(config.storage.config)
  }
  throw new Error(`Storage provider ${(config.storage as { provider: string }).provider} is not implemented yet`)
}

function warn(context: RuntimeContext | undefined, scope: string, error: unknown): void {
  const logger = context?.logger
  const message = error instanceof Error ? error.message : String(error)
  logger?.warn?.(`[clawd-remember] ${scope}: ${message}`)
}

async function safeRun<T>(context: RuntimeContext | undefined, scope: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    warn(context, scope, error)
    return fallback
  }
}

function formatMemories(memories: Awaited<ReturnType<MemoryManager["recall"]>>): string {
  if (!memories.length) {
    return ""
  }

  return [
    "Relevant memory:",
    ...memories.map((item) => `- ${item.fact.data}`),
  ].join("\n")
}

function normalizeContent(content: unknown): string {
  if (typeof content === "string") {
    return content
  }

  if (!Array.isArray(content)) {
    return ""
  }

  return content
    .map((block) => {
      if (typeof block === "string") {
        return block
      }

      if (!block || typeof block !== "object") {
        return ""
      }

      const text = "text" in block ? block.text : undefined
      return typeof text === "string" ? text : ""
    })
    .filter(Boolean)
    .join("\n")
}

function normalizeMessages(messages: unknown): Message[] {
  if (!Array.isArray(messages)) {
    return []
  }

  return messages.flatMap((message) => {
    if (!message || typeof message !== "object") {
      return []
    }

    const role = "role" in message && typeof message.role === "string" ? message.role : "user"
    const content = normalizeContent("content" in message ? message.content : undefined)
    if (!content.trim()) {
      return []
    }

    return [{ role, content }]
  })
}

async function loadMessagesFromSessionFile(sessionFile: string): Promise<Message[]> {
  const content = await readFile(sessionFile, "utf8")
  const messages: Message[] = []

  for (const line of content.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) {
      continue
    }

    const entry = JSON.parse(trimmed) as {
      type?: unknown
      message?: { role?: unknown; content?: unknown }
    }

    if (entry.type !== "message") {
      continue
    }

    const role = entry.message?.role
    if (role !== "user" && role !== "assistant") {
      continue
    }

    const message = normalizeMessages([{ role, content: entry.message?.content }])
    messages.push(...message)
  }

  return messages
}

function resolveUserId(context: RuntimeContext | undefined, config: PluginConfig, override?: unknown): string {
  if (typeof override === "string" && override.trim()) {
    return override
  }

  return context?.sessionKey ?? config.userId
}

function resolveLegacyUserId(context: LegacyHookContext, config: PluginConfig, override?: unknown): string {
  if (typeof override === "string" && override.trim()) {
    return override
  }

  return context.userId ?? config.userId
}

function normalizeConfig(config?: PluginConfig): PluginConfig {
  const storage = config?.storage?.provider === "postgres"
    ? {
      provider: "postgres" as const,
      config: config.storage.config,
    }
    : config?.storage?.provider === "mariadb"
    ? {
      provider: "mariadb" as const,
      config: config.storage.config,
    }
    : {
      provider: "sqlite" as const,
      config: config?.storage?.provider === "sqlite"
        ? config.storage.config
        : { path: "~/.openclaw/clawd-remember.db" },
    }

  return {
    storage,
    embedder: {
      provider: "ollama",
      config: {
        url: config?.embedder?.config?.url ?? "http://localhost:11434",
        model: config?.embedder?.config?.model ?? "nomic-embed-text",
        timeoutMs: config?.embedder?.config?.timeoutMs,
      },
    },
    llm: {
      provider: "openai-compatible",
      config: {
        baseURL: config?.llm?.config?.baseURL ?? "http://localhost:4141/v1",
        model: config?.llm?.config?.model ?? "gpt-4o-mini",
        apiKey: config?.llm?.config?.apiKey ?? "dummy",
        timeoutMs: config?.llm?.config?.timeoutMs,
      },
    },
    userId: config?.userId ?? "default",
    sessionId: config?.sessionId,
    autoRecall: config?.autoRecall ?? true,
    autoCapture: config?.autoCapture ?? true,
    useConversationAccess: config?.useConversationAccess ?? false,
    topK: config?.topK ?? 10,
    recallTimeout: config?.recallTimeout ?? 10_000,
    captureTimeout: config?.captureTimeout ?? 15_000,
    categories: config?.categories,
  }
}

export const configSchema = {
  type: "object",
  required: ["storage", "embedder", "llm", "userId"],
  properties: {
    storage: {
      type: "object",
      required: ["provider", "config"],
      properties: {
        provider: { type: "string", enum: ["sqlite", "mariadb", "postgres"] },
        config: {
          type: "object",
          properties: {
            path: { type: "string" },
            host: { type: "string" },
            port: { type: "number" },
            user: { type: "string" },
            password: { type: "string" },
            database: { type: "string" },
            table: { type: "string" },
          },
          additionalProperties: true,
        },
      },
      additionalProperties: false,
    },
    embedder: {
      type: "object",
      required: ["provider", "config"],
      properties: {
        provider: { type: "string", enum: ["ollama"] },
        config: {
          type: "object",
          required: ["url", "model"],
          properties: {
            url: { type: "string" },
            model: { type: "string" },
            timeoutMs: { type: "number" },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    llm: {
      type: "object",
      required: ["provider", "config"],
      properties: {
        provider: { type: "string", enum: ["openai-compatible"] },
        config: {
          type: "object",
          required: ["baseURL", "model", "apiKey"],
          properties: {
            baseURL: { type: "string" },
            model: { type: "string" },
            apiKey: { type: "string" },
            timeoutMs: { type: "number" },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    userId: { type: "string" },
    sessionId: { type: "string" },
    autoRecall: { type: "boolean" },
    autoCapture: { type: "boolean" },
    useConversationAccess: { type: "boolean" },
    topK: { type: "number" },
    recallTimeout: { type: "number" },
    captureTimeout: { type: "number" },
    categories: {
      type: "array",
      items: { type: "string" },
    },
  },
  additionalProperties: false,
} as const

function createRuntime(config: PluginConfig, logger: LoggerLike | undefined, dependencies: PluginDependencies = {}) {
  let managerPromise: Promise<MemoryManager> | null = null
  const processedSessionIds = new Set<string>()

  function getManager(): Promise<MemoryManager> {
    if (!managerPromise) {
      managerPromise = createManager(config, dependencies)
    }
    return managerPromise
  }

  async function search(input: ToolInput, ctx: ToolContext = {}) {
    return safeRun({ ...ctx, logger }, "memory_search tool", async () => {
      const manager = await getManager()
      return manager.search(String(input.query ?? ""), {
        topK: typeof input.topK === "number" ? input.topK : config.topK,
        user_id: resolveUserId(ctx, config, input.userId),
        session_id: typeof input.sessionId === "string" ? input.sessionId : ctx?.sessionKey ?? config.sessionId,
        categories: Array.isArray(input.categories)
          ? input.categories.filter((item): item is string => typeof item === "string")
          : undefined,
      } satisfies RecallOptions)
    }, [])
  }

  async function add(input: ToolInput, ctx: ToolContext = {}) {
    return safeRun({ ...ctx, logger }, "memory_add tool", async () => {
      const manager = await getManager()
      return manager.add(
        String(input.text ?? ""),
        resolveUserId(ctx, config, input.userId),
        typeof input.sessionId === "string" ? input.sessionId : ctx?.sessionKey ?? config.sessionId,
        Array.isArray(input.categories)
          ? input.categories.filter((item): item is string => typeof item === "string")
          : config.categories,
      )
    }, null)
  }

  async function remove(input: ToolInput, ctx: ToolContext = {}) {
    return safeRun({ ...ctx, logger }, "memory_delete tool", async () => {
      const manager = await getManager()
      await manager.delete(String(input.id ?? ""))
      return { deleted: true }
    }, { deleted: false })
  }

  async function beforePromptBuild(event: { prompt?: string }, ctx: RuntimeContext = {}) {
    if (!config.autoRecall) {
      return
    }

    return safeRun({ ...ctx, logger }, "before_prompt_build", async () => {
      if (!event.prompt || event.prompt.length < 5) {
        return
      }

      const manager = await getManager()
      const memories = await withTimeout(
        manager.recall(event.prompt, {
          topK: config.topK ?? 10,
          user_id: resolveUserId(ctx, config),
          session_id: ctx?.sessionKey ?? config.sessionId,
        }),
        config.recallTimeout ?? 10_000,
        "memory recall",
      )

      const block = formatMemories(memories)
      if (!block) {
        return
      }

      return { prependSystemContext: block }
    }, undefined)
  }

  async function agentEnd(event: { messages?: unknown }, ctx: RuntimeContext = {}) {
    if (!config.autoCapture) {
      return
    }

    return safeRun({ ...ctx, logger }, "agent_end", async () => {
      const messages = normalizeMessages(event.messages)
      if (!messages.length) {
        return
      }

      const manager = await getManager()
      await withTimeout(
        manager.capture(messages, {
          userId: resolveUserId(ctx, config),
          sessionId: ctx?.sessionKey ?? config.sessionId,
          categories: config.categories,
        }),
        config.captureTimeout ?? 15_000,
        "memory capture",
      )
    }, undefined)
  }

  async function beforeReset(event: SessionMessageEvent, ctx: RuntimeContext = {}) {
    return safeRun({ ...ctx, logger }, "before_reset", async () => {
      const messages = normalizeMessages(event.messages)
      if (!messages.length) {
        return
      }

      await agentEnd({ messages }, ctx)
      if (ctx.sessionKey) {
        processedSessionIds.add(ctx.sessionKey)
      }
    }, undefined)
  }

  async function sessionEnd(event: SessionEndEvent, ctx: RuntimeContext = {}) {
    if (processedSessionIds.has(event.sessionId)) {
      return
    }

    return safeRun({ ...ctx, logger }, "session_end", async () => {
      if (!event.sessionFile) {
        return
      }

      const messages = await loadMessagesFromSessionFile(event.sessionFile)
      if (!messages.length) {
        return
      }

      await agentEnd({ messages }, { ...ctx, sessionKey: event.sessionId })
      processedSessionIds.add(event.sessionId)
    }, undefined)
  }

  async function beforeCompaction(event: SessionMessageEvent, ctx: RuntimeContext = {}) {
    return safeRun({ ...ctx, logger }, "before_compaction", async () => {
      const messages = normalizeMessages(event.messages)
      if (!messages.length) {
        return
      }

      return agentEnd({ messages }, ctx)
    }, undefined)
  }

  return {
    search,
    add,
    remove,
    beforePromptBuild,
    agentEnd,
    beforeReset,
    sessionEnd,
    beforeCompaction,
  }
}

export function createPlugin(dependencies: PluginDependencies = {}) {
  const runtimes = new Map<string, ReturnType<typeof createRuntime>>()

  function getRuntime(context: LegacyHookContext) {
    const config = normalizeConfig(context.config)
    const key = JSON.stringify(config)
    const existing = runtimes.get(key)
    if (existing) {
      return { config, runtime: existing }
    }

    const runtime = createRuntime(config, context.logger, dependencies)
    runtimes.set(key, runtime)
    return { config, runtime }
  }

  return {
    hooks: {
      async before_prompt_build(context: LegacyHookContext) {
        const { runtime } = getRuntime(context)
        const result = await runtime.beforePromptBuild(
          { prompt: context.prompt ?? context.input },
          { logger: context.logger, sessionKey: context.sessionId },
        )
        if (!result?.prependSystemContext) {
          return context
        }

        return {
          ...context,
          prompt: [result.prependSystemContext, context.prompt ?? context.input ?? ""].filter(Boolean).join("\n\n"),
        }
      },
      async after_agent_turn(context: LegacyHookContext) {
        const { config, runtime } = getRuntime(context)
        if (!config.useConversationAccess) {
          return context
        }

        await runtime.agentEnd(
          { messages: context.conversation ?? context.messages ?? [] },
          { logger: context.logger, sessionKey: context.sessionId },
        )
        return context
      },
      async before_reset(context: LegacyHookContext) {
        const { config, runtime } = getRuntime(context)
        if (config.useConversationAccess) {
          return context
        }

        await runtime.beforeReset(
          { messages: context.conversation ?? context.messages ?? [] },
          { logger: context.logger, sessionKey: context.sessionId },
        )
        return context
      },
      async session_end(context: LegacyHookContext & SessionEndEvent) {
        const { config, runtime } = getRuntime(context)
        if (config.useConversationAccess) {
          return context
        }

        await runtime.sessionEnd(
          { sessionFile: context.sessionFile, sessionId: context.sessionId, reason: context.reason },
          { logger: context.logger, sessionKey: context.sessionId },
        )
        return context
      },
      async before_compaction(context: LegacyHookContext & { messageCount?: number }) {
        const { config, runtime } = getRuntime(context)
        if (config.useConversationAccess) {
          return context
        }

        await runtime.beforeCompaction(
          { messages: context.conversation ?? context.messages ?? [] },
          { logger: context.logger, sessionKey: context.sessionId },
        )
        return context
      },
    },
    tools: [
      {
        name: "memory_search",
        async execute(input: ToolInput, context: LegacyHookContext) {
          const { runtime } = getRuntime(context)
          return runtime.search(input, { logger: context.logger, sessionKey: context.sessionId })
        },
      },
      {
        name: "memory_add",
        async execute(input: ToolInput, context: LegacyHookContext) {
          const { runtime } = getRuntime(context)
          return runtime.add(input, { logger: context.logger, sessionKey: context.sessionId })
        },
      },
      {
        name: "memory_delete",
        async execute(input: ToolInput, context: LegacyHookContext) {
          const { runtime } = getRuntime(context)
          return runtime.remove(input, { logger: context.logger, sessionKey: context.sessionId })
        },
      },
    ],
  }
}

export default definePluginEntry({
  id: "clawd-remember",
  name: "clawd-remember",
  description: "Self-hosted memory plugin using Postgres/SQLite + Ollama",
  register(api) {
    const cfg = normalizeConfig(api.pluginConfig as unknown as PluginConfig)
    const logger = api.logger
    const runtime = createRuntime(cfg, logger)

    api.registerTool({
      name: "memory_search",
      description: "Search stored memories",
      parameters: Type.Object({
        query: Type.String({ description: "Search query" }),
        topK: Type.Optional(Type.Number({ description: "Max results" })),
        userId: Type.Optional(Type.String()),
        sessionId: Type.Optional(Type.String()),
        categories: Type.Optional(Type.Array(Type.String())),
      }),
      async execute(_toolCallId: string, input: unknown, _signal?: AbortSignal, _onUpdate?: unknown) {
        return runtime.search((input ?? {}) as ToolInput)
      },
    } as unknown as Parameters<typeof api.registerTool>[0])

    api.registerTool({
      name: "memory_add",
      description: "Add a memory",
      parameters: Type.Object({
        text: Type.String({ description: "Text to store" }),
        userId: Type.Optional(Type.String()),
        sessionId: Type.Optional(Type.String()),
        categories: Type.Optional(Type.Array(Type.String())),
      }),
      async execute(_toolCallId: string, input: unknown, _signal?: AbortSignal, _onUpdate?: unknown) {
        return runtime.add((input ?? {}) as ToolInput)
      },
    } as unknown as Parameters<typeof api.registerTool>[0])

    api.registerTool({
      name: "memory_delete",
      description: "Delete a memory by id",
      parameters: Type.Object({
        id: Type.String({ description: "Memory ID to delete" }),
      }),
      async execute(_toolCallId: string, input: unknown, _signal?: AbortSignal, _onUpdate?: unknown) {
        return runtime.remove((input ?? {}) as ToolInput)
      },
    } as unknown as Parameters<typeof api.registerTool>[0])

    api.on("before_prompt_build", async (event, ctx) => {
      return runtime.beforePromptBuild(event, ctx)
    })

    if (cfg.useConversationAccess) {
      api.on("agent_end", async (event, ctx) => {
        return runtime.agentEnd(event, ctx)
      })
    } else {
      api.on("before_reset", async (event, ctx) => {
        return runtime.beforeReset(event, ctx)
      })

      api.on("session_end", async (event, ctx) => {
        return runtime.sessionEnd(event as SessionEndEvent, ctx)
      })

      api.on("before_compaction", async (event, ctx) => {
        return runtime.beforeCompaction(event, ctx)
      })
    }
  },
})

export * from "./types.js"
export * from "./memory.js"
export * from "./embedders/ollama.js"
export * from "./extractors/openai.js"
