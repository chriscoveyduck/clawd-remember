import { definePluginEntry, type OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry"
import { parseAgentSessionKey } from "openclaw/plugin-sdk/routing"
import os from "node:os"
import path from "node:path"

import { MemoryManager } from "./memory.js"
import { OllamaEmbedder } from "./embedders/ollama.js"
import { OpenAICompatibleExtractor } from "./extractors/openai.js"
import { SqliteStorageProvider } from "./storage/sqlite.js"
import type { Embedder, LLMExtractor, Message, PluginConfig, RecallOptions, StorageProvider } from "./types.js"
import { withTimeout } from "./utils.js"

type LoggerLike = {
  info?: (message: string) => void
  warn?: (message: string) => void
  error?: (message: string) => void
}

type RuntimeContext = {
  logger?: LoggerLike
  sessionKey?: string
  agentId?: string
}

type ToolContext = RuntimeContext

type ToolInput = Record<string, unknown>

type PluginDependencies = {
  createStorageProvider?: (config: PluginConfig) => StorageProvider
  createEmbedder?: (config: PluginConfig) => Embedder
  createExtractor?: (config: PluginConfig) => LLMExtractor
  /** Injectable for testing: override the resolved partition prefix (bypasses instance ID file). */
  devicePrefix?: string
  /** Injectable for testing: override the instance ID file path used by loadInstanceId(). */
  instanceIdPath?: string
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
  agentId?: string
}

/**
 * Load (or generate and persist) the stable instance ID used as the Level 1 partition prefix.
 *
 * Reads from ~/.openclaw/clawd-remember-instance-id (plain text UUID).
 * If the file does not exist, a new UUID v4 is generated, persisted, and used.
 * The file lives outside the plugin install directory so it survives upgrades.
 *
 * @param instanceIdPath - Override path for testing; defaults to ~/.openclaw/clawd-remember-instance-id
 */
export async function loadInstanceId(
  instanceIdPath = path.join(os.homedir(), ".openclaw", "clawd-remember-instance-id"),
): Promise<string> {
  const fs = await import("node:fs/promises")

  try {
    const existing = await fs.readFile(instanceIdPath, "utf-8")
    const id = existing.trim()
    if (id.length >= 1) {
      return id.slice(0, 12)
    }
  } catch {
    // file missing or unreadable — generate a new one
  }

  const { randomUUID } = await import("node:crypto")
  const newId = randomUUID()

  try {
    await fs.mkdir(path.dirname(instanceIdPath), { recursive: true })
    await fs.writeFile(instanceIdPath, newId, "utf-8")
  } catch {
    // If we cannot persist, still use the generated ID for this session
  }

  return newId.slice(0, 12)
}

/**
 * Resolve a two-level partition key for memory storage.
 *
 * Level 1 (gateway identity): deviceId prefix — stable per deployment.
 * Level 2 (agent identity): agentId parsed from session key, or config.userId override, or "default".
 *
 * Format: `{devicePrefix}:{agentId}`  e.g. `abb67c9c0911:main`
 *
 * config.userId, when set, overrides the parsed agentId only (Level 2).
 * This lets a cron agent explicitly read from main's memory pool.
 *
 * For tool calls that accept an explicit userId input parameter, that full override
 * is returned as-is (preserving original behaviour for explicit overrides).
 */
function resolvePartitionKey(
  devicePrefix: string,
  context: RuntimeContext | undefined,
  config: PluginConfig,
  agentId?: string,
): string {
  const resolvedAgentId = config.userId ?? agentId ?? context?.agentId ?? parseAgentSessionKey(context?.sessionKey)?.agentId ?? "default"
  return `${devicePrefix}:${resolvedAgentId}`
}

async function createManager(
  config: PluginConfig,
  logger?: LoggerLike,
  dependencies: PluginDependencies = {},
): Promise<MemoryManager> {
  const storage = (dependencies.createStorageProvider ?? createStorageProvider)(config)
  const embedder = (dependencies.createEmbedder ?? ((currentConfig) => new OllamaEmbedder(currentConfig.embedder.config)))(config)
  const extractor = (dependencies.createExtractor ?? ((currentConfig) => {
    if (currentConfig.llm.provider !== "openai-compatible") {
      throw new Error(`Unsupported LLM provider for extraction: ${currentConfig.llm.provider}`)
    }
    return new OpenAICompatibleExtractor(currentConfig.llm.config)
  }))(config)
  const manager = new MemoryManager(storage, embedder, extractor, {
    userId: config.userId ?? "default",
    sessionId: config.sessionId,
    categories: config.categories,
    topK: config.topK,
  })
  try {
    await manager.init()
  } catch (error) {
    const wrapped = new Error(
      `[clawd-remember] manager init failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error instanceof Error ? error : undefined },
    )
    logger?.error?.(wrapped.message)
    throw wrapped
  }
  return manager
}

function createStorageProvider(config: PluginConfig): SqliteStorageProvider {
  if (config.storage.provider === "sqlite") {
    return new SqliteStorageProvider(config.storage.config)
  }

  throw new Error(`Storage provider ${config.storage.provider} is not implemented yet`)
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

function resolveLegacyUserId(context: LegacyHookContext, config: PluginConfig, override?: unknown): string {
  if (typeof override === "string" && override.trim()) {
    return override
  }

  return context.userId ?? context.agentId ?? config.userId ?? "default"
}

function normalizeConfig(config?: PluginConfig): PluginConfig {
  const storage = config?.storage?.provider === "mariadb"
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
        baseURL: (config?.llm?.provider === "openai-compatible" ? config.llm.config.baseURL : undefined) ?? "http://localhost:4141/v1",
        model: config?.llm?.config?.model ?? "gpt-4o-mini",
        apiKey: (config?.llm?.provider === "openai-compatible" ? config.llm.config.apiKey : undefined) ?? "dummy",
        timeoutMs: config?.llm?.config?.timeoutMs,
      },
    },
    // userId is now optional — omit from defaults so partition key derives it from the session key
    userId: config?.userId,
    sessionId: config?.sessionId,
    autoRecall: config?.autoRecall ?? true,
    autoCapture: config?.autoCapture ?? true,
    topK: config?.topK ?? 10,
    recallTimeout: config?.recallTimeout ?? 10_000,
    captureTimeout: config?.captureTimeout ?? 15_000,
    categories: config?.categories,
    useConversationAccess: config?.useConversationAccess ?? false,
  }
}

export const configSchema = {
  type: "object",
  required: ["storage", "embedder", "llm"],
  properties: {
    storage: {
      type: "object",
      required: ["provider", "config"],
      properties: {
        provider: { type: "string", enum: ["sqlite", "mariadb"] },
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

  // Load device prefix once at startup. Cached as a promise so all callers await the same result.
  const devicePrefixPromise: Promise<string> = dependencies.devicePrefix !== undefined
    ? Promise.resolve(dependencies.devicePrefix)
    : loadInstanceId(dependencies.instanceIdPath)

  function getManager(): Promise<MemoryManager> {
    if (!managerPromise) {
      managerPromise = createManager(config, logger, dependencies)
    }
    return managerPromise
  }

  async function search(input: ToolInput, ctx: ToolContext = {}) {
    const devicePrefix = await devicePrefixPromise
    return safeRun({ ...ctx, logger }, "memory_search tool", async () => {
      const manager = await getManager()
      // Honour explicit userId override as the full key
      const userId = typeof input.userId === "string" && input.userId.trim()
        ? input.userId
        : resolvePartitionKey(devicePrefix, ctx, config)
      return manager.search(String(input.query ?? ""), {
        topK: typeof input.topK === "number" ? input.topK : config.topK,
        user_id: userId,
        session_id: typeof input.sessionId === "string" ? input.sessionId : ctx?.sessionKey ?? config.sessionId,
        categories: Array.isArray(input.categories)
          ? input.categories.filter((item): item is string => typeof item === "string")
          : undefined,
      } satisfies RecallOptions)
    }, [])
  }

  async function add(input: ToolInput, ctx: ToolContext = {}) {
    const devicePrefix = await devicePrefixPromise
    return safeRun({ ...ctx, logger }, "memory_add tool", async () => {
      const manager = await getManager()
      const userId = typeof input.userId === "string" && input.userId.trim()
        ? input.userId
        : resolvePartitionKey(devicePrefix, ctx, config)
      return manager.add(
        String(input.text ?? ""),
        userId,
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

  async function list(input: ToolInput, ctx: ToolContext = {}) {
    const devicePrefix = await devicePrefixPromise
    return safeRun({ ...ctx, logger }, "memory_list tool", async () => {
      const manager = await getManager()
      const userId = typeof input.userId === "string" && input.userId.trim()
        ? input.userId
        : resolvePartitionKey(devicePrefix, ctx, config)
      return manager.list({
        user_id: userId,
        session_id: typeof input.sessionId === "string" ? input.sessionId : ctx?.sessionKey ?? config.sessionId,
        categories: Array.isArray(input.categories)
          ? input.categories.filter((item): item is string => typeof item === "string")
          : undefined,
      }, typeof input.topK === "number" ? input.topK : config.topK)
    }, [])
  }

  async function beforePromptBuild(event: { prompt?: string }, ctx: RuntimeContext = {}) {
    if (!config.autoRecall) {
      return
    }

    const devicePrefix = await devicePrefixPromise
    return safeRun({ ...ctx, logger }, "before_prompt_build", async () => {
      if (!event.prompt || event.prompt.length < 5) {
        return
      }

      const manager = await getManager()
      const memories = await withTimeout(
        manager.recall(event.prompt, {
          topK: config.topK ?? 10,
          user_id: resolvePartitionKey(devicePrefix, ctx, config),
          session_id: ctx?.sessionKey ?? config.sessionId,
        }),
        config.recallTimeout ?? 10_000,
        "memory recall",
      )

      const block = formatMemories(memories)
      if (!block) {
        return
      }

      logger?.info?.(`[clawd-remember] recalled ${memories.length} memories for prompt`)

      return { prependContext: block }
    }, undefined)
  }

  async function agentEnd(event: { messages?: unknown, success?: boolean }, ctx: RuntimeContext = {}) {
    if (!config.autoCapture) {
      return
    }

    if (event.success === false) {
      return
    }

    const devicePrefix = await devicePrefixPromise
    return safeRun({ ...ctx, logger }, "agent_end", async () => {
      const messages = normalizeMessages(event.messages)
      if (!messages.length) {
        return
      }

      const manager = await getManager()
      const partitionKey = resolvePartitionKey(devicePrefix, ctx, config)
      const facts = await withTimeout(
        manager.capture(messages, {
          userId: partitionKey,
          sessionId: ctx?.sessionKey ?? config.sessionId,
          categories: config.categories,
        }),
        config.captureTimeout ?? 15_000,
        "memory capture",
      )
      logger?.info?.(`[clawd-remember] captured ${facts.length} facts for user ${partitionKey}`)
    }, undefined)
  }

  async function beforeReset(event: { messages?: unknown; sessionFile?: string }, ctx: RuntimeContext = {}) {
    if (!config.autoCapture) return
    const devicePrefix = await devicePrefixPromise
    return safeRun({ ...ctx, logger }, "before_reset", async () => {
      const messages = normalizeMessages(event.messages)
      if (!messages.length) return
      const sessionKey = ctx.sessionKey ?? ""
      if (sessionKey) processedSessionIds.add(sessionKey)
      const manager = await getManager()
      const facts = await withTimeout(
        manager.capture(messages, {
          userId: resolvePartitionKey(devicePrefix, ctx, config),
          sessionId: sessionKey || config.sessionId,
          categories: config.categories,
        }),
        config.captureTimeout ?? 15_000,
        "memory capture (before_reset)",
      )
      logger?.info?.(`[clawd-remember] before_reset: captured ${facts.length} facts`)
    }, undefined)
  }

  async function sessionEnd(event: { sessionFile?: string; sessionId: string; reason?: string }, ctx: RuntimeContext = {}) {
    if (!config.autoCapture) return
    if (processedSessionIds.has(event.sessionId)) return
    const devicePrefix = await devicePrefixPromise
    return safeRun({ ...ctx, logger }, "session_end", async () => {
      if (!event.sessionFile) return
      const fs = await import("node:fs/promises")
      let raw: string
      try {
        raw = await fs.readFile(event.sessionFile, "utf-8")
      } catch {
        return
      }
      const messages: Message[] = []
      for (const line of raw.trim().split("\n")) {
        try {
          const entry = JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown } }
          if (entry.type === "message" && entry.message) {
            const { role, content } = entry.message
            if ((role === "user" || role === "assistant") && typeof content === "string" && content.trim()) {
              messages.push({ role, content })
            }
          }
        } catch { /* skip malformed lines */ }
      }
      if (!messages.length) return
      processedSessionIds.add(event.sessionId)
      const manager = await getManager()
      const facts = await withTimeout(
        manager.capture(messages, {
          userId: resolvePartitionKey(devicePrefix, ctx, config),
          sessionId: ctx.sessionKey ?? config.sessionId,
          categories: config.categories,
        }),
        config.captureTimeout ?? 15_000,
        "memory capture (session_end)",
      )
      logger?.info?.(`[clawd-remember] session_end (${event.reason ?? "unknown"}): captured ${facts.length} facts`)
    }, undefined)
  }

  async function beforeCompaction(event: { messages?: unknown; sessionFile?: string }, ctx: RuntimeContext = {}) {
    if (!config.autoCapture) return
    const devicePrefix = await devicePrefixPromise
    return safeRun({ ...ctx, logger }, "before_compaction", async () => {
      const messages = normalizeMessages(event.messages)
      if (!messages.length) return
      const manager = await getManager()
      const facts = await withTimeout(
        manager.capture(messages, {
          userId: resolvePartitionKey(devicePrefix, ctx, config),
          sessionId: ctx.sessionKey ?? config.sessionId,
          categories: config.categories,
        }),
        config.captureTimeout ?? 15_000,
        "memory capture (before_compaction)",
      )
      logger?.info?.(`[clawd-remember] before_compaction: captured ${facts.length} facts`)
    }, undefined)
  }

  return {
    search,
    add,
    remove,
    list,
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
          { logger: context.logger, sessionKey: context.sessionId, agentId: context.agentId },
        )
        if (!result?.prependContext) {
          return context
        }

        return {
          ...context,
          prompt: [result.prependContext, context.prompt ?? context.input ?? ""].filter(Boolean).join("\n\n"),
        }
      },
      async after_agent_turn(context: LegacyHookContext) {
        const { runtime } = getRuntime(context)
        await runtime.agentEnd(
          { messages: context.conversation ?? context.messages ?? [], success: (context as { success?: boolean }).success },
          { logger: context.logger, sessionKey: context.sessionId, agentId: context.agentId },
        )
        return context
      },
    },
    tools: [
      {
        name: "memory_search",
        async execute(input: ToolInput, context: LegacyHookContext) {
          const { runtime } = getRuntime(context)
          return runtime.search(input, { logger: context.logger, sessionKey: context.sessionId, agentId: context.agentId })
        },
      },
      {
        name: "memory_add",
        async execute(input: ToolInput, context: LegacyHookContext) {
          const { runtime } = getRuntime(context)
          return runtime.add(input, { logger: context.logger, sessionKey: context.sessionId, agentId: context.agentId })
        },
      },
      {
        name: "memory_delete",
        async execute(input: ToolInput, context: LegacyHookContext) {
          const { runtime } = getRuntime(context)
          return runtime.remove(input, { logger: context.logger, sessionKey: context.sessionId, agentId: context.agentId })
        },
      },
      {
        name: "memory_list",
        async execute(input: ToolInput, context: LegacyHookContext) {
          const { runtime } = getRuntime(context)
          return runtime.list(input, { logger: context.logger, sessionKey: context.sessionId, agentId: context.agentId })
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
      parameters: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string" },
          topK: { type: "number" },
          userId: { type: "string" },
          sessionId: { type: "string" },
          categories: { type: "array", items: { type: "string" } },
        },
      },
      async execute(_toolCallId: string, input: unknown, _signal?: AbortSignal, _onUpdate?: unknown, context?: OpenClawPluginToolContext) {
        return runtime.search((input ?? {}) as ToolInput, { logger, sessionKey: context?.sessionKey, agentId: context?.agentId })
      },
    } as unknown as Parameters<typeof api.registerTool>[0])

    api.registerTool({
      name: "memory_add",
      description: "Add a memory",
      parameters: {
        type: "object",
        required: ["text"],
        properties: {
          text: { type: "string" },
          userId: { type: "string" },
          sessionId: { type: "string" },
          categories: { type: "array", items: { type: "string" } },
        },
      },
      async execute(_toolCallId: string, input: unknown, _signal?: AbortSignal, _onUpdate?: unknown, context?: OpenClawPluginToolContext) {
        return runtime.add((input ?? {}) as ToolInput, { logger, sessionKey: context?.sessionKey, agentId: context?.agentId })
      },
    } as unknown as Parameters<typeof api.registerTool>[0])

    api.registerTool({
      name: "memory_delete",
      description: "Delete a memory by id",
      parameters: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string" },
        },
      },
      async execute(_toolCallId: string, input: unknown, _signal?: AbortSignal, _onUpdate?: unknown, context?: OpenClawPluginToolContext) {
        return runtime.remove((input ?? {}) as ToolInput, { logger, sessionKey: context?.sessionKey, agentId: context?.agentId })
      },
    } as unknown as Parameters<typeof api.registerTool>[0])

    api.registerTool({
      name: "memory_list",
      description: "List stored memories",
      parameters: {
        type: "object",
        properties: {
          topK: { type: "number" },
          userId: { type: "string" },
          sessionId: { type: "string" },
          categories: { type: "array", items: { type: "string" } },
        },
      },
      async execute(_toolCallId: string, input: unknown, _signal?: AbortSignal, _onUpdate?: unknown, context?: OpenClawPluginToolContext) {
        return runtime.list((input ?? {}) as ToolInput, { logger, sessionKey: context?.sessionKey, agentId: context?.agentId })
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
        return runtime.beforeReset(event as { messages?: unknown; sessionFile?: string }, ctx)
      })
      api.on("session_end", async (event, ctx) => {
        return runtime.sessionEnd(event as { sessionFile?: string; sessionId: string; reason?: string }, ctx)
      })
      api.on("before_compaction", async (event, ctx) => {
        return runtime.beforeCompaction(event as { messages?: unknown; sessionFile?: string }, ctx)
      })
    }
  },
})

export * from "./types.js"
export * from "./memory.js"
export * from "./storage/sqlite.js"
export * from "./embedders/ollama.js"
export * from "./extractors/openai.js"
