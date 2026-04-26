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

export interface StorageProvider {
  init(): Promise<void>
  insert(id: string, vector: number[], payload: FactPayload): Promise<void>
  search(vector: number[], topK: number, filters?: Filters): Promise<SearchResult[]>
  get(id: string): Promise<FactPayload | null>
  delete(id: string): Promise<void>
  list(filters?: Filters, topK?: number): Promise<FactPayload[]>
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

export interface MariaDbStorageConfig {
  host: string
  port?: number
  user: string
  password: string
  database: string
  table?: string
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
  storage:
    | {
      provider: "sqlite"
      config: SqliteStorageConfig
    }
    | {
      provider: "mariadb"
      config: MariaDbStorageConfig
    }
  embedder: {
    provider: "ollama"
    config: OllamaEmbedderConfig
  }
  llm:
    | {
        provider: "openai-compatible"
        config: OpenAICompatibleConfig
      }
    | {
        provider: "github-copilot"
        config: {
          model?: string
          tokenPath?: string
          timeoutMs?: number
        }
      }
  /** Optional override for the agent name portion of the partition key (Level 2). */
  userId?: string
  sessionId?: string
  autoRecall?: boolean
  autoCapture?: boolean
  topK?: number
  recallTimeout?: number
  captureTimeout?: number
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
