# clawd-remember

> A lightweight, reliable, OpenClaw-native memory plugin that actually works.

**clawd-remember** is an open-source memory plugin for [OpenClaw](https://openclaw.ai) that gives your AI agent persistent, searchable long-term memory — without the instability, telemetry overhead, and mystery timeouts of other solutions.

Built because the existing options were a shitshow. Designed to be the one that isn't.

---

## Features

- 🔍 **Semantic search** — query memories by meaning, not just keywords
- 🗄️ **Pluggable storage** — SQLite (default), MariaDB, or PostgreSQL
- 🧠 **Pluggable embedders** — Ollama, OpenAI, or any OpenAI-compatible endpoint
- 🤖 **Pluggable LLM extraction** — any OpenAI-compatible LLM for fact extraction
- 🔒 **Fully self-hosted** — your data never leaves your server
- ⚡ **No telemetry** — zero phone-home, ever
- 🧩 **OpenClaw memory slot compatible** — drop-in replacement for `openclaw-mem0`
- 🪶 **Lightweight** — minimal dependencies, no SDK bloat

---

## Why not mem0?

The `@mem0/openclaw-mem0` plugin has [known issues](https://github.com/mem0ai/mem0/issues/4727) with pgvector in OSS mode — recall timeouts, PostHog telemetry blocking async operations, and client connection bugs. clawd-remember was built to solve exactly these problems with a simpler, more reliable architecture.

---

## Quick Start

```bash
npm install clawd-remember
```

Add to your `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "clawd-remember": {
        "enabled": true,
        "config": {
          "userId": "your-user-id",
          "autoRecall": true,
          "autoCapture": true,
          "storage": {
            "provider": "sqlite",
            "config": {
              "path": "~/.openclaw/memory.db"
            }
          },
          "embedder": {
            "provider": "ollama",
            "config": {
              "url": "http://localhost:11434",
              "model": "nomic-embed-text"
            }
          },
          "llm": {
            "provider": "openai-compatible",
            "config": {
              "baseURL": "http://localhost:4141/v1",
              "model": "gpt-4o-mini",
              "apiKey": "dummy"
            }
          }
        }
      }
    },
    "slots": {
      "memory": "clawd-remember"
    }
  }
}
```

---

## Configuration

### Storage Providers

| Provider | Description | Extra deps |
|----------|-------------|------------|
| `sqlite` | Embedded SQLite with sqlite-vec extension | `better-sqlite3`, `sqlite-vec` |
| `mariadb` | MariaDB / MySQL with vector support | `mysql2` |
| `postgres` | PostgreSQL with pgvector | `pg` |

### Embedder Providers

| Provider | Description |
|----------|-------------|
| `ollama` | Local Ollama instance |
| `openai` | OpenAI or any OpenAI-compatible endpoint |

### LLM Providers

| Provider | Description |
|----------|-------------|
| `openai-compatible` | Any OpenAI-compatible API (Copilot proxy, Ollama, etc.) |
| `openai` | OpenAI directly |

---

## Architecture

```
User message
     │
     ▼
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│  LLM        │────▶│  Embedder    │────▶│  Storage    │
│  Extractor  │     │  (Ollama /   │     │  (SQLite /  │
│             │     │   OpenAI)    │     │   Maria /   │
│  Extracts   │     │              │     │   Postgres) │
│  facts from │     │  Vectorises  │     │             │
│  conversation    │  facts       │     │  Stores &   │
└─────────────┘     └──────────────┘     │  searches   │
                                         └─────────────┘
                                                │
                                                ▼
                                    Semantic search on recall
                                    injected into agent context
```

---

## Development

```bash
git clone https://github.com/chriscoveyduck/clawd-remember
cd clawd-remember
npm install
npm test
```

### Contributing

PRs welcome. Please open an issue first for significant changes.

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

---

## Roadmap

- [ ] SQLite + sqlite-vec storage backend
- [ ] MariaDB storage backend  
- [ ] Ollama embedder
- [ ] OpenAI-compatible embedder
- [ ] OpenAI-compatible LLM extractor
- [ ] Auto-recall (inject memories before agent turn)
- [ ] Auto-capture (extract facts after agent turn)
- [ ] `memory_search` tool
- [ ] `memory_add` tool
- [ ] `memory_delete` tool
- [ ] Session-scoped vs long-term memory
- [ ] PostgreSQL storage backend
- [ ] Memory consolidation / deduplication
- [ ] Cross-project fact linking
- [ ] ClaWHub publish

---

## License

MIT — see [LICENSE](LICENSE)

---

## Credits

Built by [Chris Coveyduck](https://github.com/chriscoveyduck) with [Skippy the Magnificent](https://openclaw.ai) 🎩

Inspired by the frustration of `@mem0/openclaw-mem0` not working reliably in OSS mode.
