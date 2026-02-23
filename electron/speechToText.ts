import fs from "fs"
import path from "path"
import axios from "axios"
import FormData from "form-data"

export type SttProvider = "groq" | "google" | "elevenlabs" | "puter"

const DEFAULT_GROQ_BASE_URL = "https://api.groq.com/openai/v1"
const DEFAULT_GROQ_STT_MODEL = "whisper-large-v3-turbo"
const DEFAULT_ELEVENLABS_BASE_URL = "https://api.elevenlabs.io"
const DEFAULT_ELEVENLABS_STT_MODEL = "scribe_v1"
const DEFAULT_PROVIDER_CHAIN: SttProvider[] = ["puter", "groq"]

export const isSttProvider = (value: string): value is SttProvider => {
  return value === "groq" || value === "google" || value === "elevenlabs" || value === "puter"
}

const isTruthy = (value?: string): boolean => {
  return (value || "").trim().toLowerCase() === "true"
}

const shouldAllowGoogleFallback = (): boolean => {
  return isTruthy(process.env.STT_ALLOW_GOOGLE_FALLBACK) || isTruthy(process.env.VITE_STT_ALLOW_GOOGLE_FALLBACK)
}

const normalizeProviderList = (rawProviders: string[]): SttProvider[] => {
  const providers = rawProviders
    .map(provider => provider.trim().toLowerCase())
    .filter(Boolean)
    .filter(isSttProvider)
  return Array.from(new Set(providers))
}

const appendFallbackProviders = (providers: SttProvider[]): SttProvider[] => {
  const includeGoogle =
    providers.includes("google") || shouldAllowGoogleFallback()
  const fallbackProviders: SttProvider[] = includeGoogle
    ? ["google", "puter", "groq", "elevenlabs"]
    : DEFAULT_PROVIDER_CHAIN

  const next = [...providers]
  fallbackProviders.forEach(provider => {
    if (!next.includes(provider)) next.push(provider)
  })
  return next
}

export const resolveSttProvider = (): SttProvider => {
  const configured = (
    process.env.STT_PROVIDER ||
    process.env.VITE_STT_PROVIDER ||
    "puter"
  )
    .trim()
    .toLowerCase()

  if (configured === "google") return "google"
  if (configured === "groq") return "groq"
  if (configured === "puter") return "puter"
  return "elevenlabs"
}

export const resolveSttProviderChain = (preferredProvider?: SttProvider): SttProvider[] => {
  const configuredChain = (
    process.env.STT_PROVIDER_CHAIN ||
    process.env.VITE_STT_PROVIDER_CHAIN ||
    ""
  )
    .trim()
    .toLowerCase()

  const configuredList = configuredChain
    ? normalizeProviderList(configuredChain.split(","))
    : []

  const preferred = preferredProvider || resolveSttProvider()
  const chain = configuredList.length > 0 ? configuredList : [preferred]
  const withPreferred = chain.includes(preferred) ? chain : [preferred, ...chain]
  return appendFallbackProviders(withPreferred)
}

const getGoogleApiKey = (): string => (process.env.GOOGLE_SPEECH_API_KEY || "").trim()
const getGroqApiKey = (): string => (process.env.GROQ_API_KEY || "").trim()
const getGroqBaseUrl = (): string =>
  (process.env.GROQ_BASE_URL || DEFAULT_GROQ_BASE_URL).trim().replace(/\/$/, "")
const getGroqSttModel = (): string =>
  (process.env.GROQ_STT_MODEL || DEFAULT_GROQ_STT_MODEL).trim()
const getElevenLabsApiKey = (): string => (process.env.ELEVENLABS_API_KEY || "").trim()
const getElevenLabsBaseUrl = (): string =>
  (process.env.ELEVENLABS_BASE_URL || DEFAULT_ELEVENLABS_BASE_URL).trim().replace(/\/$/, "")
const getElevenLabsModel = (): string =>
  (process.env.ELEVENLABS_STT_MODEL || DEFAULT_ELEVENLABS_STT_MODEL).trim()

const mimeTypeToExtension = (mimeType: string): string => {
  const normalized = (mimeType || "").toLowerCase()
  if (normalized.includes("webm")) return "webm"
  if (normalized.includes("wav")) return "wav"
  if (normalized.includes("mpeg") || normalized.includes("mp3")) return "mp3"
  if (normalized.includes("ogg")) return "ogg"
  if (normalized.includes("m4a") || normalized.includes("mp4")) return "m4a"
  return "webm"
}

