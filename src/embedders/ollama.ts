import type { Embedder, OllamaEmbedderConfig } from "../types.js"
import { withTimeout } from "../utils.js"

type OllamaResponse = {
  embedding?: number[]
}

export class OllamaEmbedder implements Embedder {
  private cachedDimensions?: number

  public constructor(private readonly config: OllamaEmbedderConfig) {}

  public get dimensions(): number {
    if (this.cachedDimensions === undefined) {
      throw new Error("Embedding dimensions are not available before the first embed call")
    }

    return this.cachedDimensions
  }

  public async embed(text: string): Promise<number[]> {
    const run = async (): Promise<number[]> => {
      const response = await fetch(new URL("/api/embeddings", this.config.url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.config.model,
          prompt: text,
        }),
      })

      if (!response.ok) {
        throw new Error(`Ollama embeddings request failed with ${response.status}`)
      }

      const body = await response.json() as OllamaResponse
      if (!Array.isArray(body.embedding) || body.embedding.length === 0) {
        throw new Error("Ollama embeddings response did not include a valid embedding")
      }

      this.cachedDimensions = body.embedding.length
      return body.embedding
    }

    return withTimeout(run(), this.config.timeoutMs ?? 10_000, "Ollama embedding")
  }
}
