export interface Message {
  role: string
  content: string
}

export interface Filters {
  user_id?: string
  session_id?: string
  categories?: string[]
}

export interface FactPayload {
  id: string
  data: string
  hash: string
  user_id: string
  session_id?: string
  created_at: string
  updated_at: string
  categories?: string[]
}

export interface SearchResult {
  fact: FactPayload
  score: number
}

export interface SessionCaptureState {
  watermark: number
  completedAt: string | null
}

export interface StorageProvider {
  init(): Promise<void>
  insert(id: string, vector: number[], payload: FactPayload): Promise<void>
  search(vector: number[], topK: number, filters?: Filters): Promise<SearchResult[]>
  get(id: string): Promise<FactPayload | null>
  delete(id: string): Promise<void>
  list(filters?: Filters, topK?: number): Promise<FactPayload[]>
  getSessionState(sessionKey: string): Promise<SessionCaptureState | null>
  upsertWatermark(sessionKey: string, watermark: number): Promise<void>
  markCompleted(sessionKey: string): Promise<void>
}

export interface Embedder {
  embed(text: string): Promise<number[]>
  readonly dimensions: number
}

export interface LLMExtractor {
  extract(conversation: Message[]): Promise<string[]>
}

export interface SqliteStorageConfig {
  dimensions?: number
  path?: string
}

export interface OllamaEmbedderConfig {
  url: string
  model: string
  timeoutMs?: number
}

export interface OpenAICompatibleConfig {
  baseURL: string
  model: string
  apiKey: string
  timeoutMs?: number
}

export interface PluginConfig {
  storage: {
    provider: "sqlite"
    config: SqliteStorageConfig
  }
  embedder:
    | {
        provider: "ollama"
        config: OllamaEmbedderConfig
      }
    | {
        provider: "openai"
        config: OpenAICompatibleConfig
      }
  llm: {
    provider: "openai-compatible"
    config: OpenAICompatibleConfig
  }
  /** Optional override for the agent name portion of the partition key (Level 2).
   * When omitted, the partition key is auto-derived from the session/agent context. */
  userId?: string
  sessionId?: string
  autoRecall?: boolean
  autoCapture?: boolean
  topK?: number
  recallTimeout?: number
  captureTimeout?: number
  chunkSize?: number
  categories?: string[]
  useConversationAccess?: boolean
}

export interface RecallOptions extends Filters {
  topK?: number
}

export interface CaptureOptions {
  userId?: string
  sessionId?: string
  categories?: string[]
}
