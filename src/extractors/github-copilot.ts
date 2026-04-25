import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type { LLMExtractor, Message } from "../types.js"

interface CopilotTokenFile {
  token: string
  expiresAt: number
  updatedAt: number
}

async function getToken(tokenPath?: string): Promise<string> {
  const path = tokenPath ?? join(homedir(), ".openclaw", "credentials", "github-copilot.token.json")
  const raw = await readFile(path, "utf-8")
  const data = JSON.parse(raw) as CopilotTokenFile
  // Token is considered valid if it expires more than 60s from now
  if (data.expiresAt - Date.now() < 60_000) {
    throw new Error("GitHub Copilot token is expired or expiring imminently — gateway needs to refresh it first")
  }
  return data.token
}

export class GitHubCopilotExtractor implements LLMExtractor {
  private readonly model: string
  private readonly tokenPath?: string
  private readonly timeoutMs: number

  constructor(config: { model?: string; tokenPath?: string; timeoutMs?: number }) {
    this.model = config.model ?? "claude-sonnet-4.6"
    this.tokenPath = config.tokenPath
    this.timeoutMs = config.timeoutMs ?? 30_000
  }

  async extract(conversation: Message[]): Promise<string[]> {
    const token = await getToken(this.tokenPath)

    const systemPrompt = `Extract key facts worth remembering from this conversation. Return a JSON array of strings, each being a concise factual statement. Focus on: preferences, decisions, technical context, personal details, project information. Return ONLY valid JSON array, no other text.`

    const userContent = conversation
      .map(m => `${m.role}: ${m.content}`)
      .join("\n")

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)

    try {
      const response = await fetch("https://api.githubcopilot.com/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
          "Copilot-Integration-Id": "vscode-chat",
          "Editor-Version": "vscode/1.99.0",
          "Editor-Plugin-Version": "copilot-chat/0.26.0",
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userContent }
          ],
          max_tokens: 1000,
          temperature: 0,
        }),
        signal: controller.signal,
      })

      if (!response.ok) {
        throw new Error(`Copilot API error: ${response.status} ${await response.text()}`)
      }

      const data = await response.json() as { choices: Array<{ message: { content: string } }> }
      const content = data.choices[0]?.message?.content ?? "[]"

      // Parse JSON array from response
      const match = content.match(/\[[\s\S]*\]/)
      if (!match) return []
      return JSON.parse(match[0]) as string[]
    } finally {
      clearTimeout(timeout)
    }
  }
}
