# Changelog

All notable changes to clawd-remember will be documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2025-04-26

### Added

- **SQLite storage backend** — embedded SQLite via `better-sqlite3` + `sqlite-vec` for vector similarity search
- **Ollama embedder** — local embedding generation via any Ollama-hosted model (e.g. `nomic-embed-text`)
- **OpenAI embedder** — `text-embedding-3-small` via OpenAI embeddings API (or any compatible endpoint)
- **OpenAI-compatible LLM extractor** — fact extraction using `gpt-4o-mini` or any OpenAI-compatible chat completions endpoint
- **Two-level partition keys** — memories are scoped by a stable instance UUID (Level 1) + agent ID derived from session context (Level 2)
- **Auto-recall** — relevant memories are injected into the agent prompt before each turn (`before_prompt_build` hook)
- **Auto-capture** — facts are extracted and stored at session end (`before_reset`, `session_end`, `before_compaction` hooks)
- **Dedup guard** — `processedSessionIds` set prevents double-capture when multiple end-of-session hooks fire in the same flow
- **`memory_search` tool** — semantic search over stored memories
- **`memory_add` tool** — manually add a memory fact
- **`memory_delete` tool** — delete a memory by ID
- **`memory_list` tool** — list stored memories with optional filters
- **OpenClaw plugin entry** — registers tools and hooks via `definePluginEntry`

### Removed

- **GitHub Copilot LLM extractor** — removed; use `openai-compatible` provider pointing at any API instead
- **MariaDB config stubs** — removed dead config options (`provider: "mariadb"`) that were never implemented

[0.1.0]: https://github.com/chriscoveyduck/clawd-remember/releases/tag/v0.1.0
