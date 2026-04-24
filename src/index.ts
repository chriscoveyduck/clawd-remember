import { MemoryManager } from "./memory.js"
import { OllamaEmbedder } from "./embedders/ollama.js"
import { OpenAICompatibleExtractor } from "./extractors/openai.js"
import { SqliteStorageProvider } from "./storage/sqlite.js"
import type { Embedder, LLMExtractor, Message, PluginConfig, RecallOptions, StorageProvider } from "./types.js"
import { withTimeout } from "./utils.js"

type HookContext = {
  config?: PluginConfig
  logger?: {
    warn?: (...args: unknown[]) => void
  }
  state?: Record<string, unknown>
  input?: string
  prompt?: string
  messages?: Message[]
  conversation?: Message[]
  userId?: string
  sessionId?: string
}

type ToolContext = HookContext

type PluginTool = {
  name: string
  description: string
  input_schema: Record<string, unknown>
  execute: (input: Record<string, unknown>, context: ToolContext) => Promise<unknown>
}

type PluginEntry = {
  name: string
  slot: "memory"
  configSchema: Record<string, unknown>
  hooks: {
    before_prompt_build: (context: HookContext) => Promise<HookContext>
    after_agent_turn: (context: HookContext) => Promise<HookContext>
  }
  tools: PluginTool[]
}

type PluginDependencies = {
  createStorageProvider?: (config: PluginConfig) => StorageProvider
  createEmbedder?: (config: PluginConfig) => Embedder
  createExtractor?: (config: PluginConfig) => LLMExtractor
}

type DefinePluginEntry = <T>(entry: T) => T

let definePluginEntry: DefinePluginEntry = <T>(entry: T) => entry
try {
  const openclaw = await import("openclaw")
  if (typeof (openclaw as { definePluginEntry?: unknown }).definePluginEntry === "function") {
    definePluginEntry = openclaw.definePluginEntry as DefinePluginEntry
  }
} catch {
  // Build and test without the OpenClaw runtime installed.
}

const managers = new Map<string, Promise<MemoryManager>>()

async function getManager(context: HookContext, dependencies: PluginDependencies = {}): Promise<MemoryManager> {
  const config = normalizeConfig(context.config)
  const key = JSON.stringify(config)
  const existing = managers.get(key)
  if (existing) {
    return existing
  }

  const managerPromise = createManager(config, dependencies)
  managers.set(key, managerPromise)
  return managerPromise
}

async function createManager(config: PluginConfig, dependencies: PluginDependencies = {}): Promise<MemoryManager> {
  const storage = (dependencies.createStorageProvider ?? createStorageProvider)(config)
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

function createStorageProvider(config: PluginConfig): SqliteStorageProvider {
  if (config.storage.provider === "sqlite") {
    return new SqliteStorageProvider(config.storage.config)
  }

  throw new Error(`Storage provider ${config.storage.provider} is not implemented yet`)
}

function warn(context: HookContext, scope: string, error: unknown): void {
  const logger = context.logger
  const message = error instanceof Error ? error.message : String(error)
  logger?.warn?.(`[clawd-remember] ${scope}: ${message}`)
}

async function safeRun<T>(context: HookContext, scope: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    warn(context, scope, error)
    return fallback
  }
}

function getConversation(context: HookContext): Message[] {
  return context.conversation ?? context.messages ?? []
}

function getPromptText(context: HookContext): string {
  return context.prompt ?? context.input ?? ""
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
    topK: config?.topK ?? 10,
    recallTimeout: config?.recallTimeout ?? 10_000,
    captureTimeout: config?.captureTimeout ?? 15_000,
    categories: config?.categories,
  }
}

function createBeforePromptBuild(dependencies: PluginDependencies = {}) {
  return async function handleRecall(context: HookContext): Promise<HookContext> {
  const config = normalizeConfig(context.config)
  if (!config.autoRecall) {
    return context
  }

  return safeRun(context, "before_prompt_build", async () => {
    const prompt = getPromptText(context)
    if (!prompt.trim()) {
      return context
    }

    const manager = await getManager({ ...context, config }, dependencies)
    const memories = await withTimeout(
      manager.recall(prompt, {
        topK: config.topK,
        user_id: context.userId ?? config.userId,
        session_id: context.sessionId ?? config.sessionId,
      }),
      config.recallTimeout ?? 10_000,
      "memory recall",
    )

    const memoryBlock = formatMemories(memories)
    if (!memoryBlock) {
      return context
    }

    return {
      ...context,
      prompt: [memoryBlock, getPromptText(context)].filter(Boolean).join("\n\n"),
      state: {
        ...context.state,
        clawdRememberRecall: memories,
      },
    }
  }, context)
}
}

