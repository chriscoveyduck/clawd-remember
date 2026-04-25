import { afterEach, describe, expect, it, jest } from "@jest/globals"

const originalFetch = global.fetch

type ReadFileMock = jest.MockedFunction<(path: string, encoding: string) => Promise<string>>

async function loadExtractor() {
  jest.resetModules()

  const readFile = jest.fn() as ReadFileMock
  jest.unstable_mockModule("node:fs/promises", () => ({
    readFile,
  }))

  const module = await import("../src/extractors/github-copilot.js")
  return { GitHubCopilotExtractor: module.GitHubCopilotExtractor, readFile }
}

describe("GitHubCopilotExtractor", () => {
  afterEach(() => {
    global.fetch = originalFetch
    jest.restoreAllMocks()
    jest.clearAllMocks()
    jest.resetModules()
  })

  it("returns extracted facts from a valid Copilot response", async () => {
    const { GitHubCopilotExtractor, readFile } = await loadExtractor()
    readFile.mockResolvedValue(JSON.stringify({
      token: "copilot-token",
      expiresAt: Date.now() + 3600_000,
      updatedAt: Date.now(),
    }))
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: "[\"User likes tea\",\"User deploys to Workers\"]",
            },
          },
        ],
      }),
    } as unknown as Response)) as typeof fetch

    const extractor = new GitHubCopilotExtractor({ tokenPath: "/tmp/copilot.token.json" })

    await expect(extractor.extract([{ role: "user", content: "remember this" }]))
      .resolves
      .toEqual(["User likes tea", "User deploys to Workers"])

    expect(readFile).toHaveBeenCalledWith("/tmp/copilot.token.json", "utf-8")
    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.githubcopilot.com/chat/completions",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer copilot-token",
        }),
      }),
    )
  })

  it("throws when the Copilot token is expired", async () => {
    const { GitHubCopilotExtractor, readFile } = await loadExtractor()
    readFile.mockResolvedValue(JSON.stringify({
      token: "expired-token",
      expiresAt: Date.now() - 1000,
      updatedAt: Date.now(),
    }))

    const extractor = new GitHubCopilotExtractor({ tokenPath: "/tmp/copilot.token.json" })

    await expect(extractor.extract([{ role: "user", content: "remember this" }]))
      .rejects
      .toThrow(/expired/i)
  })

  it("throws with the HTTP status code when the API fails", async () => {
    const { GitHubCopilotExtractor, readFile } = await loadExtractor()
    readFile.mockResolvedValue(JSON.stringify({
      token: "copilot-token",
      expiresAt: Date.now() + 3600_000,
      updatedAt: Date.now(),
    }))
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 500,
      text: async () => "internal error",
    } as unknown as Response)) as typeof fetch

    const extractor = new GitHubCopilotExtractor({ tokenPath: "/tmp/copilot.token.json" })

    await expect(extractor.extract([{ role: "user", content: "remember this" }]))
      .rejects
      .toThrow(/500/)
  })

  it("throws gracefully when the API response is not valid JSON", async () => {
    const { GitHubCopilotExtractor, readFile } = await loadExtractor()
    readFile.mockResolvedValue(JSON.stringify({
      token: "copilot-token",
      expiresAt: Date.now() + 3600_000,
      updatedAt: Date.now(),
    }))
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON")
      },
    } as unknown as Response)) as typeof fetch

    const extractor = new GitHubCopilotExtractor({ tokenPath: "/tmp/copilot.token.json" })

    await expect(extractor.extract([{ role: "user", content: "remember this" }]))
      .rejects
      .toThrow(/Unexpected token|JSON/i)
  })

  it("returns [] when the response does not contain a JSON array", async () => {
    const { GitHubCopilotExtractor, readFile } = await loadExtractor()
    readFile.mockResolvedValue(JSON.stringify({
      token: "copilot-token",
      expiresAt: Date.now() + 3600_000,
      updatedAt: Date.now(),
    }))
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: "No facts found.",
            },
          },
        ],
      }),
    } as unknown as Response)) as typeof fetch

    const extractor = new GitHubCopilotExtractor({ tokenPath: "/tmp/copilot.token.json" })

    await expect(extractor.extract([{ role: "user", content: "remember this" }])).resolves.toEqual([])
  })

  it("extracts a JSON array from content with a preamble", async () => {
    const { GitHubCopilotExtractor, readFile } = await loadExtractor()
    readFile.mockResolvedValue(JSON.stringify({
      token: "copilot-token",
      expiresAt: Date.now() + 3600_000,
      updatedAt: Date.now(),
    }))
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: "Sure, here are the facts:\n[\"User likes tea\"]",
            },
          },
        ],
      }),
    } as unknown as Response)) as typeof fetch

    const extractor = new GitHubCopilotExtractor({ tokenPath: "/tmp/copilot.token.json" })

    await expect(extractor.extract([{ role: "user", content: "remember this" }]))
      .resolves
      .toEqual(["User likes tea"])
  })
})
