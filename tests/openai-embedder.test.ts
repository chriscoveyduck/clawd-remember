import { afterEach, describe, expect, it, jest } from "@jest/globals"

import { OpenAIEmbedder } from "../src/embedders/openai.js"

describe("OpenAIEmbedder", () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
  })

  it("embeds text and caches dimensions", async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
    } as Response)) as typeof fetch

    const embedder = new OpenAIEmbedder({
      baseURL: "https://api.openai.com/v1",
      apiKey: "sk-test",
    })

    await expect(embedder.embed("hello")).resolves.toEqual([0.1, 0.2, 0.3])
    expect(embedder.dimensions).toBe(3)
  })

  it("uses text-embedding-3-small as the default model", async () => {
    let capturedBody: Record<string, unknown> = {}
    global.fetch = jest.fn(async (_url: unknown, init?: RequestInit) => {
      capturedBody = JSON.parse((init?.body as string) ?? "{}") as Record<string, unknown>
      return {
        ok: true,
        json: async () => ({ data: [{ embedding: [0.5, 0.6] }] }),
      } as Response
    }) as typeof fetch

    const embedder = new OpenAIEmbedder({
      baseURL: "https://api.openai.com/v1",
      apiKey: "sk-test",
    })

    await embedder.embed("test")
    expect(capturedBody.model).toBe("text-embedding-3-small")
  })

  it("accepts a custom model", async () => {
    let capturedBody: Record<string, unknown> = {}
    global.fetch = jest.fn(async (_url: unknown, init?: RequestInit) => {
      capturedBody = JSON.parse((init?.body as string) ?? "{}") as Record<string, unknown>
      return {
        ok: true,
        json: async () => ({ data: [{ embedding: [0.9] }] }),
      } as Response
    }) as typeof fetch

    const embedder = new OpenAIEmbedder({
      baseURL: "https://api.openai.com/v1",
      apiKey: "sk-test",
      model: "text-embedding-ada-002",
    })

    await embedder.embed("test")
    expect(capturedBody.model).toBe("text-embedding-ada-002")
  })

  it("sends the correct Authorization header", async () => {
    let capturedHeaders: Record<string, string> = {}
    global.fetch = jest.fn(async (_url: unknown, init?: RequestInit) => {
      capturedHeaders = (init?.headers as Record<string, string>) ?? {}
      return {
        ok: true,
        json: async () => ({ data: [{ embedding: [0.1] }] }),
      } as Response
    }) as typeof fetch

    const embedder = new OpenAIEmbedder({
      baseURL: "https://api.openai.com/v1",
      apiKey: "sk-secret-key",
    })

    await embedder.embed("test")
    expect(capturedHeaders["authorization"]).toBe("Bearer sk-secret-key")
  })

  it("throws when the API returns a non-ok response", async () => {
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 401,
    } as Response)) as typeof fetch

    const embedder = new OpenAIEmbedder({
      baseURL: "https://api.openai.com/v1",
      apiKey: "sk-bad",
    })

    await expect(embedder.embed("hello")).rejects.toThrow(/401/)
  })

  it("throws when the response contains no embedding", async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ data: [] }),
    } as Response)) as typeof fetch

    const embedder = new OpenAIEmbedder({
      baseURL: "https://api.openai.com/v1",
      apiKey: "sk-test",
    })

    await expect(embedder.embed("hello")).rejects.toThrow(/valid embedding/)
  })

  it("throws before first embed when dimensions are accessed", () => {
    const embedder = new OpenAIEmbedder({
      baseURL: "https://api.openai.com/v1",
      apiKey: "sk-test",
    })

    expect(() => embedder.dimensions).toThrow(/not available before/)
  })
})