const transcribeWithGoogle = async (base64: string, mimeType: string): Promise<string> => {
  const googleApiKey = getGoogleApiKey()
  if (!googleApiKey) {
    throw new Error("GOOGLE_SPEECH_API_KEY is not configured")
  }

  const encoding = mimeType.toLowerCase().includes("wav") ? "LINEAR16" : "WEBM_OPUS"
  const sampleRate = encoding === "LINEAR16" ? 16000 : 48000

  const response = await fetch(
    `https://speech.googleapis.com/v1/speech:recognize?key=${googleApiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        config: {
          encoding,
          sampleRateHertz: sampleRate,
          languageCode: "en-US",
          enableAutomaticPunctuation: true,
          model: "default",
        },
        audio: { content: base64 },
      }),
    }
  )

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Google STT HTTP ${response.status}: ${errorText}`)
  }

  const json = (await response.json()) as {
    error?: { message?: string }
    results?: Array<{ alternatives?: Array<{ transcript?: string }> }>
  }
  if (json.error?.message) {
    throw new Error(json.error.message)
  }

  const transcript =
    json.results?.map((item) => item.alternatives?.[0]?.transcript || "").join(" ").trim() || ""
  return transcript
}

const transcribeWithGroq = async (base64: string, mimeType: string): Promise<string> => {
  const groqApiKey = getGroqApiKey()
  if (!groqApiKey) {
    throw new Error("GROQ_API_KEY is not configured")
  }

  const ext = mimeTypeToExtension(mimeType)
  const audioBuffer = Buffer.from(base64, "base64")
  const form = new FormData()
  form.append("model", getGroqSttModel())
  form.append("response_format", "json")
  form.append("temperature", "0")
  form.append("language", "en")
  form.append("file", audioBuffer, {
    filename: `audio.${ext}`,
    contentType: mimeType || "audio/webm",
  })

  const url = `${getGroqBaseUrl()}/audio/transcriptions`
  const response = await axios.post(url, form, {
    headers: {
      Authorization: `Bearer ${groqApiKey}`,
      ...form.getHeaders(),
    },
    timeout: 60_000,
    maxBodyLength: Infinity,
  })

  const body = response.data as { text?: string }
  return (body?.text || "").trim()
}

const transcribeWithElevenLabs = async (base64: string, mimeType: string): Promise<string> => {
  const elevenLabsApiKey = getElevenLabsApiKey()
  if (!elevenLabsApiKey) {
    throw new Error("ELEVENLABS_API_KEY is not configured")
  }

  const ext = mimeTypeToExtension(mimeType)
  const audioBuffer = Buffer.from(base64, "base64")
  const form = new FormData()
  form.append("model_id", getElevenLabsModel())
  form.append("language_code", "en")
  form.append("file", audioBuffer, {
    filename: `audio.${ext}`,
    contentType: mimeType || "audio/webm",
  })

  const url = `${getElevenLabsBaseUrl()}/v1/speech-to-text`
  const response = await axios.post(url, form, {
    headers: {
      "xi-api-key": elevenLabsApiKey,
      ...form.getHeaders(),
    },
    timeout: 60_000,
    maxBodyLength: Infinity,
  })

  const body = response.data as { text?: string }
  return (body?.text || "").trim()
}

const transcribeWithProvider = async (
  provider: SttProvider,
  base64: string,
  mimeType: string
): Promise<string> => {
  if (provider === "google") {
    return transcribeWithGoogle(base64, mimeType)
  }
  if (provider === "elevenlabs") {
    return transcribeWithElevenLabs(base64, mimeType)
  }
  if (provider === "puter") {
    throw new Error("Puter STT requires renderer bridge and cannot run in Electron main directly")
  }
  return transcribeWithGroq(base64, mimeType)
}

export interface STTTranscribeOptions {
  provider?: SttProvider
  providerChain?: SttProvider[]
  allowFallback?: boolean
}

export async function transcribeAudioBase64(
  base64: string,
  mimeType: string = "audio/webm",
  options: STTTranscribeOptions = {}
): Promise<string> {
  const allowFallback = options.allowFallback !== false
  const explicitChain =
    Array.isArray(options.providerChain) && options.providerChain.length > 0
      ? Array.from(new Set(options.providerChain))
      : null

  const providers = allowFallback
    ? explicitChain || resolveSttProviderChain(options.provider)
    : [options.provider || resolveSttProvider()]

  const attemptedErrors: string[] = []

  for (const provider of providers) {
    try {
      return await transcribeWithProvider(provider, base64, mimeType)
    } catch (error: any) {
      const message = error?.message || String(error)
      attemptedErrors.push(`${provider}: ${message}`)
      if (!allowFallback) {
        throw new Error(`STT (${provider}) failed: ${message}`)
      }
    }
  }

  throw new Error(`STT provider chain failed (${providers.join(" -> ")}): ${attemptedErrors.join(" | ")}`)
}

export async function transcribeAudioFile(
  filePath: string,
  options: STTTranscribeOptions = {}
): Promise<string> {
  try {
    const audioBuffer = fs.readFileSync(filePath)
    const base64 = audioBuffer.toString("base64")
    const ext = path.extname(filePath).toLowerCase()
    const mimeType =
      ext === ".webm"
        ? "audio/webm"
        : ext === ".wav"
        ? "audio/wav"
        : ext === ".mp3"
        ? "audio/mp3"
        : ext === ".m4a"
        ? "audio/m4a"
        : "audio/webm"

    return transcribeAudioBase64(base64, mimeType, options)
  } catch (error: any) {
    throw new Error(`File transcription failed: ${error?.message || String(error)}`)
  }
}
