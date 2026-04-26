import type { LLMExtractor, Message, OpenAICompatibleConfig } from "../types.js"
import { withTimeout } from "../utils.js"

const SYSTEM_PROMPT = [
  "You are extracting long-term memory facts for a personal AI assistant.",
  "Extract only facts that would be genuinely useful to recall in a future conversation —",
  "user preferences, decisions made, project context, key people, recurring topics, and lessons learned.",
  "CRITICAL: Do NOT extract facts that the assistant is referencing or repeating from prior memory context.",
  "Only extract NEW information that is being introduced for the first time in the conversation.",
  "If the assistant says something like 'as I recall' or 'as noted' or repeats a previously known fact, skip it.",
  "Ignore: session metadata, timestamps, tool call details, transient state, bug investigation details,",
  "anything already common knowledge, and anything that won't be meaningful outside this specific conversation.",
  "Each fact must be standalone, concise, and written as a statement.",
  'Return JSON: {"facts":["..."]}.',
].join(" ")

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>
    }
  }>
}

export class OpenAICompatibleExtractor implements LLMExtractor {
  public constructor(private readonly config: OpenAICompatibleConfig) {}

  public async extract(conversation: Message[]): Promise<string[]> {
    const run = async (): Promise<string[]> => {
      const url = this.config.baseURL.replace(/\/$/, "") + "/chat/completions"
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          response_format: {
            type: "json_object",
          },
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            {
              role: "user",
              content: JSON.stringify(conversation),
            },
          ],
        }),
      })

      if (!response.ok) {
        throw new Error(`OpenAI-compatible extractor request failed with ${response.status}`)
      }

      const body = await response.json() as ChatCompletionResponse
      const content = getMessageContent(body)
      const parsed = JSON.parse(content) as { facts?: unknown }
      if (!Array.isArray(parsed.facts)) {
        return []
      }

      return parsed.facts
        .filter((fact): fact is string => typeof fact === "string")
        .map((fact) => fact.trim())
        .filter(Boolean)
    }

    return withTimeout(run(), this.config.timeoutMs ?? 15_000, "OpenAI-compatible extraction")
  }
}

function getMessageContent(body: ChatCompletionResponse): string {
  const content = body.choices?.[0]?.message?.content
  if (typeof content === "string") {
    return content
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => part.text ?? "")
      .join("")
      .trim()
  }

  throw new Error("OpenAI-compatible extractor returned an empty response")
}
