# clawd-remember

> A lightweight, self-hosted memory plugin for OpenClaw agents.

**clawd-remember** is an open-source memory plugin for [OpenClaw](https://openclaw.ai) that gives your AI agent persistent, searchable long-term memory — private, self-hosted, and easy to run.

---

## Features

- 🔍 **Semantic search** — query memories by meaning, not just keywords
- 🗄️ **SQLite storage** — embedded, zero-config, production-ready via sqlite-vec
- 🧠 **Ollama embeddings** — local embedding generation, fully private
- 🤖 **OpenAI embeddings** — `text-embedding-3-small` via OpenAI API (or compatible endpoint)
- 🔬 **OpenAI-compatible fact extraction** — LLM extraction via `gpt-4o-mini` or any compatible model
- 🧩 **OpenClaw memory slot** — registers as a first-class memory slot plugin
- 🪶 **Minimal dependencies** — TypeScript, sqlite-vec, and nothing else

> **Note on privacy:** OpenAI is used by default for both LLM extraction (`gpt-4o-mini`) and embeddings (`text-embedding-3-small`). Your conversation content is sent to OpenAI's API for processing. If you want a fully local deployment, configure the LLM extractor to point at a local OpenAI-compatible endpoint (e.g. Ollama, LM Studio) and use the `ollama` embedder provider.

---

## Why clawd-remember?

clawd-remember is built around a simple principle: a minimal, auditable codebase with no unnecessary dependencies, and storage backends that are easy to run and maintain.

---

## Prerequisites

Node.js must be installed via [nvm](https://github.com/nvm-sh/nvm). Do **not** use apt/brew — the system Node does not resolve global modules correctly.

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
nvm install 22
nvm use 22
```

## Quick Start

```bash
# Install the plugin globally
npm install -g clawd-remember

# If using SQLite backend, install native deps into the plugin directory:
sudo npm install --prefix $(npm root -g)/clawd-remember better-sqlite3 sqlite-vec
```

Add to your `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "clawd-remember": {
        "enabled": true,
        "config": {
          "autoRecall": true,
          "autoCapture": true,
          "storage": {
            "provider": "sqlite",
            "config": {
              "path": "~/.openclaw/clawd-remember.db"
            }
          },
          "embedder": {
            "provider": "openai",
            "config": {
              "baseURL": "https://api.openai.com/v1",
              "apiKey": "sk-...",
              "model": "text-embedding-3-small"
            }
          },
          "llm": {
            "provider": "openai-compatible",
            "config": {
              "baseURL": "https://api.openai.com/v1",
              "model": "gpt-4o-mini",
              "apiKey": "sk-..."
            }
          }
        },
        "topK": 10,
        "recallTimeout": 10000,
        "captureTimeout": 15000
      }
    },
    "slots": {
      "memory": "clawd-remember"
    }
  }
}
```

### Local-only (Ollama) example

If you want to keep all processing local, point both the embedder and LLM extractor at Ollama:

```json
{
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
      "baseURL": "http://localhost:11434/v1",
      "model": "llama3",
      "apiKey": "ollama"
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

### Embedder Providers

| Provider | Description |
|----------|-------------|
| `ollama` | Local Ollama instance — fully private |
| `openai` | OpenAI embeddings API (`text-embedding-3-small` by default) |

### LLM Providers

| Provider | Description |
|----------|-------------|
| `openai-compatible` | Any OpenAI-compatible API (OpenAI, Ollama, LM Studio, etc.) |

### Core Options

| Key | Default | Description |
|-----|---------|-------------|
| `userId` | _(auto-derived)_ | Optional override for the agent partition key (Level 2). When omitted, the key is derived from the session/agent context. |
| `sessionId` | unset | Optional session-scoped memory id |
| `autoRecall` | `true` | Inject relevant memories before prompt build |
| `autoCapture` | `true` | Extract and store facts after each agent turn |
| `topK` | `10` | Number of memories returned for recall/search |
| `recallTimeout` | `10000` | Timeout in milliseconds for recall |
| `captureTimeout` | `15000` | Timeout in milliseconds for capture |
| `categories` | unset | Optional tags applied to captured/manual facts |

### Notes

- `better-sqlite3` is an optional dependency. If it is missing, the plugin throws a helpful install error when SQLite storage is initialized.
- All hook and tool operations are wrapped defensively so memory failures log warnings instead of crashing the agent turn.
- Memory is partitioned by a two-level key: a stable instance UUID (Level 1) and the agent ID derived from the session key (Level 2). This means memories are isolated per deployment and per agent by default.

---

## Architecture

```
User message
     │
     ▼
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│  LLM        │────▶│  Embedder    │────▶│  Storage    │
│  Extractor  │     │  (Ollama /   │     │  (SQLite /  │
│             │     │   OpenAI)    │     │   sqlite-   │
│  Extracts   │     │              │     │   vec)      │
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

- [x] SQLite + sqlite-vec storage backend
- [x] Ollama embedder
- [x] OpenAI embedder (`text-embedding-3-small`)
- [x] OpenAI-compatible LLM extractor
- [x] Auto-recall (inject memories before agent turn)
- [x] Auto-capture (extract facts after agent turn)
- [x] `memory_search` tool
- [x] `memory_add` tool
- [x] `memory_delete` tool
- [x] `memory_list` tool
- [x] Session-scoped vs long-term memory
- [x] Two-level partition keys (instance UUID + agent ID)
- [ ] PostgreSQL storage backend
- [ ] Memory consolidation / deduplication
- [ ] Cross-project fact linking
- [ ] ClaWHub publish

---

## License

MIT — see [LICENSE](LICENSE)

---

## Credits

Built by [Chris Coveyduck](https://github.com/chriscoveyduck).
