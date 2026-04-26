import type {
  Embedder,
  FactPayload,
  Filters,
  LLMExtractor,
  Message,
  SearchResult,
  SessionCaptureState,
  StorageProvider,
} from "../src/types.js"
import { cosineSimilarity } from "../src/utils.js"

export class MockEmbedder implements Embedder {
  public readonly dimensions = 3

  public async embed(text: string): Promise<number[]> {
    const base = Array.from(text).reduce((sum, char) => sum + char.charCodeAt(0), 0)
    return [base % 7, (base * 3) % 11, (base * 5) % 13]
  }
}

export class MockExtractor implements LLMExtractor {
  public constructor(private readonly facts: string[]) {}

  public async extract(_conversation: Message[]): Promise<string[]> {
    return this.facts
  }
}

export class InMemoryStorageProvider implements StorageProvider {
  private readonly store = new Map<string, { payload: FactPayload; vector: number[] }>()
  private readonly sessionState = new Map<string, SessionCaptureState>()

  public async init(): Promise<void> {}

  public async insert(id: string, vector: number[], payload: FactPayload): Promise<void> {
    const existing = Array.from(this.store.entries()).find(([, value]) =>
      value.payload.hash === payload.hash &&
      value.payload.user_id === payload.user_id &&
      value.payload.session_id === payload.session_id,
    )

    const targetId = existing?.[0] ?? id
    this.store.set(targetId, {
      payload: {
        ...(existing?.[1].payload ?? payload),
        ...payload,
        id: targetId,
      },
      vector,
    })
  }

  public async search(vector: number[], topK: number, filters: Filters = {}): Promise<SearchResult[]> {
    return Array.from(this.store.values())
      .filter(({ payload }) => {
        if (filters.user_id && payload.user_id !== filters.user_id) {
          return false
        }
        if (filters.session_id && payload.session_id !== filters.session_id) {
          return false
        }
        if (filters.categories?.length) {
          const payloadCategories = payload.categories ?? []
          return filters.categories.every((category) => payloadCategories.includes(category))
        }
        return true
      })
      .map(({ payload, vector: storedVector }) => ({
        fact: payload,
        score: cosineSimilarity(vector, storedVector),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
  }

  public async get(id: string): Promise<FactPayload | null> {
    return this.store.get(id)?.payload ?? null
  }

  public async delete(id: string): Promise<void> {
    this.store.delete(id)
  }

  public async list(filters: Filters = {}, topK?: number): Promise<FactPayload[]> {
    const items = Array.from(this.store.values())
      .map((value) => value.payload)
      .filter((payload) => {
        if (filters.user_id && payload.user_id !== filters.user_id) {
          return false
        }
        if (filters.session_id && payload.session_id !== filters.session_id) {
          return false
        }
        return true
      })
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))

    return topK ? items.slice(0, topK) : items
  }

  public async getSessionState(sessionKey: string): Promise<SessionCaptureState | null> {
    return this.sessionState.get(sessionKey) ?? null
  }

  public async upsertWatermark(sessionKey: string, watermark: number): Promise<void> {
    const existing = this.sessionState.get(sessionKey)
    this.sessionState.set(sessionKey, {
      ...existing,
      watermark,
      completedAt: null,
    })
  }

  public async markCompleted(sessionKey: string): Promise<void> {
    const existing = this.sessionState.get(sessionKey)
    this.sessionState.set(sessionKey, {
      watermark: existing?.watermark ?? 0,
      completedAt: new Date().toISOString(),
    })
  }
}
