# clawd-remember Architecture

## Overview

clawd-remember is an OpenClaw memory plugin with a layered, provider-based architecture. Every major component is swappable via config.

## Layers

```
┌─────────────────────────────────────────────┐
│              OpenClaw Plugin API             │
│   (before_prompt_build, after_agent_turn)   │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│              Memory Manager                  │
│   Orchestrates capture, recall, search       │
└──────┬───────────┬──────────────┬───────────┘
       │           │              │
┌──────▼──┐  ┌─────▼──────┐  ┌───▼──────────┐
│  LLM    │  │  Embedder  │  │   Storage    │
│Extractor│  │            │  │   Provider   │
│         │  │ Ollama /   │  │              │
│Extracts │  │ OpenAI     │  │ SQLite /     │
│facts    │  │            │  │ MariaDB /    │
│from     │  │Vectorises  │  │ Postgres     │
│convos   │  │facts       │  │              │
└─────────┘  └────────────┘  └──────────────┘
```

## Core Concepts

### Facts
A fact is a discrete, third-person statement extracted from a conversation:
- `"User's blog project uses Astro 6 on Cloudflare Workers"`
- `"User fixed hydration error in Yosemite project by disabling SSR for that component"`

Facts are the unit of storage and retrieval.

### Auto-Capture
After each agent turn, the LLM extractor reviews the conversation and extracts new facts. These are deduplicated, embedded, and stored.

### Auto-Recall
Before each agent turn, the current prompt is embedded and used to search for relevant facts. Top results are injected into the agent's context.

### Session vs Long-Term Scope
Facts can be scoped to a session (temporary) or long-term (persistent across sessions). The `memory_search` tool supports filtering by scope.

## Provider Interfaces

### StorageProvider
```typescript
interface StorageProvider {
  init(): Promise<void>
  insert(id: string, vector: number[], payload: FactPayload): Promise<void>
  search(vector: number[], topK: number, filters?: object): Promise<SearchResult[]>
  get(id: string): Promise<FactPayload | null>
  delete(id: string): Promise<void>
  list(filters?: object, topK?: number): Promise<FactPayload[]>
}
```

### Embedder
```typescript
interface Embedder {
  embed(text: string): Promise<number[]>
  readonly dimensions: number
}
```

### LLMExtractor
```typescript
interface LLMExtractor {
  extract(conversation: Message[]): Promise<string[]>
}
```

## Data Model

Each stored fact has:
```typescript
interface FactPayload {
  id: string          // UUID
  data: string        // The fact text
  hash: string        // MD5 of data (for deduplication)
  user_id: string     // Owner
  session_id?: string // Set for session-scoped facts
  created_at: string  // ISO timestamp
  updated_at: string  // ISO timestamp
  categories?: string[] // Optional tags
}
```

## Design Principles

1. **No telemetry** — the code never calls home
2. **Fail gracefully** — memory errors never crash the agent turn
3. **Timeout-safe** — all operations have configurable timeouts with sensible defaults
4. **Provider parity** — all storage backends support the same feature set
5. **Minimal surface area** — small, auditable codebase