function createAfterAgentTurn(dependencies: PluginDependencies = {}) {
  return async function handleCapture(context: HookContext): Promise<HookContext> {
  const config = normalizeConfig(context.config)
  if (!config.autoCapture) {
    return context
  }

  return safeRun(context, "after_agent_turn", async () => {
    const conversation = getConversation(context)
    if (!conversation.length) {
      return context
    }

    const manager = await getManager({ ...context, config }, dependencies)
    await withTimeout(
      manager.capture(conversation, {
        userId: context.userId ?? config.userId,
        sessionId: context.sessionId ?? config.sessionId,
        categories: config.categories,
      }),
      config.captureTimeout ?? 15_000,
      "memory capture",
    )
    return context
  }, context)
}
}

function createSearchTool(dependencies: PluginDependencies = {}) {
  return async function runSearchTool(input: Record<string, unknown>, context: ToolContext): Promise<unknown> {
  const config = normalizeConfig(context.config)
  return safeRun(context, "memory_search tool", async () => {
    const manager = await getManager({ ...context, config }, dependencies)
    return manager.search(String(input.query ?? ""), {
      topK: typeof input.topK === "number" ? input.topK : config.topK,
      user_id: String(input.userId ?? context.userId ?? config.userId),
      session_id: typeof input.sessionId === "string" ? input.sessionId : context.sessionId ?? config.sessionId,
      categories: Array.isArray(input.categories)
        ? input.categories.filter((item): item is string => typeof item === "string")
        : undefined,
    } satisfies RecallOptions)
  }, [])
}
}

function createAddTool(dependencies: PluginDependencies = {}) {
  return async function runAddTool(input: Record<string, unknown>, context: ToolContext): Promise<unknown> {
  const config = normalizeConfig(context.config)
  return safeRun(context, "memory_add tool", async () => {
    const manager = await getManager({ ...context, config }, dependencies)
    return manager.add(
      String(input.text ?? ""),
      String(input.userId ?? context.userId ?? config.userId),
      typeof input.sessionId === "string" ? input.sessionId : context.sessionId ?? config.sessionId,
      Array.isArray(input.categories)
        ? input.categories.filter((item): item is string => typeof item === "string")
        : config.categories,
    )
  }, null)
}
}

function createDeleteTool(dependencies: PluginDependencies = {}) {
  return async function runDeleteTool(input: Record<string, unknown>, context: ToolContext): Promise<unknown> {
  return safeRun(context, "memory_delete tool", async () => {
    const manager = await getManager(context, dependencies)
    await manager.delete(String(input.id ?? ""))
    return { deleted: true }
  }, { deleted: false })
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

export function createPlugin(dependencies: PluginDependencies = {}): PluginEntry {
  return {
    name: "clawd-remember",
    slot: "memory",
    configSchema,
    hooks: {
      before_prompt_build: createBeforePromptBuild(dependencies),
      after_agent_turn: createAfterAgentTurn(dependencies),
    },
    tools: [
      {
        name: "memory_search",
        description: "Search stored memories for the current user.",
        input_schema: {
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
        execute: createSearchTool(dependencies),
      },
      {
        name: "memory_add",
        description: "Persist a new memory fact.",
        input_schema: {
          type: "object",
          required: ["text"],
          properties: {
            text: { type: "string" },
            userId: { type: "string" },
            sessionId: { type: "string" },
            categories: { type: "array", items: { type: "string" } },
          },
        },
        execute: createAddTool(dependencies),
      },
      {
        name: "memory_delete",
        description: "Delete a memory by id.",
        input_schema: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string" },
          },
        },
        execute: createDeleteTool(dependencies),
      },
    ],
  }
}

const plugin = createPlugin()

export default definePluginEntry(plugin)

export * from "./types.js"
export * from "./memory.js"
export * from "./storage/sqlite.js"
export * from "./embedders/ollama.js"
export * from "./extractors/openai.js"
