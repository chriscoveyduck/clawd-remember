# clawd-remember

> A lightweight, reliable, OpenClaw-native memory plugin that actually works.

**clawd-remember** is an open-source memory plugin for [OpenClaw](https://openclaw.ai) that gives your AI agent persistent, searchable long-term memory — without the instability, telemetry overhead, and mystery timeouts of other solutions.

Built because the existing options have reliability problems. Designed to be the one that doesn't.

---

## Features

- 🔍 **Semantic search** — query memories by meaning, not just keywords
- 🗄️ **Pluggable storage** — SQLite today, MariaDB next
- 🧠 **Ollama embeddings** — local embedding generation with configurable endpoint and model
- 🤖 **OpenAI-compatible fact extraction** — use any compatible chat completion API
- 🔒 **Fully self-hosted** — your data never leaves your server
- ⚡ **No telemetry** — zero phone-home, ever
- 🧩 **OpenClaw memory slot compatible** — drop-in replacement for `openclaw-mem0`
- 🪶 **Lightweight** — minimal dependencies, no SDK bloat

---

## Why clawd-remember?

Existing OpenClaw memory solutions can be complex, heavyweight, and difficult to self-host reliably. clawd-remember takes a different approach: a minimal, auditable codebase with no telemetry, no unnecessary dependencies, and storage backends that are easy to run and maintain.

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
          "userId": "your-user-id",
          "autoRecall": true,
          "autoCapture": true,
          "storage": {
            "provider": "sqlite",
            "config": {
              "path": "~/.openclaw/clawd-remember.db"
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

---

## Configuration

### Storage Providers

| Provider | Description | Extra deps |
|----------|-------------|------------|
| `sqlite` | Embedded SQLite with sqlite-vec extension | `better-sqlite3`, `sqlite-vec` |
| `mariadb` | MariaDB / MySQL with vector support | `mysql2` |

### Embedder Providers

| Provider | Description |
|----------|-------------|
| `ollama` | Local Ollama instance |

### LLM Providers

| Provider | Description |
|----------|-------------|
| `openai-compatible` | Any OpenAI-compatible API (Copilot proxy, Ollama, etc.) |

### Core Options

| Key | Default | Description |
|-----|---------|-------------|
| `userId` | `default` | Owner id for stored facts |
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
- MariaDB is declared in the config schema for forward compatibility, but `v0.1.0` only implements the SQLite backend.

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

- [x] SQLite + sqlite-vec storage backend
- [x] Ollama embedder
- [x] OpenAI-compatible LLM extractor
- [x] GitHub Copilot LLM extractor
- [x] Auto-recall (inject memories before agent turn)
- [x] Auto-capture (extract facts after agent turn)
- [x] `memory_search` tool
- [x] `memory_add` tool
- [x] `memory_delete` tool
- [x] `memory_list` tool
- [x] Session-scoped vs long-term memory
- [ ] PostgreSQL storage backend
- [ ] Memory consolidation / deduplication
- [ ] Cross-project fact linking
- [ ] ClaWHub publish

### Future / Out of Scope

MariaDB/PostgreSQL backends are planned for a future release.

---

## License

MIT — see [LICENSE](LICENSE)

---

## Credits

Built by [Chris Coveyduck](https://github.com/chriscoveyduck) with [Skippy the Magnificent](https://openclaw.ai) 🎩.
