import { createPlugin } from "./dist/index.js"
import { readFile } from "node:fs/promises"
import { existsSync } from "node:fs"

const MEMORY_DIR = "/home/chrisc/.openclaw/workspace/memory"
const DB_PATH = "/home/chrisc/.openclaw/clawd-remember.db"
const PROCESSED_LOG = `${MEMORY_DIR}/.clawd-remember-processed.json`

// Check processed log before
let processedBefore = []
if (existsSync(PROCESSED_LOG)) {
  try {
    const raw = JSON.parse(await readFile(PROCESSED_LOG, "utf-8"))
    processedBefore = raw.processedFiles ?? []
  } catch {}
}
console.log("Processed files before:", processedBefore)

// Check DB row count before
const { SqliteStorageProvider } = await import("./dist/storage/sqlite.js")
const tmpStorage = new SqliteStorageProvider({ path: DB_PATH })
await tmpStorage.init()

const listBefore = await tmpStorage.list()
const rowsBefore = listBefore.length
console.log("DB rows before:", rowsBefore)

// Create plugin and call after_agent_turn
const plugin = createPlugin()

const context = {
  config: {
    userId: "chrisc",
    autoRecall: false,
    autoCapture: true,
    diskCapturePath: MEMORY_DIR,
    storage: {
      provider: "sqlite",
      config: { path: DB_PATH }
    },
    embedder: {
      provider: "ollama",
      config: {
        url: "http://192.168.1.85:11434",
        model: "nomic-embed-text"
      }
    },
    llm: {
      provider: "github-copilot",
      config: {
        model: "claude-sonnet-4.6",
        tokenPath: "/home/chrisc/.openclaw/credentials/github-copilot.token.json"
      }
    }
  },
  workspaceDir: "/home/chrisc/.openclaw/workspace",
  logger: {
    warn: (...args) => console.warn("[WARN]", ...args)
  }
}

console.log("\nCalling after_agent_turn hook...")
try {
  await plugin.hooks.after_agent_turn(context)
  console.log("Hook completed successfully")
} catch (err) {
  console.error("Hook error:", err)
  process.exit(1)
}

// Check processed log after
let processedAfter = []
if (existsSync(PROCESSED_LOG)) {
  try {
    const raw = JSON.parse(await readFile(PROCESSED_LOG, "utf-8"))
    processedAfter = raw.processedFiles ?? []
  } catch {}
}
const newlyProcessed = processedAfter.filter(f => !processedBefore.includes(f))
console.log("\nNewly processed files:", newlyProcessed)
console.log("test-session.md processed:", processedAfter.includes("test-session.md") ? "YES ✓" : "NO ✗")

// Check DB after
const listAfter = await tmpStorage.list()
const rowsAfter = listAfter.length
console.log("\nDB rows after:", rowsAfter)
console.log("New facts inserted:", rowsAfter - rowsBefore)

if (rowsAfter > rowsBefore) {
  // Sort by created_at desc, show new ones
  const sorted = listAfter.sort((a, b) => b.created_at.localeCompare(a.created_at))
  const newFacts = sorted.slice(0, rowsAfter - rowsBefore)
  console.log("\nExtracted facts:")
  for (const fact of newFacts) {
    console.log(" -", fact.data)
  }
} else {
  console.log("\nNo new facts found in DB")
  // Print all facts for debugging
  if (listAfter.length > 0) {
    console.log("Existing facts:")
    for (const fact of listAfter.slice(0, 5)) {
      console.log(" -", fact.data)
    }
  }
}
