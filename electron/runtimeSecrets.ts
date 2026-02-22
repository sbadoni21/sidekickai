import { app } from "electron"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export interface RuntimeSecrets {
  groqApiKey?: string
  elevenLabsApiKey?: string
}

export interface RuntimeSecretsStatus {
  groqApiKeyConfigured: boolean
  elevenLabsApiKeyConfigured: boolean
}

const RUNTIME_SECRETS_FILENAME = "runtime-secrets.json"
const FALLBACK_SECRETS_FILENAME = ".interview-coder-runtime-secrets.json"

const normalizeSecret = (value?: string | null): string | undefined => {
  const trimmed = String(value || "").trim()
  return trimmed.length > 0 ? trimmed : undefined
}

const resolveSecretsFilePath = (): string => {
  try {
    return path.join(app.getPath("userData"), RUNTIME_SECRETS_FILENAME)
  } catch {
    return path.join(os.homedir(), FALLBACK_SECRETS_FILENAME)
  }
}

const sanitizeSecrets = (value: Partial<RuntimeSecrets> | null | undefined): RuntimeSecrets => {
  const groqApiKey = normalizeSecret(value?.groqApiKey)
  const elevenLabsApiKey = normalizeSecret(value?.elevenLabsApiKey)
  const next: RuntimeSecrets = {}
  if (groqApiKey) next.groqApiKey = groqApiKey
  if (elevenLabsApiKey) next.elevenLabsApiKey = elevenLabsApiKey
  return next
}

const writeSecrets = (secrets: RuntimeSecrets): void => {
  const filePath = resolveSecretsFilePath()
  const secretCount = Object.keys(secrets).length
  if (secretCount === 0) {
    try {
      fs.rmSync(filePath, { force: true })
    } catch {
      // Ignore cleanup errors.
    }
    return
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(secrets, null, 2), "utf8")
}

export const loadRuntimeSecrets = (): RuntimeSecrets => {
  const filePath = resolveSecretsFilePath()
  try {
    if (!fs.existsSync(filePath)) return {}
    const raw = fs.readFileSync(filePath, "utf8")
    if (!raw.trim()) return {}
    const parsed = JSON.parse(raw) as Partial<RuntimeSecrets>
    return sanitizeSecrets(parsed)
  } catch {
    return {}
  }
}

export const saveRuntimeSecrets = (updates: Partial<RuntimeSecrets>): RuntimeSecrets => {
  const current = loadRuntimeSecrets()
  const next = sanitizeSecrets({
    ...current,
    ...updates
  })
  writeSecrets(next)
  return next
}

export const getRuntimeSecretsStatus = (): RuntimeSecretsStatus => {
  const secrets = loadRuntimeSecrets()
  return {
    groqApiKeyConfigured: Boolean(secrets.groqApiKey),
    elevenLabsApiKeyConfigured: Boolean(secrets.elevenLabsApiKey)
  }
}

export const applyRuntimeSecretsToEnv = (): void => {
  const secrets = loadRuntimeSecrets()

  if (!process.env.GROQ_API_KEY && secrets.groqApiKey) {
    process.env.GROQ_API_KEY = secrets.groqApiKey
  }
  if (!process.env.ELEVENLABS_API_KEY && secrets.elevenLabsApiKey) {
    process.env.ELEVENLABS_API_KEY = secrets.elevenLabsApiKey
  }
}
