import type { Embedder, OpenAICompatibleConfig } from "../types.js"
import { withTimeout } from "../utils.js"

export type OpenAIEmbedderConfig = Pick<OpenAICompatibleConfig, "baseURL" | "apiKey" | "timeoutMs"> & {
  model?: string
}

type OpenAIEmbeddingsResponse = {
  data: Array<{ embedding: number[] }>
}

export class OpenAIEmbedder implements Embedder {
  private cachedDimensions?: number
  private readonly config: Required<Omit<OpenAIEmbedderConfig, "timeoutMs">> & { timeoutMs?: number }

  public constructor(config: OpenAIEmbedderConfig) {
    this.config = {
      baseURL: config.baseURL,
      apiKey: config.apiKey,
      model: config.model ?? "text-embedding-3-small",
      timeoutMs: config.timeoutMs,
    }
  }

  public get dimensions(): number {
    if (this.cachedDimensions === undefined) {
      throw new Error("Embedding dimensions are not available before the first embed call")
    }

    return this.cachedDimensions
  }

  public async embed(text: string): Promise<number[]> {
    const run = async (): Promise<number[]> => {
      const baseURL = this.config.baseURL.replace(/\/$/, "")
      const response = await fetch(`${baseURL}/embeddings`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          input: text,
          model: this.config.model,
        }),
      })

      if (!response.ok) {
        throw new Error(`OpenAI embeddings request failed with ${response.status}`)
      }

      const body = await response.json() as OpenAIEmbeddingsResponse
      const embedding = body?.data?.[0]?.embedding
      if (!Array.isArray(embedding) || embedding.length === 0) {
        throw new Error("OpenAI embeddings response did not include a valid embedding")
      }

      this.cachedDimensions = embedding.length
      return embedding
    }

    return withTimeout(run(), this.config.timeoutMs ?? 10_000, "OpenAI embedding")
  }
}
