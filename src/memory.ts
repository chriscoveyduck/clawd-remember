import type {
  CaptureOptions,
  Embedder,
  FactPayload,
  Filters,
  LLMExtractor,
  Message,
  RecallOptions,
  SearchResult,
  StorageProvider,
} from "./types.js"
import { createFactPayload } from "./utils.js"

export interface MemoryManagerConfig {
  userId: string
  sessionId?: string
  categories?: string[]
  topK?: number
  deduplicationThreshold?: number
}

export class MemoryManager {
  public constructor(
    private readonly storage: StorageProvider,
    private readonly embedder: Embedder,
    private readonly extractor: LLMExtractor,
    private readonly config: MemoryManagerConfig,
  ) {}

  public async init(): Promise<void> {
    await this.storage.init()
  }

  public async capture(conversation: Message[], options: CaptureOptions = {}): Promise<FactPayload[]> {
    const facts = await this.extractor.extract(conversation)
    const created: FactPayload[] = []

    for (const factText of facts) {
      const payload = createFactPayload(
        factText,
        options.userId ?? this.config.userId,
        options.sessionId ?? this.config.sessionId,
        options.categories ?? this.config.categories,
      )
      const vector = await this.embedder.embed(payload.data)
      const similar = await this.storage.search(vector, 1, {
        user_id: options.userId ?? this.config.userId,
      })

      if (similar.length > 0 && similar[0].score >= (this.config.deduplicationThreshold ?? 0.92)) {
        continue
      }

      await this.storage.insert(payload.id, vector, payload)
      const stored = await this.storage.get(payload.id)
      created.push(stored ?? payload)
    }

    return created
  }

  public async recall(query: string, options: RecallOptions = {}): Promise<SearchResult[]> {
    return this.search(query, options)
  }

  public async search(query: string, options: RecallOptions = {}): Promise<SearchResult[]> {
    const vector = await this.embedder.embed(query)
    return this.storage.search(vector, options.topK ?? this.config.topK ?? 10, {
      user_id: options.user_id ?? this.config.userId,
      session_id: options.session_id ?? this.config.sessionId,
      categories: options.categories,
    })
  }

  public async add(text: string, userId: string, sessionId?: string, categories?: string[]): Promise<FactPayload> {
    const payload = createFactPayload(text, userId, sessionId, categories)
    const vector = await this.embedder.embed(payload.data)
    await this.storage.insert(payload.id, vector, payload)
    return (await this.storage.get(payload.id)) ?? payload
  }

  public async delete(id: string): Promise<void> {
    await this.storage.delete(id)
  }

  public async list(filters?: Filters, topK?: number): Promise<FactPayload[]> {
    return this.storage.list(filters, topK)
  }
}
