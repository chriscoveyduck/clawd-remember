import { definePluginEntry, type OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry"
import { parseAgentSessionKey } from "openclaw/plugin-sdk/routing"
import os from "node:os"
import path from "node:path"

import { MemoryManager } from "./memory.js"
import { OllamaEmbedder } from "./embedders/ollama.js"
import { OpenAIEmbedder } from "./embedders/openai.js"
import { OpenAICompatibleExtractor } from "./extractors/openai.js"
import { SqliteStorageProvider } from "./storage/sqlite.js"
import type {
  CaptureOptions,
  Embedder,
  LLMExtractor,
  Message,
  PluginConfig,
  RecallOptions,
  StorageProvider,
} from "./types.js"
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
  storage?: StorageProvider,
): Promise<MemoryManager> {
  const resolvedStorage = storage ?? (dependencies.createStorageProvider ?? createStorageProvider)(config)
  const embedder = (dependencies.createEmbedder ?? createEmbedder)(config)
  const extractor = (dependencies.createExtractor ?? ((currentConfig) => {
    if (currentConfig.llm.provider !== "openai-compatible") {
      throw new Error(`Unsupported LLM provider for extraction: ${currentConfig.llm.provider}`)
    }
    return new OpenAICompatibleExtractor(currentConfig.llm.config)
  }))(config)
  const manager = new MemoryManager(resolvedStorage, embedder, extractor, {
    userId: config.userId ?? "default",
    sessionId: config.sessionId,
    categories: config.categories,
    topK: config.topK,
    deduplicationThreshold: config.deduplicationThreshold,
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

export async function captureInChunks(
  manager: Pick<MemoryManager, "capture">,
  messages: Message[],
  options: CaptureOptions,
  chunkSize = 20,
  onChunkSuccess?: (chunk: Message[], chunkFactsCaptured: number) => Promise<void> | void,
): Promise<number> {
  const normalizedChunkSize = Math.max(1, Math.floor(chunkSize))
  let totalCaptured = 0

  for (let start = 0; start < messages.length; start += normalizedChunkSize) {
    const chunk = messages.slice(start, start + normalizedChunkSize)
    const facts = await manager.capture(chunk, options)
    totalCaptured += facts.length
    await onChunkSuccess?.(chunk, facts.length)
  }

  return totalCaptured
}

function createStorageProvider(config: PluginConfig): SqliteStorageProvider {
  if (config.storage.provider === "sqlite") {
    return new SqliteStorageProvider(config.storage.config)
  }

  throw new Error(`Storage provider ${config.storage.provider} is not implemented yet`)
}

function createEmbedder(config: PluginConfig): Embedder {
  if (config.embedder.provider === "openai") {
    return new OpenAIEmbedder(config.embedder.config)
  }
  // Default: ollama
  return new OllamaEmbedder(config.embedder.config as Parameters<typeof OllamaEmbedder.prototype.embed>[never] extends never ? never : ConstructorParameters<typeof OllamaEmbedder>[0])
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

function filterExtractableMessages(messages: Message[]): Message[] {
  return messages.filter((message) => message.role !== "toolResult" && message.role !== "tool")
}

function resolveLegacyUserId(context: LegacyHookContext, config: PluginConfig, override?: unknown): string {
  if (typeof override === "string" && override.trim()) {
    return override
  }

  return context.userId ?? context.agentId ?? config.userId ?? "default"
}

function normalizeConfig(config?: PluginConfig): PluginConfig {
  // Normalize storage — only sqlite is supported
  const storage = {
    provider: "sqlite" as const,
    config: config?.storage?.provider === "sqlite"
      ? config.storage.config
      : { path: "~/.openclaw/clawd-remember.db" },
  }

  // Normalize embedder — support ollama and openai
  let embedder: PluginConfig["embedder"]
  if (config?.embedder?.provider === "openai") {
    embedder = {
      provider: "openai",
      config: {
        baseURL: config.embedder.config.baseURL ?? "https://api.openai.com/v1",
        model: config.embedder.config.model ?? "text-embedding-3-small",
        apiKey: config.embedder.config.apiKey ?? "dummy",
        timeoutMs: config.embedder.config.timeoutMs,
      },
    }
  } else {
    embedder = {
      provider: "ollama",
      config: {
        url: config?.embedder?.config?.url ?? "http://localhost:11434",
        model: (config?.embedder?.provider === "ollama" ? config.embedder.config.model : undefined) ?? "nomic-embed-text",
        timeoutMs: config?.embedder?.config?.timeoutMs,
      },
    }
  }

  return {
    storage,
    embedder,
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
    deduplicationThreshold: config?.deduplicationThreshold,
    recallTimeout: config?.recallTimeout ?? 10_000,
    captureTimeout: config?.captureTimeout ?? 45_000,
    chunkSize: config?.chunkSize ?? 20,
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
        provider: { type: "string", enum: ["sqlite"] },
        config: {
          type: "object",
          properties: {
            path: { type: "string" },
            dimensions: { type: "number" },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    embedder: {
      type: "object",
      required: ["provider", "config"],
      properties: {
        provider: { type: "string", enum: ["ollama", "openai"] },
        config: {
          type: "object",
          properties: {
            url: { type: "string" },
            model: { type: "string" },
            timeoutMs: { type: "number" },
            baseURL: { type: "string" },
            apiKey: { type: "string" },
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
    deduplicationThreshold: { type: "number" },
    recallTimeout: { type: "number" },
    captureTimeout: { type: "number" },
    chunkSize: { type: "number" },
    categories: {
      type: "array",
      items: { type: "string" },
    },
  },
  additionalProperties: false,
} as const

function createRuntime(config: PluginConfig, logger: LoggerLike | undefined, dependencies: PluginDependencies = {}) {
  let managerPromise: Promise<MemoryManager> | null = null
  let storagePromise: Promise<StorageProvider> | null = null
  const compactionPending = new Set<string>()

  // Load device prefix once at startup. Cached as a promise so all callers await the same result.
  const devicePrefixPromise: Promise<string> = dependencies.devicePrefix !== undefined
    ? Promise.resolve(dependencies.devicePrefix)
    : loadInstanceId(dependencies.instanceIdPath)

  function getManager(): Promise<MemoryManager> {
    if (!managerPromise) {
      managerPromise = (async () => createManager(config, logger, dependencies, await getStorage()))()
    }
    return managerPromise
  }

  function getStorage(): Promise<StorageProvider> {
    if (!storagePromise) {
      storagePromise = Promise.resolve((dependencies.createStorageProvider ?? createStorageProvider)(config))
    }
    return storagePromise
  }

  function resolveSessionKey(ctx: RuntimeContext, fallback?: string): string | undefined {
    return ctx.sessionKey ?? fallback ?? config.sessionId
  }

  async function captureSessionDelta(
    scope: string,
    messages: Message[],
    ctx: RuntimeContext,
    options: { markCompleted?: boolean; forceWatermarkToLength?: boolean } = {},
  ): Promise<number | undefined> {
    if (!messages.length) {
      return 0
    }

    const sessionKey = resolveSessionKey(ctx)
    const storage = await getStorage()
    const state = sessionKey ? await storage.getSessionState(sessionKey) : null
    if (state?.completedAt) {
      return 0
    }

    const watermark = Math.min(state?.watermark ?? 0, messages.length)
    const delta = messages.slice(watermark)
    if (!delta.length) {
      if (options.forceWatermarkToLength && sessionKey) {
        await storage.upsertWatermark(sessionKey, messages.length)
      }
      if (options.markCompleted && sessionKey) {
        await storage.markCompleted(sessionKey)
      }
      return 0
    }

    const manager = await getManager()
    const devicePrefix = await devicePrefixPromise
    const partitionKey = resolvePartitionKey(devicePrefix, ctx, config)
    let nextWatermark = watermark
    const normalizedChunkSize = Math.max(1, Math.floor(config.chunkSize ?? 20))
    const totalFacts = await withTimeout(
      (async () => {
        let capturedFacts = 0

        for (let start = 0; start < delta.length; start += normalizedChunkSize) {
          const chunk = delta.slice(start, start + normalizedChunkSize)
          // Filter out tool results; they are large and contain no useful memory signal.
          const filterable = filterExtractableMessages(chunk)

          if (filterable.length) {
            capturedFacts += await captureInChunks(
              manager,
              filterable,
              {
                userId: partitionKey,
                sessionId: sessionKey,
                categories: config.categories,
              },
              normalizedChunkSize,
            )
          }

          nextWatermark += chunk.length
          if (sessionKey) {
            await storage.upsertWatermark(sessionKey, nextWatermark)
          }
        }

        return capturedFacts
      })(),
      config.captureTimeout ?? 45_000,
      scope,
    )

    if (options.forceWatermarkToLength && sessionKey && nextWatermark !== messages.length) {
      await storage.upsertWatermark(sessionKey, messages.length)
    }

    if (options.markCompleted && sessionKey) {
      await storage.markCompleted(sessionKey)
    }

    logger?.info?.(`[clawd-remember] ${scope}: captured ${totalFacts} facts for user ${partitionKey}`)
    return totalFacts
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

    return safeRun({ ...ctx, logger }, "agent_end", async () => {
      const messages = normalizeMessages(event.messages)
      await captureSessionDelta("agent_end", messages, ctx)
    }, undefined)
  }

  async function beforeReset(event: { messages?: unknown; sessionFile?: string }, ctx: RuntimeContext = {}) {
    if (!config.autoCapture) return
    return safeRun({ ...ctx, logger }, "before_reset", async () => {
      const messages = normalizeMessages(event.messages)
      await captureSessionDelta("before_reset", messages, ctx, { markCompleted: true })
    }, undefined)
  }

  async function sessionEnd(event: { sessionFile?: string; sessionId: string; reason?: string }, ctx: RuntimeContext = {}) {
    if (!config.autoCapture) return
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
      const sessionKey = resolveSessionKey(ctx, event.sessionId)
      const partitionKey = resolvePartitionKey(devicePrefix, ctx, config)
      const totalFacts = await captureSessionDelta(
        `session_end (${event.reason ?? "unknown"})`,
        messages,
        { ...ctx, sessionKey },
        { markCompleted: true },
      )
      if (typeof totalFacts === "number") {
        logger?.info?.(`[clawd-remember] session_end (${event.reason ?? "unknown"}): captured ${totalFacts} facts for user ${partitionKey}`)
      }
    }, undefined)
  }

  async function beforeCompaction(event: { messages?: unknown; sessionFile?: string }, ctx: RuntimeContext = {}) {
    if (!config.autoCapture) return
    const devicePrefix = await devicePrefixPromise
    return safeRun({ ...ctx, logger }, "before_compaction", async () => {
      const messages = normalizeMessages(event.messages)
      if (!messages.length) return
      const sessionKey = resolveSessionKey(ctx)
      const partitionKey = resolvePartitionKey(devicePrefix, ctx, config)
      const totalFacts = await captureSessionDelta("before_compaction", messages, ctx, { forceWatermarkToLength: true })
      if (sessionKey) {
        compactionPending.add(sessionKey)
      }
      if (typeof totalFacts === "number") {
        logger?.info?.(`[clawd-remember] before_compaction: captured ${totalFacts} facts for user ${partitionKey}`)
      }
    }, undefined)
  }

  async function afterCompaction(_event: Record<string, never>, ctx: RuntimeContext = {}) {
    const sessionKey = resolveSessionKey(ctx)
    if (!sessionKey || !compactionPending.has(sessionKey)) {
      return
    }

    return safeRun({ ...ctx, logger }, "after_compaction", async () => {
      const storage = await getStorage()
      await storage.upsertWatermark(sessionKey, 0)
      compactionPending.delete(sessionKey)
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
    afterCompaction,
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
      async before_reset(context: LegacyHookContext) {
        const { runtime } = getRuntime(context)
        await runtime.beforeReset(
          { messages: context.conversation ?? context.messages ?? [] },
          { logger: context.logger, sessionKey: context.sessionId, agentId: context.agentId },
        )
        return context
      },
      async session_end(context: LegacyHookContext & { sessionFile?: string; reason?: string }) {
        const { runtime } = getRuntime(context)
        await runtime.sessionEnd(
          { sessionFile: context.sessionFile, sessionId: context.sessionId ?? "", reason: context.reason },
          { logger: context.logger, sessionKey: context.sessionId, agentId: context.agentId },
        )
        return context
      },
      async before_compaction(context: LegacyHookContext) {
        const { runtime } = getRuntime(context)
        await runtime.beforeCompaction(
          { messages: context.conversation ?? context.messages ?? [] },
          { logger: context.logger, sessionKey: context.sessionId, agentId: context.agentId },
        )
        return context
      },
      async after_compaction(context: LegacyHookContext) {
        const { runtime } = getRuntime(context)
        await runtime.afterCompaction({}, { logger: context.logger, sessionKey: context.sessionId, agentId: context.agentId })
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
  description: "Self-hosted memory plugin using SQLite + Ollama or OpenAI embeddings",
  register(api) {
    const cfg = normalizeConfig(api.pluginConfig as unknown as PluginConfig)
    const logger = api.logger
    const runtime = createRuntime(cfg, logger)

    api.registerTool(((ctx: OpenClawPluginToolContext) => ({
      name: "memory_search",
      label: "Search memories",
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
      async execute(_toolCallId: string, input: unknown) {
        return runtime.search((input ?? {}) as ToolInput, { logger, sessionKey: ctx.sessionKey, agentId: ctx.agentId })
      },
    })) as unknown as Parameters<typeof api.registerTool>[0])

    api.registerTool(((ctx: OpenClawPluginToolContext) => ({
      name: "memory_add",
      label: "Add memory",
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
      async execute(_toolCallId: string, input: unknown) {
        return runtime.add((input ?? {}) as ToolInput, { logger, sessionKey: ctx.sessionKey, agentId: ctx.agentId })
      },
    })) as unknown as Parameters<typeof api.registerTool>[0])

    api.registerTool(((ctx: OpenClawPluginToolContext) => ({
      name: "memory_delete",
      label: "Delete memory",
      description: "Delete a memory by id",
      parameters: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string" },
        },
      },
      async execute(_toolCallId: string, input: unknown) {
        return runtime.remove((input ?? {}) as ToolInput, { logger, sessionKey: ctx.sessionKey, agentId: ctx.agentId })
      },
    })) as unknown as Parameters<typeof api.registerTool>[0])

    api.registerTool(((ctx: OpenClawPluginToolContext) => ({
      name: "memory_list",
      label: "List memories",
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
      async execute(_toolCallId: string, input: unknown) {
        return runtime.list((input ?? {}) as ToolInput, { logger, sessionKey: ctx.sessionKey, agentId: ctx.agentId })
      },
    })) as unknown as Parameters<typeof api.registerTool>[0])

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
      api.on("after_compaction", async (_event, ctx) => {
        return runtime.afterCompaction({}, ctx)
      })
    }
  },
})

export * from "./types.js"
export * from "./memory.js"
export * from "./storage/sqlite.js"
export * from "./embedders/ollama.js"
export * from "./embedders/openai.js"
export * from "./extractors/openai.js"
