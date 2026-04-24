import { createHash, randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { dirname, resolve } from "node:path"
import { mkdir } from "node:fs/promises"

import type { FactPayload } from "./types.js"

export const DEFAULT_SQLITE_PATH = "~/.openclaw/clawd-remember.db"

export function expandHomePath(input: string): string {
  if (input === "~") {
    return homedir()
  }

  if (input.startsWith("~/")) {
    return resolve(homedir(), input.slice(2))
  }

  return resolve(input)
}

export async function ensureParentDir(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
}

export function hashFact(text: string): string {
  return createHash("md5").update(text.trim()).digest("hex")
}

export function createFactPayload(
  data: string,
  userId: string,
  sessionId?: string,
  categories?: string[],
): FactPayload {
  const now = new Date().toISOString()
  return {
    id: randomUUID(),
    data: data.trim(),
    hash: hashFact(data),
    user_id: userId,
    session_id: sessionId,
    created_at: now,
    updated_at: now,
    categories: categories?.length ? categories : undefined,
  }
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise
  }

  let timeoutId: NodeJS.Timeout | undefined
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
  })

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId) {
      clearTimeout(timeoutId)
    }
  })
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) {
    return 0
  }

  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }

  if (normA === 0 || normB === 0) {
    return 0
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

export function vectorToBuffer(vector: number[]): Buffer {
  return Buffer.from(new Float32Array(vector).buffer)
}

export function bufferToVector(buffer: Buffer | Uint8Array): number[] {
  const copy = buffer instanceof Buffer ? buffer : Buffer.from(buffer)
  const view = new Float32Array(copy.buffer, copy.byteOffset, Math.floor(copy.byteLength / 4))
  return Array.from(view)
}

export function toJson(value: unknown): string {
  return JSON.stringify(value)
}
