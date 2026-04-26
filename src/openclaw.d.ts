declare module "openclaw/plugin-sdk" {
  export function definePluginEntry<T>(entry: T): T
  export interface PluginApi {
    pluginConfig: Record<string, unknown> | undefined
    agentId?: string
    on(
      event: "before_prompt_build" | "agent_end" | string,
      handler: (event: unknown) => Promise<unknown> | unknown,
      opts?: { priority?: number }
    ): void
    registerTool(tool: {
      name: string
      description: string
      parameters: unknown
      execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>
    }): void
  }
}

declare module "openclaw/plugin-sdk/routing" {
  export interface ParsedAgentSessionKey {
    agentId: string
    rest: string
  }
  export function parseAgentSessionKey(sessionKey: string | undefined | null): ParsedAgentSessionKey | null
}

declare module "openclaw" {
  export { definePluginEntry } from "openclaw/plugin-sdk"
}
