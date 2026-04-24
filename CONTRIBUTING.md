# Contributing to clawd-remember

Thanks for your interest in contributing! This project exists because the existing OpenClaw memory options weren't good enough — help us make this one that is.

## Before You Start

Please **open an issue first** for anything significant — new features, architectural changes, new storage/embedder backends. This avoids wasted effort if the direction doesn't fit the project goals.

For bug fixes and small improvements, just open a PR.

## Development Setup

```bash
git clone https://github.com/chriscoveyduck/clawd-remember
cd clawd-remember
npm install
npm test
```

## Project Goals

Keep these in mind:

- **Reliability over features** — a smaller feature set that works is better than a large one that doesn't
- **No telemetry, ever** — zero phone-home, no analytics, no opt-out-by-default tracking
- **Minimal dependencies** — every dependency is a potential failure point
- **Config-driven** — storage, embedder, and LLM should all be swappable without code changes
- **Self-hosted first** — cloud options are fine to add, but self-hosted must always work well

## Adding a New Backend

### Storage backend

Implement the `StorageProvider` interface in `src/storage/`. See `src/storage/sqlite.ts` for reference. Export it from `src/storage/index.ts` and add it to the provider factory.

### Embedder

Implement the `Embedder` interface in `src/embedders/`. See `src/embedders/ollama.ts` for reference.

### LLM Extractor

Implement the `LLMExtractor` interface in `src/extractors/`. Must return an array of fact strings given a conversation.

## Code Style

- TypeScript
- No implicit `any`
- Errors should be informative — include context about what was being attempted
- Async/await throughout, no callbacks

## Tests

All new backends need tests. Use the shared test suite in `tests/backends/` — implement the standard fixture and your backend gets tested automatically.

## Pull Request Checklist

- [ ] Tests pass (`npm test`)
- [ ] New backend has tests
- [ ] README updated if config options changed
- [ ] No new telemetry or phone-home behaviour introduced
- [ ] Dependencies justified in PR description

## Code of Conduct

Be decent. That's it.
