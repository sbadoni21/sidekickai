// ipcHandlers.ts

import { ipcMain, app, BrowserWindow } from "electron"
import axios from "axios"
import path from "node:path"
import fs from "node:fs/promises"
import { execFile } from "node:child_process"
import { AppState } from "./main"
import {
  applyRuntimeSecretsToEnv,
  getRuntimeSecretsStatus,
  saveRuntimeSecrets
} from "./runtimeSecrets"
import {
  isSttProvider,
  transcribeAudioBase64,
  resolveSttProvider,
  resolveSttProviderChain,
  type SttProvider
} from "./speechToText"
import {
  startStreamingSTT as startGoogleStreamingSTT,
  stopStreamingSTT as stopGoogleStreamingSTT,
  writePCM as writeGooglePCM,
  getActiveStreamingSources,
  type MeetingAudioSource,
} from '../main/speech/streamingSTT';
import {
  startElevenLabsStreamingSTT,
  stopElevenLabsStreamingSTT,
  writeElevenLabsPCM,
  getActiveElevenLabsSources,
} from "../main/speech/elevenlabsRealtimeSTT";

interface AudioPCMEventPayload {
  buffer: ArrayBuffer | Buffer | Uint8Array;
  source?: MeetingAudioSource;
}

const isAudioSource = (value: unknown): value is MeetingAudioSource =>
  value === "user" || value === "interviewer";

const isPCMWrapperPayload = (payload: unknown): payload is AudioPCMEventPayload => {
  if (!payload || typeof payload !== "object") return false;
  if (Buffer.isBuffer(payload)) return false;
  if (payload instanceof Uint8Array) return false;
  if (payload instanceof ArrayBuffer) return false;
  return "buffer" in payload;
};

const normalizePCMBuffer = (payload: unknown): Buffer | null => {
  if (Buffer.isBuffer(payload)) return payload;
  if (payload instanceof Uint8Array) return Buffer.from(payload);
  if (payload instanceof ArrayBuffer) return Buffer.from(new Uint8Array(payload));
  if (
    payload &&
    typeof payload === "object" &&
    "type" in payload &&
    "data" in payload &&
    (payload as { type?: unknown }).type === "Buffer" &&
    Array.isArray((payload as { data?: unknown }).data)
  ) {
    return Buffer.from((payload as { data: number[] }).data);
  }
  return null;
};

const PCM_SAMPLE_RATE_HZ = 16_000
const PCM_CHANNELS = 1
const PCM_BITS_PER_SAMPLE = 16
const PCM_BYTES_PER_SAMPLE = PCM_BITS_PER_SAMPLE / 8

const readPositiveInt = (
  value: string | undefined,
  fallback: number,
  min: number,
  max: number
): number => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.floor(parsed)))
}

const dedupeSources = (sources?: MeetingAudioSource[]): MeetingAudioSource[] => {
  if (!Array.isArray(sources) || sources.length === 0) return ["user"]
  const normalized = Array.from(new Set(sources.filter(isAudioSource)))
  return normalized.length > 0 ? normalized : ["user"]
}

const buildWavBufferFromPcm = (pcm: Buffer): Buffer => {
  const byteRate = PCM_SAMPLE_RATE_HZ * PCM_CHANNELS * PCM_BYTES_PER_SAMPLE
  const blockAlign = PCM_CHANNELS * PCM_BYTES_PER_SAMPLE
  const header = Buffer.alloc(44)

  header.write("RIFF", 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write("WAVE", 8)
  header.write("fmt ", 12)
  header.writeUInt32LE(16, 16) // PCM chunk size
  header.writeUInt16LE(1, 20) // Audio format = PCM
  header.writeUInt16LE(PCM_CHANNELS, 22)
  header.writeUInt32LE(PCM_SAMPLE_RATE_HZ, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(PCM_BITS_PER_SAMPLE, 34)
  header.write("data", 36)
  header.writeUInt32LE(pcm.length, 40)

  return Buffer.concat([header, pcm])
}

const MAX_WORKSPACE_FETCH_TEXT_CHARS = 60_000
const WORKSPACE_FETCH_TIMEOUT_MS = 20_000
const WORKSPACE_READER_FETCH_TIMEOUT_MS = 25_000
const WORKSPACE_BROWSER_RENDER_TIMEOUT_MS = 30_000
const WORKSPACE_BROWSER_RENDER_SETTLE_MS = 1_200
const WORKSPACE_MIN_MEANINGFUL_CHARS = 140
const WORKSPACE_MIN_MEANINGFUL_WORDS = 24
const WORKSPACE_MIN_ACCEPTABLE_CHARS = 40
const WORKSPACE_MIN_ACCEPTABLE_WORDS = 6
const WORKSPACE_READER_PROXY_DISABLED = process.env.WORKSPACE_READER_PROXY_DISABLED === "1"
const WORKSPACE_BROWSER_FALLBACK_DISABLED = process.env.WORKSPACE_BROWSER_FALLBACK_DISABLED === "1"

const decodeHtmlEntities = (input: string): string =>
  input
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_match, code) => {
      const numeric = Number(code)
      if (!Number.isFinite(numeric)) return _match
      return String.fromCharCode(numeric)
    })
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => {
      const numeric = Number.parseInt(hex, 16)
      if (!Number.isFinite(numeric)) return _match
      return String.fromCharCode(numeric)
    })

const collapseWhitespace = (input: string): string =>
  input
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim()

const htmlToReadableText = (html: string): string => {
  const withoutScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")

  const withSoftBreaks = withoutScripts
    .replace(/<\/(p|div|section|article|h1|h2|h3|h4|h5|h6|li|tr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")

  const noTags = withSoftBreaks.replace(/<[^>]+>/g, " ")
  return collapseWhitespace(decodeHtmlEntities(noTags))
}

const stripReaderMetadata = (input: string): string => {
  const normalized = input.replace(/\r/g, "").trim()
  const marker = "Markdown Content:"
  const markerIndex = normalized.indexOf(marker)
  const body = markerIndex >= 0 ? normalized.slice(markerIndex + marker.length) : normalized
  return body
    .replace(/^Title:\s.*\n/gi, "")
    .replace(/^URL Source:\s.*\n/gi, "")
    .replace(/^Published Time:\s.*\n/gi, "")
    .trim()
}

const extractMetaDescription = (html: string): string => {
  const patterns = [
    /<meta[^>]+name=["']description["'][^>]*content=["']([\s\S]*?)["'][^>]*>/i,
    /<meta[^>]+content=["']([\s\S]*?)["'][^>]*name=["']description["'][^>]*>/i,
    /<meta[^>]+property=["']og:description["'][^>]*content=["']([\s\S]*?)["'][^>]*>/i,
    /<meta[^>]+content=["']([\s\S]*?)["'][^>]*property=["']og:description["'][^>]*>/i
  ]
  for (const pattern of patterns) {
    const match = html.match(pattern)
    if (!match?.[1]) continue
    const value = collapseWhitespace(decodeHtmlEntities(match[1]))
    if (value) return value
  }
  return ""
}

const decodeJsonEscapedString = (value: string): string => {
  if (!value) return ""
  try {
    const decoded = JSON.parse(`"${value.replace(/"/g, '\\"')}"`)
    return collapseWhitespace(decodeHtmlEntities(String(decoded)))
  } catch {
    return collapseWhitespace(
      decodeHtmlEntities(
        value
          .replace(/\\n/g, "\n")
          .replace(/\\r/g, "")
          .replace(/\\t/g, " ")
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, "\\")
      )
    )
  }
}

const extractTextFromStructuredJson = (html: string): string => {
  const collected: string[] = []

  const articleBodyMatches = html.matchAll(/"articleBody"\s*:\s*"((?:\\.|[^"\\])+)"/gi)
  for (const match of articleBodyMatches) {
    const candidate = decodeJsonEscapedString(match[1] || "")
    if (candidate) collected.push(candidate)
  }

  const ldJsonMatches = html.matchAll(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  )
  for (const match of ldJsonMatches) {
    const block = (match[1] || "").trim()
    if (!block) continue
    try {
      const parsed = JSON.parse(block)
      const queue: any[] = Array.isArray(parsed) ? [...parsed] : [parsed]
      while (queue.length > 0) {
        const node = queue.shift()
        if (!node) continue
        if (typeof node === "string") {
          if (node.length > 140) {
            collected.push(collapseWhitespace(decodeHtmlEntities(node)))
          }
          continue
        }
        if (Array.isArray(node)) {
          queue.push(...node)
          continue
        }
        if (typeof node === "object") {
          const articleBody = typeof node.articleBody === "string" ? node.articleBody : ""
          if (articleBody) {
            collected.push(collapseWhitespace(decodeHtmlEntities(articleBody)))
          }
          const description = typeof node.description === "string" ? node.description : ""
          if (description && description.length > 120) {
            collected.push(collapseWhitespace(decodeHtmlEntities(description)))
          }
          Object.values(node).forEach(value => queue.push(value))
        }
      }
    } catch {
      // Ignore malformed JSON blocks.
    }
  }

  if (collected.length === 0) return ""
  return collected
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)[0]
}

const countWords = (text: string): number => {
  if (!text) return 0
  return text
    .split(/\s+/)
    .filter(token => token.length > 0 && /[a-z0-9]/i.test(token))
    .length
}

const isMeaningfulText = (text: string): boolean => {
  const normalized = collapseWhitespace(text)
  return (
    normalized.length >= WORKSPACE_MIN_MEANINGFUL_CHARS &&
    countWords(normalized) >= WORKSPACE_MIN_MEANINGFUL_WORDS
  )
}

const isAcceptableText = (text: string): boolean => {
  const normalized = collapseWhitespace(text)
  return (
    normalized.length >= WORKSPACE_MIN_ACCEPTABLE_CHARS &&
    countWords(normalized) >= WORKSPACE_MIN_ACCEPTABLE_WORDS
  )
}

const normalizeFetchedText = (rawText: string): string => {
  const stripped = stripReaderMetadata(rawText)
  return collapseWhitespace(decodeHtmlEntities(stripped))
}

const extractTextFromResponse = (rawBody: string, contentType: string): string => {
  const normalizedContentType = String(contentType || "").toLowerCase()
  const lowerBody = rawBody.slice(0, 2048).toLowerCase()
  const looksLikeHtml =
    normalizedContentType.includes("text/html") ||
    normalizedContentType.includes("application/xhtml+xml") ||
    lowerBody.includes("<html") ||
    lowerBody.includes("<!doctype html")

  if (!looksLikeHtml) {
    return normalizeFetchedText(rawBody)
  }

  const extractedHtmlText = htmlToReadableText(rawBody)
  if (isMeaningfulText(extractedHtmlText)) {
    return extractedHtmlText
  }

  const structuredText = extractTextFromStructuredJson(rawBody)
  if (isMeaningfulText(structuredText)) {
    return structuredText
  }

  const metaDescription = extractMetaDescription(rawBody)
  if (!metaDescription) {
    if (structuredText && extractedHtmlText) {
      return collapseWhitespace(`${structuredText}\n\n${extractedHtmlText}`)
    }
    return structuredText || extractedHtmlText
  }
  if (!extractedHtmlText) {
    return structuredText ? collapseWhitespace(`${metaDescription}\n\n${structuredText}`) : metaDescription
  }

  const combined = structuredText
    ? `${metaDescription}\n\n${structuredText}\n\n${extractedHtmlText}`
    : `${metaDescription}\n\n${extractedHtmlText}`
  return collapseWhitespace(combined)
}

const titleFromUrl = (urlString: string): string => {
  try {
    const parsed = new URL(urlString)
    const parts = parsed.pathname.split("/").filter(Boolean)
    const last = parts[parts.length - 1] || parsed.hostname
    const normalized = decodeURIComponent(last)
      .replace(/[-_]+/g, " ")
      .replace(/\.[a-z0-9]+$/i, "")
      .trim()
    return normalized || parsed.hostname
  } catch {
    return "Imported URL"
  }
}

const extractHtmlTitle = (html: string, fallbackUrl: string): string => {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  if (!match?.[1]) {
    return titleFromUrl(fallbackUrl)
  }
  const normalized = collapseWhitespace(decodeHtmlEntities(match[1]))
  return normalized || titleFromUrl(fallbackUrl)
}

const fetchTextPayload = async (
  url: string,
  timeoutMs: number
): Promise<{ url: string; body: string; contentType: string }> => {
  const response = await axios.get<string>(url, {
    timeout: timeoutMs,
    responseType: "text",
    maxContentLength: 4 * 1024 * 1024,
    maxBodyLength: 4 * 1024 * 1024,
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; WorkspaceImporter/1.0)",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5"
    },
    validateStatus: status => status >= 200 && status < 400
  })

  const finalUrl = String((response.request as any)?.res?.responseUrl || url)
  const body =
    typeof response.data === "string"
      ? response.data
      : JSON.stringify(response.data)
  const contentType = String(response.headers?.["content-type"] || "").toLowerCase()

  return {
    url: finalUrl,
    body,
    contentType
  }
}

const buildReaderProxyUrls = (url: string): string[] => {
  const stripped = url.replace(/^https?:\/\//i, "")
  const candidates = [
    `https://r.jina.ai/http://${stripped}`,
    `https://r.jina.ai/${url}`
  ]
  return Array.from(new Set(candidates))
}

const fetchViaReaderProxy = async (url: string): Promise<string | null> => {
  if (WORKSPACE_READER_PROXY_DISABLED) return null
  const candidates = buildReaderProxyUrls(url)

  for (const candidate of candidates) {
    try {
      const response = await axios.get<string>(candidate, {
        timeout: WORKSPACE_READER_FETCH_TIMEOUT_MS,
        responseType: "text",
        maxContentLength: 4 * 1024 * 1024,
        maxBodyLength: 4 * 1024 * 1024,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; WorkspaceImporter/1.0)",
          Accept: "text/plain,text/markdown,text/html;q=0.9,*/*;q=0.5"
        },
        validateStatus: status => status >= 200 && status < 400
      })

      const raw =
        typeof response.data === "string"
          ? response.data
          : JSON.stringify(response.data)
      const extracted = normalizeFetchedText(raw)
      if (isMeaningfulText(extracted) || isAcceptableText(extracted)) {
        return extracted
      }
    } catch {
      // Try next reader endpoint candidate.
    }
  }

  return null
}

const trimWorkspaceText = (text: string): { content: string; truncated: boolean } => {
  const normalized = collapseWhitespace(text)
  if (normalized.length <= MAX_WORKSPACE_FETCH_TEXT_CHARS) {
    return { content: normalized, truncated: false }
  }
  return {
    content: normalized.slice(0, MAX_WORKSPACE_FETCH_TEXT_CHARS),
    truncated: true
  }
}

const WORKSPACE_TEXT_EXTENSIONS = new Set([".txt", ".md", ".csv", ".json"])
const WORKSPACE_IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".bmp",
  ".tif",
  ".tiff",
  ".heic",
  ".heif"
])
const WORKSPACE_ENHANCED_EXTENSIONS = new Set([".docx", ".pdf", ...WORKSPACE_IMAGE_EXTENSIONS])
const WORKSPACE_SUPPORTED_EXTENSIONS = new Set([
  ...WORKSPACE_TEXT_EXTENSIONS,
  ...WORKSPACE_ENHANCED_EXTENSIONS
])

const readDocxTextWithTextUtil = async (filePath: string): Promise<string> => {
  return new Promise((resolve, reject) => {
    execFile(
      "textutil",
      ["-convert", "txt", "-stdout", filePath],
      {
        maxBuffer: 12 * 1024 * 1024
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              stderr?.trim() || error.message || "textutil failed while extracting DOCX."
            )
          )
          return
        }
        resolve(String(stdout || ""))
      }
    )
  })
}

const normalizeDocxXmlText = (xml: string): string => {
  const withBreaks = xml
    .replace(/<w:p\b[^>]*>/gi, "\n")
    .replace(/<\/w:p>/gi, "\n")
    .replace(/<w:tr\b[^>]*>/gi, "\n")
    .replace(/<\/w:tr>/gi, "\n")
    .replace(/<w:br\b[^>]*\/>/gi, "\n")
    .replace(/<w:cr\b[^>]*\/>/gi, "\n")
    .replace(/<w:tab\b[^>]*\/>/gi, "\t")

  const withoutTags = withBreaks.replace(/<[^>]+>/g, " ")
  return collapseWhitespace(decodeHtmlEntities(withoutTags))
}

const readDocxTextWithUnzip = async (filePath: string): Promise<string> => {
  const documentXml = await new Promise<string>((resolve, reject) => {
    execFile(
      "unzip",
      ["-p", filePath, "word/document.xml"],
      {
        maxBuffer: 16 * 1024 * 1024
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              stderr?.trim() || error.message || "unzip failed while reading DOCX document.xml."
            )
          )
          return
        }
        resolve(String(stdout || ""))
      }
    )
  })

  return normalizeDocxXmlText(documentXml)
}

const readDocxText = async (filePath: string): Promise<string> => {
  const errors: string[] = []

  try {
    const viaTextUtil = await readDocxTextWithTextUtil(filePath)
    if (collapseWhitespace(viaTextUtil)) return viaTextUtil
    errors.push("textutil returned empty content")
  } catch (error: any) {
    errors.push(error?.message || "textutil failed")
  }

  try {
    const viaUnzip = await readDocxTextWithUnzip(filePath)
    if (collapseWhitespace(viaUnzip)) return viaUnzip
    errors.push("unzip fallback returned empty content")
  } catch (error: any) {
    errors.push(error?.message || "unzip fallback failed")
  }

  throw new Error(`Failed to read DOCX. ${errors.join(" | ")}`)
}

const readPdfTextWithPdftotext = async (filePath: string): Promise<string> => {
  return new Promise((resolve, reject) => {
    execFile(
      "pdftotext",
      ["-layout", "-q", filePath, "-"],
      {
        maxBuffer: 16 * 1024 * 1024
      },
      (error, stdout) => {
        if (error) {
          reject(error)
          return
        }
        resolve(String(stdout || ""))
      }
    )
  })
}

const readPdfTextWithMdls = async (filePath: string): Promise<string> => {
  if (process.platform !== "darwin") {
    throw new Error("PDF text extraction is not available on this OS.")
  }

  return new Promise((resolve, reject) => {
    execFile(
      "mdls",
      ["-name", "kMDItemTextContent", "-raw", filePath],
      {
        maxBuffer: 16 * 1024 * 1024
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              stderr?.trim() || error.message || "mdls failed while extracting PDF text."
            )
          )
          return
        }
        const raw = String(stdout || "").trim()
        if (!raw || raw === "(null)") {
          resolve("")
          return
        }
        resolve(raw)
      }
    )
  })
}

const readPdfText = async (filePath: string): Promise<string> => {
  try {
    const viaPdftotext = await readPdfTextWithPdftotext(filePath)
    if (collapseWhitespace(viaPdftotext)) return viaPdftotext
  } catch {
    // Fall through to mdls.
  }

  try {
    const viaMdls = await readPdfTextWithMdls(filePath)
    if (collapseWhitespace(viaMdls)) return viaMdls
  } catch {
    // Fall through to empty.
  }

  return ""
}

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => {
    setTimeout(resolve, ms)
  })

const fetchViaBrowserRender = async (
  url: string
): Promise<{ url: string; title: string; content: string } | null> => {
  if (WORKSPACE_BROWSER_FALLBACK_DISABLED) return null

  let window: BrowserWindow | null = null
  try {
    window = new BrowserWindow({
      show: false,
      width: 1200,
      height: 900,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true
      }
    })

    const loaded = await Promise.race([
      window
        .loadURL(url, {
          userAgent: "Mozilla/5.0 (compatible; WorkspaceImporter/1.0)"
        })
        .then(() => true)
        .catch(() => false),
      sleep(WORKSPACE_BROWSER_RENDER_TIMEOUT_MS).then(() => false)
    ])

    if (!loaded || !window || window.isDestroyed()) return null
    await sleep(WORKSPACE_BROWSER_RENDER_SETTLE_MS)

    const extracted = await Promise.race([
      window.webContents.executeJavaScript(
        `(() => {
          const pickText = () => {
            const selectors = ["article", "main", "[role='main']", ".content", ".article", ".slds-rich-text-editor__output", "body"];
            for (const selector of selectors) {
              const el = document.querySelector(selector);
              if (!el) continue;
              const text = String(el.innerText || "").trim();
              if (text.length > 0) return text;
            }
            return String(document.body?.innerText || "").trim();
          };
          return {
            title: String(document.title || "").trim(),
            url: String(location.href || "").trim(),
            content: pickText()
          };
        })();`,
        true
      ),
      sleep(WORKSPACE_BROWSER_RENDER_TIMEOUT_MS).then((): null => null)
    ])

    if (!extracted || typeof extracted !== "object") return null
    const title = collapseWhitespace(String((extracted as any).title || ""))
    const finalUrl = String((extracted as any).url || url).trim() || url
    const content = normalizeFetchedText(String((extracted as any).content || ""))
    if (!content) return null

    return {
      url: finalUrl,
      title: title || titleFromUrl(finalUrl),
      content
    }
  } catch {
    return null
  } finally {
    if (window && !window.isDestroyed()) {
      window.destroy()
    }
  }
}

export function initializeIpcHandlers(appState: AppState): void {
  type StreamingProvider = "google" | "elevenlabs"
  type ChunkProvider = SttProvider

  const STREAM_FLUSH_INTERVAL_MS = readPositiveInt(
    process.env.STT_STREAM_FLUSH_INTERVAL_MS,
    40,
    15,
    500
  )
  const MAX_PCM_QUEUE_CHUNKS = readPositiveInt(
    process.env.STT_MAX_QUEUE_CHUNKS,
    96,
    8,
    2048
  )
  const MAX_FLUSH_CHUNKS_PER_TICK = readPositiveInt(
    process.env.STT_MAX_FLUSH_CHUNKS_PER_TICK,
    8,
    1,
    128
  )
  const CHUNK_FALLBACK_WINDOW_MS = readPositiveInt(
    process.env.STT_CHUNK_FALLBACK_WINDOW_MS,
    2200,
    800,
    10000
  )
  const CHUNK_FALLBACK_MIN_WINDOW_MS = readPositiveInt(
    process.env.STT_CHUNK_FALLBACK_MIN_WINDOW_MS,
    900,
    300,
    8000
  )
  const CHUNK_FALLBACK_MAX_BUFFER_MS = readPositiveInt(
    process.env.STT_CHUNK_FALLBACK_MAX_BUFFER_MS,
    12000,
    1000,
    30000
  )
  const MAX_RECONNECT_ATTEMPTS = readPositiveInt(
    process.env.STT_MAX_RECONNECT_ATTEMPTS,
    3,
    0,
    12
  )
  const RECONNECT_BASE_DELAY_MS = readPositiveInt(
    process.env.STT_RECONNECT_BASE_DELAY_MS,
    500,
    150,
    10000
  )
  const RECONNECT_MAX_DELAY_MS = readPositiveInt(
    process.env.STT_RECONNECT_MAX_DELAY_MS,
    6000,
    500,
    60000
  )
  const PUTER_REQUEST_TIMEOUT_MS = readPositiveInt(
    process.env.STT_PUTER_REQUEST_TIMEOUT_MS,
    22_000,
    2_000,
    120_000
  )

  let activeStreamingProvider: StreamingProvider | null = null
  let activeChunkProvider: ChunkProvider | null = null
  let providerChain: SttProvider[] = resolveSttProviderChain()
  let providerChainIndex = 0
  let selectedSources: MeetingAudioSource[] = ["user"]

  const pcmQueues: Record<MeetingAudioSource, Buffer[]> = {
    user: [],
    interviewer: []
  }
  const chunkBuffers: Record<MeetingAudioSource, Buffer[]> = {
    user: [],
    interviewer: []
  }
  const chunkBufferBytes: Record<MeetingAudioSource, number> = {
    user: 0,
    interviewer: 0
  }

  let queueFlushTimer: NodeJS.Timeout | null = null
  let chunkFlushTimer: NodeJS.Timeout | null = null
  let reconnectTimer: NodeJS.Timeout | null = null
  let chunkTranscriptionInFlight = false
  let reconnectAttempts = 0
  let reconnectCount = 0
  let fallbackCount = 0
  let queueHighWaterMark = 0
  let droppedAudioChunks = 0
  let sttLatencySamples: number[] = []
  let lastFinalSignature = ""
  let lastFinalAt = 0
  const pendingPuterRequests = new Map<
    string,
    {
      resolve: (transcript: string) => void
      reject: (error: Error) => void
      timeout: NodeJS.Timeout
    }
  >()

  const chunkMaxBytes = Math.floor(
    (PCM_SAMPLE_RATE_HZ * PCM_BYTES_PER_SAMPLE * CHUNK_FALLBACK_MAX_BUFFER_MS) / 1000
  )
  const chunkMinBytes = Math.floor(
    (PCM_SAMPLE_RATE_HZ * PCM_BYTES_PER_SAMPLE * CHUNK_FALLBACK_MIN_WINDOW_MS) / 1000
  )

  const getMainWindow = () => appState.getMainWindow()

  const getAverageSttLatency = (): number => {
    if (sttLatencySamples.length === 0) return 0
    return (
      sttLatencySamples.reduce((total, value) => total + value, 0) /
      sttLatencySamples.length
    )
  }

  const pushSttLatencySample = (latencyMs: number) => {
    if (!Number.isFinite(latencyMs) || latencyMs < 0) return
    sttLatencySamples = [...sttLatencySamples.slice(-99), latencyMs]
  }

  const emitRenderer = (channel: string, payload: unknown) => {
    const window = getMainWindow()
    if (!window || window.isDestroyed()) return
    window.webContents.send(channel, payload)
  }

  const emitMeetingError = (source: MeetingAudioSource, message: string) => {
    emitRenderer("meeting:error", { source, message })
  }

  const emitSttStatus = (event: string, detail?: string) => {
    emitRenderer("meeting:stt-status", {
      event,
      detail,
      provider: activeStreamingProvider || activeChunkProvider || null,
      providerChain,
      providerIndex: providerChainIndex,
      reconnectAttempts,
      reconnectCount,
      fallbackCount,
      queueHighWaterMark,
      droppedAudioChunks,
      avgSttLatencyMs: getAverageSttLatency()
    })
  }

  const clearPendingPuterRequests = (reason: string) => {
    if (pendingPuterRequests.size === 0) return
    pendingPuterRequests.forEach(entry => {
      clearTimeout(entry.timeout)
      entry.reject(new Error(reason))
    })
    pendingPuterRequests.clear()
  }

  const requestPuterTranscription = (
    audioBase64: string,
    mimeType: string,
    source: MeetingAudioSource
  ): Promise<string> => {
    const mainWindow = getMainWindow()
    if (!mainWindow || mainWindow.isDestroyed()) {
      throw new Error("Renderer bridge unavailable for Puter STT")
    }

    const requestId = `puter-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`
    return new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingPuterRequests.delete(requestId)
        reject(new Error("Puter STT timeout"))
      }, PUTER_REQUEST_TIMEOUT_MS)

      pendingPuterRequests.set(requestId, { resolve, reject, timeout })
      emitRenderer("meeting:puter-transcribe-request", {
        requestId,
        audioBase64,
        mimeType,
        source
      })
    })
  }

  const transcribeSingleProvider = async (
    provider: SttProvider,
    audioBase64: string,
    mimeType: string,
    source: MeetingAudioSource
  ): Promise<string> => {
    if (provider === "puter") {
      return requestPuterTranscription(audioBase64, mimeType, source)
    }
    return transcribeAudioBase64(audioBase64, mimeType, {
      provider,
      allowFallback: false
    })
  }

  const transcribeWithProviderChain = async (
    audioBase64: string,
    mimeType: string,
    providers: SttProvider[],
    source: MeetingAudioSource
  ): Promise<{ transcript: string; provider: SttProvider }> => {
    const candidates = providers.length > 0 ? providers : [resolveSttProvider()]
    const attemptedErrors: string[] = []

    for (const provider of candidates) {
      try {
        const transcript = await transcribeSingleProvider(provider, audioBase64, mimeType, source)
        return { transcript, provider }
      } catch (error: any) {
        const message = error?.message || String(error)
        attemptedErrors.push(`${provider}: ${message}`)
      }
    }

    throw new Error(
      `STT provider chain failed (${candidates.join(" -> ")}): ${attemptedErrors.join(" | ")}`
    )
  }

  const clearPcmQueues = () => {
    pcmQueues.user = []
    pcmQueues.interviewer = []
  }

  const clearChunkBuffers = () => {
    chunkBuffers.user = []
    chunkBuffers.interviewer = []
    chunkBufferBytes.user = 0
    chunkBufferBytes.interviewer = 0
  }

  const stopQueueFlushTimer = () => {
    if (queueFlushTimer) {
      clearInterval(queueFlushTimer)
      queueFlushTimer = null
    }
  }

  const stopChunkFlushTimer = () => {
    if (chunkFlushTimer) {
      clearInterval(chunkFlushTimer)
      chunkFlushTimer = null
    }
  }

  const stopReconnectTimer = () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
  }

  const stopStreamingProvider = () => {
    if (activeStreamingProvider === "google") {
      stopGoogleStreamingSTT()
    } else if (activeStreamingProvider === "elevenlabs") {
      stopElevenLabsStreamingSTT()
    }
    activeStreamingProvider = null
  }

  const stopAllStt = () => {
    stopReconnectTimer()
    stopQueueFlushTimer()
    stopChunkFlushTimer()
    stopStreamingProvider()
    activeChunkProvider = null
    chunkTranscriptionInFlight = false
    clearPcmQueues()
    clearChunkBuffers()
    clearPendingPuterRequests("Meeting stopped")
    lastFinalSignature = ""
    lastFinalAt = 0
  }

  const ensureQueueFlushTimer = () => {
    if (queueFlushTimer) return
    queueFlushTimer = setInterval(() => {
      if (!activeStreamingProvider && !activeChunkProvider) return

      const meeting = appState.getCurrentMeeting()
      if (!meeting || !meeting.isRecording || meeting.isPaused) return

      if (activeStreamingProvider) {
        const streamingSources =
          activeStreamingProvider === "google"
            ? getActiveStreamingSources()
            : getActiveElevenLabsSources()

        if (
          selectedSources.some(source => streamingSources.includes(source)) === false &&
          reconnectAttempts <= MAX_RECONNECT_ATTEMPTS
        ) {
          emitSttStatus(
            "stream-inactive",
            `${activeStreamingProvider} stream inactive, scheduling reconnect`
          )
          scheduleReconnect("user", `${activeStreamingProvider} stream inactive`)
        }
      }

      selectedSources.forEach(source => {
        const queue = pcmQueues[source]
        if (!queue || queue.length === 0) return

        if (activeStreamingProvider === "google") {
          for (
            let count = 0;
            count < MAX_FLUSH_CHUNKS_PER_TICK && queue.length > 0;
            count += 1
          ) {
            const chunk = queue.shift()
            if (!chunk) continue
            writeGooglePCM(chunk, source)
          }
          return
        }

        if (activeStreamingProvider === "elevenlabs") {
          for (
            let count = 0;
            count < MAX_FLUSH_CHUNKS_PER_TICK && queue.length > 0;
            count += 1
          ) {
            const chunk = queue.shift()
            if (!chunk) continue
            writeElevenLabsPCM(chunk, source)
          }
          return
        }

        if (activeChunkProvider) {
          while (queue.length > 0) {
            const chunk = queue.shift()
            if (!chunk) continue
            chunkBuffers[source].push(chunk)
            chunkBufferBytes[source] += chunk.length

            while (chunkBufferBytes[source] > chunkMaxBytes && chunkBuffers[source].length > 0) {
              const dropped = chunkBuffers[source].shift()
              if (!dropped) break
              chunkBufferBytes[source] -= dropped.length
              droppedAudioChunks += 1
            }
          }
        }
      })
    }, STREAM_FLUSH_INTERVAL_MS)
  }

  const ensureChunkFlushTimer = () => {
    if (!activeChunkProvider) return
    if (chunkFlushTimer) return

    chunkFlushTimer = setInterval(async () => {
      await flushChunkFallbackTranscription(false)
    }, CHUNK_FALLBACK_WINDOW_MS)
  }

  const emitTranscriptIfUnique = (source: MeetingAudioSource, text: string) => {
    const meeting = appState.getCurrentMeeting()
    if (!meeting || meeting.isPaused || !meeting.isRecording) return

    const normalizedText = text.trim()
    if (!normalizedText) return

    const signature = `${source}:${normalizedText.toLowerCase()}`
    const now = Date.now()
    if (signature === lastFinalSignature && now - lastFinalAt < 1200) {
      return
    }
    lastFinalSignature = signature
    lastFinalAt = now

    appState.addMeetingTranscript({
      timestamp: now,
      text: normalizedText,
      source
    })
    if (!activeStreamingProvider) {
      emitRenderer("meeting:transcript", { text: normalizedText, source })
    }
  }

  const moveToNextProvider = async (reason: string): Promise<boolean> => {
    if (providerChainIndex >= providerChain.length - 1) {
      emitSttStatus("provider-chain-exhausted", reason)
      return false
    }

    providerChainIndex += 1
    fallbackCount += 1
    reconnectAttempts = 0
    emitSttStatus("provider-fallback", reason)
    return startProvider(providerChainIndex)
  }

  const handleStreamingProviderError = async (
    source: MeetingAudioSource,
    message: string
  ) => {
    emitMeetingError(source, message)
    emitSttStatus("provider-error", `${source}: ${message}`)
    scheduleReconnect(source, message)
  }

  const startProvider = async (index: number): Promise<boolean> => {
    const meeting = appState.getCurrentMeeting()
    if (!meeting || !meeting.isRecording) return false

    const provider = providerChain[index]
    if (!provider) return false

    stopStreamingProvider()
    activeChunkProvider = null
    stopChunkFlushTimer()
    stopReconnectTimer()

    const mainWindow = getMainWindow()
    if (!mainWindow && (provider === "google" || provider === "elevenlabs")) {
      emitSttStatus("provider-start-failed", `No renderer window for provider ${provider}`)
      return moveToNextProvider(`No renderer window for ${provider}`)
    }

    if (provider === "google" && mainWindow) {
      startGoogleStreamingSTT(mainWindow, selectedSources, {
        onFinalTranscript: payload => {
          emitTranscriptIfUnique(payload.source, payload.text)
        },
        onError: ({ source, message }: { source: MeetingAudioSource; message: string }): void => {
          handleStreamingProviderError(source, message).catch((): void => undefined)
        }
      })
      activeStreamingProvider = "google"
      reconnectAttempts = 0
      emitSttStatus("provider-started", "google")
      ensureQueueFlushTimer()
      return true
    }

    if (provider === "elevenlabs" && mainWindow) {
      startElevenLabsStreamingSTT(mainWindow, selectedSources, {
        onFinalTranscript: payload => {
          emitTranscriptIfUnique(payload.source, payload.text)
        },
        onError: ({ source, message }: { source: MeetingAudioSource; message: string }): void => {
          handleStreamingProviderError(source, message).catch((): void => undefined)
        }
      })
      activeStreamingProvider = "elevenlabs"
      reconnectAttempts = 0
      emitSttStatus("provider-started", "elevenlabs")
      ensureQueueFlushTimer()
      return true
    }

    activeChunkProvider = provider
    emitSttStatus("provider-started", `chunked-${provider}`)
    ensureQueueFlushTimer()
    ensureChunkFlushTimer()
    return true
  }

  const scheduleReconnect = (source: MeetingAudioSource, reason: string) => {
    if (!activeStreamingProvider) {
      emitSttStatus("reconnect-skipped", `No streaming provider active (${reason})`)
      return
    }

    if (reconnectTimer) {
      return
    }

    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      moveToNextProvider(
        `Exceeded reconnect attempts for ${activeStreamingProvider} (${reason})`
      ).catch((): void => undefined)
      return
    }

    stopReconnectTimer()
    reconnectAttempts += 1
    reconnectCount += 1

    const delayMs = Math.min(
      RECONNECT_MAX_DELAY_MS,
      RECONNECT_BASE_DELAY_MS * 2 ** Math.max(0, reconnectAttempts - 1)
    )

    reconnectTimer = setTimeout(() => {
      startProvider(providerChainIndex).catch(async () => {
        await moveToNextProvider(
          `Reconnect failed for ${activeStreamingProvider || "unknown"} (${source}: ${reason})`
        )
      })
    }, delayMs)

    emitSttStatus(
      "reconnect-scheduled",
      `${activeStreamingProvider} attempt ${reconnectAttempts} in ${delayMs}ms`
    )
  }

  const flushChunkFallbackTranscription = async (force: boolean) => {
    if (!activeChunkProvider) return
    if (chunkTranscriptionInFlight) return

    const meeting = appState.getCurrentMeeting()
    if (!meeting || !meeting.isRecording) return
    if (!force && meeting.isPaused) return

    chunkTranscriptionInFlight = true
    try {
      for (const source of selectedSources) {
        const bytes = chunkBufferBytes[source]
        if (bytes <= 0) continue
        if (!force && bytes < chunkMinBytes) continue

        const pcm = Buffer.concat(chunkBuffers[source], bytes)
        chunkBuffers[source] = []
        chunkBufferBytes[source] = 0

        const wavBase64 = buildWavBufferFromPcm(pcm).toString("base64")
        const startedAt = Date.now()
        const { transcript, provider: usedProvider } = await transcribeWithProviderChain(
          wavBase64,
          "audio/wav",
          providerChain.slice(providerChainIndex),
          source
        )
        if (usedProvider !== activeChunkProvider) {
          const previousIndex = providerChainIndex
          const nextIndex = providerChain.indexOf(usedProvider)
          activeChunkProvider = usedProvider
          if (nextIndex >= 0 && nextIndex !== previousIndex) {
            providerChainIndex = nextIndex
            if (nextIndex > previousIndex) {
              fallbackCount += nextIndex - previousIndex
            }
            emitSttStatus("provider-fallback", `chunked-${usedProvider}`)
          }
        }
        pushSttLatencySample(Date.now() - startedAt)

        if (transcript.trim()) {
          emitTranscriptIfUnique(source, transcript)
        }
      }
    } catch (error: any) {
      const message = error?.message || String(error)
      emitMeetingError("user", `Chunked STT failed: ${message}`)
      emitSttStatus("chunked-error", message)
      await moveToNextProvider(`Chunked STT failed (${message})`)
    } finally {
      chunkTranscriptionInFlight = false
    }
  }

  const enqueuePcm = (source: MeetingAudioSource, buffer: Buffer) => {
    const queue = pcmQueues[source]
    if (!queue) return

    if (queue.length >= MAX_PCM_QUEUE_CHUNKS) {
      queue.shift()
      droppedAudioChunks += 1
      if (droppedAudioChunks % 25 === 0) {
        emitSttStatus("backpressure-drop", `${droppedAudioChunks} chunks dropped`)
      }
    }

    queue.push(buffer)
    if (queue.length > queueHighWaterMark) {
      queueHighWaterMark = queue.length
    }
  }

  app.on("before-quit", () => {
    stopAllStt()
  })

  ipcMain.handle(
    "update-content-dimensions",
    async (event, { width, height }: { width: number; height: number }) => {
      if (width && height) {
        appState.setWindowDimensions(width, height)
      }
    }
  )

  ipcMain.handle("delete-screenshot", async (event, path: string) => {
    return appState.deleteScreenshot(path)
  })

  ipcMain.handle(
    "workspace:extract-document-text",
    async (
      _event,
      payload: {
        filePath?: string
        fileName?: string
      }
    ) => {
      try {
        const rawPath = String(payload?.filePath || "").trim()
        const fileName = String(payload?.fileName || "").trim()
        if (!rawPath) {
          return { success: false, error: "File path is required." }
        }

        const extension = path.extname(fileName || rawPath).toLowerCase()
        if (!WORKSPACE_SUPPORTED_EXTENSIONS.has(extension)) {
          return {
            success: false,
            error: `Unsupported file type "${extension || "unknown"}".`
          }
        }

        let content = ""
        if (extension === ".docx") {
          content = await readDocxText(rawPath)
        } else if (extension === ".pdf") {
          content = await readPdfText(rawPath)
        } else if (WORKSPACE_IMAGE_EXTENSIONS.has(extension)) {
          const imageAnalysis = await appState.processingHelper
            .getLLMHelper()
            .analyzeImageFile(rawPath)
          content = String(imageAnalysis?.text || "")
        } else {
          content = await fs.readFile(rawPath, "utf8")
        }

        const normalized = collapseWhitespace(String(content || ""))
        if (!normalized) {
          return { success: false, error: "No readable text found in the selected file." }
        }

        return {
          success: true,
          content: normalized
        }
      } catch (error: any) {
        return {
          success: false,
          error: error?.message || "Failed to extract text from file."
        }
      }
    }
  )

  ipcMain.handle(
    "workspace:extract-document-upload",
    async (
      _event,
      payload: {
        fileName?: string
        base64?: string
      }
    ) => {
      try {
        const fileName = String(payload?.fileName || "").trim()
        const base64 = String(payload?.base64 || "").trim()

        if (!fileName || !base64) {
          return { success: false, error: "File name and content are required." }
        }

        const extension = path.extname(fileName).toLowerCase()
        if (!WORKSPACE_SUPPORTED_EXTENSIONS.has(extension)) {
          return {
            success: false,
            error: `Unsupported file type "${extension || "unknown"}".`
          }
        }

        const fileBuffer = Buffer.from(base64, "base64")
        let content = ""

        if (extension === ".docx" || extension === ".pdf" || WORKSPACE_IMAGE_EXTENSIONS.has(extension)) {
          const tempDir = await fs.mkdtemp(path.join(app.getPath("temp"), "workspace-upload-"))
          const tempFilePath = path.join(tempDir, fileName.replace(/[^\w.\-]+/g, "_"))
          try {
            await fs.writeFile(tempFilePath, fileBuffer)
            if (extension === ".docx") {
              content = await readDocxText(tempFilePath)
            } else if (extension === ".pdf") {
              content = await readPdfText(tempFilePath)
            } else {
              const imageAnalysis = await appState.processingHelper
                .getLLMHelper()
                .analyzeImageFile(tempFilePath)
              content = String(imageAnalysis?.text || "")
            }
          } finally {
            await fs.rm(tempDir, { recursive: true, force: true }).catch((): null => null)
          }
        } else {
          content = fileBuffer.toString("utf8")
        }

        const normalized = collapseWhitespace(String(content || ""))
        if (!normalized) {
          return { success: false, error: "No readable text found in the selected file." }
        }

        return { success: true, content: normalized }
      } catch (error: any) {
        return {
          success: false,
          error: error?.message || "Failed to extract text from uploaded file."
        }
      }
    }
  )

  ipcMain.handle("workspace:fetch-url-content", async (_event, rawUrl: string) => {
    try {
      const url = String(rawUrl || "").trim()
      if (!url) {
        return { success: false, error: "URL is required." }
      }

      let parsed: URL
      try {
        parsed = new URL(url)
      } catch {
        return { success: false, error: "Invalid URL." }
      }

      if (!["http:", "https:"].includes(parsed.protocol)) {
        return { success: false, error: "Only http/https URLs are supported." }
      }

      const canonicalUrl = parsed.toString()
      let finalUrl = canonicalUrl
      let title = titleFromUrl(canonicalUrl)
      let directText = ""
      let directError = ""

      try {
        const direct = await fetchTextPayload(canonicalUrl, WORKSPACE_FETCH_TIMEOUT_MS)
        finalUrl = direct.url || canonicalUrl
        title = extractHtmlTitle(direct.body, finalUrl)
        directText = extractTextFromResponse(direct.body, direct.contentType)
      } catch (error: any) {
        directError = error?.message || "Direct fetch failed."
      }

      if (isMeaningfulText(directText)) {
        const trimmed = trimWorkspaceText(directText)
        return {
          success: true,
          url: finalUrl,
          title,
          content: trimmed.content,
          truncated: trimmed.truncated,
          source: "direct"
        }
      }

      const proxyText = await fetchViaReaderProxy(finalUrl)
      if (proxyText && (isMeaningfulText(proxyText) || !isAcceptableText(directText))) {
        const trimmed = trimWorkspaceText(proxyText)
        return {
          success: true,
          url: finalUrl,
          title,
          content: trimmed.content,
          truncated: trimmed.truncated,
          source: "reader-proxy"
        }
      }

      const browserRendered = await fetchViaBrowserRender(finalUrl)
      if (browserRendered?.content && (isMeaningfulText(browserRendered.content) || !isAcceptableText(directText))) {
        const trimmed = trimWorkspaceText(browserRendered.content)
        return {
          success: true,
          url: browserRendered.url || finalUrl,
          title: browserRendered.title || title,
          content: trimmed.content,
          truncated: trimmed.truncated,
          source: "browser-render"
        }
      }

      if (isAcceptableText(directText)) {
        const trimmed = trimWorkspaceText(directText)
        return {
          success: true,
          url: finalUrl,
          title,
          content: trimmed.content,
          truncated: trimmed.truncated,
          source: "direct-lite"
        }
      }

      return {
        success: false,
        error:
          "Could not extract enough readable text from this URL. " +
          (directError
            ? `Direct fetch error: ${directError}`
            : "The page may be JS-rendered or blocked by remote anti-bot rules.")
      }
    } catch (error: any) {
      const message = error?.message || String(error)
      return { success: false, error: `Fetch failed: ${message}` }
    }
  })

  ipcMain.on("audio:pcm", (_, payload: AudioPCMEventPayload | ArrayBuffer | Buffer | Uint8Array) => {
    let source: MeetingAudioSource = "user"
    let rawBuffer: unknown = payload

    if (isPCMWrapperPayload(payload)) {
      rawBuffer = payload.buffer
      if (isAudioSource(payload.source)) {
        source = payload.source
      }
    }

    const buffer = normalizePCMBuffer(rawBuffer)
    if (!buffer || buffer.length === 0) return

    const meeting = appState.getCurrentMeeting()
    if (!meeting || !meeting.isRecording || meeting.isPaused) return

    enqueuePcm(source, buffer)
  })

  ipcMain.handle(
    "meeting:puter-transcribe-response",
    async (
      _event,
      payload?: {
        requestId?: string
        success?: boolean
        transcript?: string
        error?: string
      }
    ) => {
      const requestId = String(payload?.requestId || "").trim()
      if (!requestId) {
        return { success: false, error: "Missing requestId" }
      }
      const pending = pendingPuterRequests.get(requestId)
      if (!pending) {
        return { success: false, error: "Unknown or expired requestId" }
      }

      pendingPuterRequests.delete(requestId)
      clearTimeout(pending.timeout)

      if (payload?.success) {
        const transcript = String(payload.transcript || "")
        pending.resolve(transcript)
        return { success: true }
      }

      pending.reject(new Error(String(payload?.error || "Puter transcription failed")))
      return { success: true }
    }
  )


  // Meeting Handlers
  ipcMain.handle(
    "meeting:start",
    async (
      event,
      title: string,
      sources?: MeetingAudioSource[],
      options?: {
        sttProvider?: string
        sttProviderChain?: string[]
      }
    ) => {
    try {
      stopAllStt()

      const configuredProviderRaw = String(options?.sttProvider || "")
        .trim()
        .toLowerCase()
      const preferredProvider = isSttProvider(configuredProviderRaw)
        ? configuredProviderRaw
        : resolveSttProvider()
      const requestedChain = Array.isArray(options?.sttProviderChain)
        ? Array.from(
            new Set(
              options.sttProviderChain
                .map(provider => String(provider || "").trim().toLowerCase())
                .filter(isSttProvider)
            )
          )
        : []
      if (requestedChain.length > 0) {
        const chain = requestedChain.includes(preferredProvider)
          ? [...requestedChain]
          : [preferredProvider, ...requestedChain]
        const defaults = resolveSttProviderChain(preferredProvider)
        defaults.forEach(provider => {
          if (!chain.includes(provider)) chain.push(provider)
        })
        providerChain = chain
      } else {
        providerChain = resolveSttProviderChain(preferredProvider)
      }
      providerChainIndex = 0
      reconnectAttempts = 0
      reconnectCount = 0
      fallbackCount = 0
      queueHighWaterMark = 0
      droppedAudioChunks = 0
      sttLatencySamples = []
      selectedSources = dedupeSources(sources)

      const meetingId = Date.now().toString()
      appState.setCurrentMeeting({
        id: meetingId,
        title,
        startTime: Date.now(),
        notes: [],
        transcripts: [],
        analytics: {
          transcriptSegments: [],
          detectedQuestions: [],
          answers: [],
          controls: {
            cpuMode: "balanced",
            chunkRateMs: CHUNK_FALLBACK_WINDOW_MS,
            maxChunkQueue: MAX_PCM_QUEUE_CHUNKS,
            answerThrottleMs: 1200,
            modelThrottleMs: 800,
            cloudOffload: false
          },
          performance: {
            droppedAudioChunks: 0,
            queueHighWaterMark: 0,
            reconnectCount: 0,
            fallbackCount: 0,
            avgSttLatencyMs: 0
          }
        },
        isRecording: true,
        isPaused: false,
      })

      const started = await startProvider(providerChainIndex)
      if (!started) {
        return { success: false, error: "Unable to start STT pipeline" }
      }

      emitSttStatus("meeting-started")
      return { success: true, meetingId, provider: activeStreamingProvider || activeChunkProvider }
    } catch (error: any) {
      console.error("Error starting meeting:", error)
      return { success: false, error: error.message }
    }
    }
  )

  ipcMain.handle("meeting:pause", async () => {
    try {
      const meeting = appState.getCurrentMeeting()
      if (meeting) {
        meeting.isPaused = true
        appState.setCurrentMeeting(meeting)
      }
      emitSttStatus("meeting-paused")
      return { success: true }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle("meeting:resume", async () => {
    try {
      const meeting = appState.getCurrentMeeting()
      if (meeting) {
        meeting.isPaused = false
        appState.setCurrentMeeting(meeting)
      }
      emitSttStatus("meeting-resumed")
      return { success: true }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle("meeting:stop", async () => {
    try {
      await flushChunkFallbackTranscription(true)
      stopAllStt()

      const meeting = appState.getCurrentMeeting()
      if (meeting) {
        meeting.isRecording = false
        meeting.endTime = Date.now()
        meeting.analytics = {
          ...(meeting.analytics || {}),
          transcriptSegments: meeting.analytics?.transcriptSegments || [],
          detectedQuestions: meeting.analytics?.detectedQuestions || [],
          answers: meeting.analytics?.answers || [],
          controls: meeting.analytics?.controls || {
            cpuMode: "balanced",
            chunkRateMs: CHUNK_FALLBACK_WINDOW_MS,
            maxChunkQueue: MAX_PCM_QUEUE_CHUNKS,
            answerThrottleMs: 1200,
            modelThrottleMs: 800,
            cloudOffload: false
          },
          performance: {
            ...(meeting.analytics?.performance || {}),
            droppedAudioChunks,
            queueHighWaterMark,
            reconnectCount,
            fallbackCount,
            avgSttLatencyMs: getAverageSttLatency()
          }
        }

        appState.setCurrentMeeting(null)

        emitSttStatus("meeting-stopped")
        return { success: true, meeting }
      }
      return { success: false, error: "No active meeting" }
    } catch (error: any) {
      console.error("Error stopping meeting:", error)
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle("meeting:transcribe-chunk", async (event, audioBase64: string, mimeType: string) => {
    try {
      const sttProviders = providerChain.length > 0 ? providerChain : resolveSttProviderChain()
      const meeting = appState.getCurrentMeeting()
      if (!meeting || meeting.isPaused) {
        return { success: false, error: "Meeting not active or paused" }
      }

      const startedAt = Date.now()
      const { transcript, provider: usedProvider } = await transcribeWithProviderChain(
        audioBase64,
        mimeType,
        sttProviders,
        "user"
      )
      const previousIndex = providerChainIndex
      const nextIndex = providerChain.indexOf(usedProvider)
      if (nextIndex >= 0 && nextIndex !== previousIndex) {
        providerChainIndex = nextIndex
        if (nextIndex > previousIndex) {
          fallbackCount += nextIndex - previousIndex
        }
        activeStreamingProvider = null
        activeChunkProvider = usedProvider
        emitSttStatus("provider-fallback", `chunked-${usedProvider}`)
      }
      pushSttLatencySample(Date.now() - startedAt)

      if (transcript && transcript.trim()) {
        emitTranscriptIfUnique("user", transcript)
        return { success: true, transcript }
      }

      return { success: true, transcript: "" }
    } catch (error: any) {
      console.error("Error transcribing chunk:", error)
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle("meeting:get-current", async () => {
    try {
      const meeting = appState.getCurrentMeeting()
      return { success: true, meeting }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle("meeting:get-stt-status", async () => {
    return {
      success: true,
      status: {
        provider: activeStreamingProvider || activeChunkProvider || null,
        providerChain,
        providerIndex: providerChainIndex,
        reconnectAttempts,
        reconnectCount,
        fallbackCount,
        queueHighWaterMark,
        droppedAudioChunks,
        avgSttLatencyMs: getAverageSttLatency()
      }
    }
  })

  ipcMain.handle("meeting:update-analytics", async (_, payload: Record<string, unknown>) => {
    try {
      const meeting = appState.getCurrentMeeting()
      if (!meeting) return { success: false, error: "No active meeting" }

      const currentAnalytics = (meeting as Record<string, any>).analytics || {}
      const nextAnalytics = {
        ...currentAnalytics,
        transcriptSegments: Array.isArray(payload?.transcriptSegments)
          ? payload.transcriptSegments
          : currentAnalytics.transcriptSegments || [],
        detectedQuestions: Array.isArray(payload?.detectedQuestions)
          ? payload.detectedQuestions
          : currentAnalytics.detectedQuestions || [],
        answers: Array.isArray(payload?.answers)
          ? payload.answers
          : currentAnalytics.answers || [],
        controls:
          payload?.controls && typeof payload.controls === "object"
            ? payload.controls
            : currentAnalytics.controls || {},
        performance:
          payload?.performance && typeof payload.performance === "object"
            ? payload.performance
            : currentAnalytics.performance || {}
      }

      ;(meeting as Record<string, any>).analytics = nextAnalytics
      return { success: true }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle("take-screenshot", async () => {
    try {
      const screenshotPath = await appState.takeScreenshot()
      const preview = await appState.getImagePreview(screenshotPath)
      return { path: screenshotPath, preview }
    } catch (error) {
      console.error("Error taking screenshot:", error)
      throw error
    }
  })

  ipcMain.handle("get-screenshots", async () => {
    console.log({ view: appState.getView() })
    try {
      let previews = []
      if (appState.getView() === "queue") {
        previews = await Promise.all(
          appState.getScreenshotQueue().map(async (path) => ({
            path,
            preview: await appState.getImagePreview(path)
          }))
        )
      } else {
        previews = await Promise.all(
          appState.getExtraScreenshotQueue().map(async (path) => ({
            path,
            preview: await appState.getImagePreview(path)
          }))
        )
      }
      previews.forEach((preview: any) => console.log(preview.path))
      return previews
    } catch (error) {
      console.error("Error getting screenshots:", error)
      throw error
    }
  })

  ipcMain.handle("toggle-window", async () => {
    appState.toggleMainWindow()
  })

  ipcMain.handle("reset-queues", async () => {
    try {
      appState.clearQueues()
      console.log("Screenshot queues have been cleared.")
      return { success: true }
    } catch (error: any) {
      console.error("Error resetting queues:", error)
      return { success: false, error: error.message }
    }
  })

  // IPC handler for analyzing audio from base64 data
  ipcMain.handle("analyze-audio-base64", async (event, data: string, mimeType: string) => {
    try {
      const result = await appState.processingHelper.processAudioBase64(data, mimeType)
      return result
    } catch (error: any) {
      console.error("Error in analyze-audio-base64 handler:", error)
      throw error
    }
  })

  // IPC handler for analyzing audio from file path
  ipcMain.handle("analyze-audio-file", async (event, path: string) => {
    try {
      const result = await appState.processingHelper.processAudioFile(path)
      return result
    } catch (error: any) {
      console.error("Error in analyze-audio-file handler:", error)
      throw error
    }
  })

  // IPC handler for analyzing image from file path
  ipcMain.handle("analyze-image-file", async (event, path: string) => {
    try {
      const result = await appState.processingHelper.getLLMHelper().analyzeImageFile(path)
      return result
    } catch (error: any) {
      console.error("Error in analyze-image-file handler:", error)
      throw error
    }
  })

  ipcMain.handle("gemini-chat", async (event, message: string) => {
    try {
      const result = await appState.processingHelper.getLLMHelper().chat(message);
      return result;
    } catch (error: any) {
      console.error("Error in gemini-chat handler:", error);
      throw error;
    }
  });

  ipcMain.handle("llm-chat", async (event, message: string) => {
    try {
      const result = await appState.processingHelper.getLLMHelper().chat(message);
      return result;
    } catch (error: any) {
      console.error("Error in llm-chat handler:", error);
      throw error;
    }
  });

  ipcMain.handle("quit-app", () => {
    app.quit()
  })

  ipcMain.handle("get-incognito-mode", async () => {
    return { enabled: appState.getIncognitoMode() }
  })

  ipcMain.handle("set-incognito-mode", async (_, enabled: boolean) => {
    appState.setIncognitoMode(Boolean(enabled))
    return { success: true, enabled: appState.getIncognitoMode() }
  })

  ipcMain.handle("toggle-incognito-mode", async () => {
    const enabled = appState.toggleIncognitoMode()
    return { success: true, enabled }
  })

  // Window movement handlers
  ipcMain.handle("move-window-left", async () => {
    appState.moveWindowLeft()
  })

  ipcMain.handle("move-window-right", async () => {
    appState.moveWindowRight()
  })

  ipcMain.handle("move-window-up", async () => {
    appState.moveWindowUp()
  })

  ipcMain.handle("move-window-down", async () => {
    appState.moveWindowDown()
  })

  ipcMain.handle(
    "resize-window-by",
    async (
      _event,
      payload: { deltaWidth?: number; deltaHeight?: number } = {}
    ) => {
      const deltaWidth = Number(payload.deltaWidth ?? 0)
      const deltaHeight = Number(payload.deltaHeight ?? 0)
      appState.resizeWindowBy(deltaWidth, deltaHeight)
    }
  )

  ipcMain.handle("center-and-show-window", async () => {
    appState.centerAndShowWindow()
  })

  // LLM Model Management Handlers
  ipcMain.handle("get-current-llm-config", async () => {
    try {
      const llmHelper = appState.processingHelper.getLLMHelper();
      return {
        provider: llmHelper.getCurrentProvider(),
        model: llmHelper.getCurrentModel(),
        isOllama: llmHelper.isUsingOllama()
      };
    } catch (error: any) {
      console.error("Error getting current LLM config:", error);
      throw error;
    }
  });

  ipcMain.handle("get-available-ollama-models", async () => {
    return [];
  });

  ipcMain.handle("switch-to-ollama", async (_, model?: string, url?: string) => {
    return {
      success: false,
      error: "Local model mode is disabled. Use cloud API provider."
    };
  });

  ipcMain.handle("switch-to-groq", async (_, apiKey?: string) => {
    try {
      const normalizedApiKey = String(apiKey || "").trim()
      if (normalizedApiKey) {
        saveRuntimeSecrets({ groqApiKey: normalizedApiKey })
        applyRuntimeSecretsToEnv()
      }
      const llmHelper = appState.processingHelper.getLLMHelper();
      await llmHelper.switchToGroq(normalizedApiKey || undefined);
      return { success: true };
    } catch (error: any) {
      console.error("Error switching to Groq:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("get-runtime-secrets-status", async () => {
    return getRuntimeSecretsStatus()
  })

  ipcMain.handle(
    "set-runtime-secrets",
    async (
      _,
      payload: { groqApiKey?: string; elevenLabsApiKey?: string } = {}
    ) => {
      try {
        const updates: { groqApiKey?: string; elevenLabsApiKey?: string } = {}
        if (typeof payload.groqApiKey === "string") {
          updates.groqApiKey = payload.groqApiKey
        }
        if (typeof payload.elevenLabsApiKey === "string") {
          updates.elevenLabsApiKey = payload.elevenLabsApiKey
        }

        const saved = saveRuntimeSecrets(updates)
        applyRuntimeSecretsToEnv()

        if (saved.groqApiKey) {
          const llmHelper = appState.processingHelper.getLLMHelper()
          await llmHelper.switchToGroq(saved.groqApiKey)
        }

        return { success: true, status: getRuntimeSecretsStatus() }
      } catch (error: any) {
        return {
          success: false,
          error: error?.message || "Failed to save runtime secrets."
        }
      }
    }
  )

  // Backward-compatible alias for older renderer calls.
  ipcMain.handle("switch-to-gemini", async (_, apiKey?: string) => {
    try {
      const llmHelper = appState.processingHelper.getLLMHelper();
      await llmHelper.switchToGroq(apiKey);
      return { success: true };
    } catch (error: any) {
      console.error("Error switching to Groq (alias switch-to-gemini):", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("test-llm-connection", async () => {
    try {
      const llmHelper = appState.processingHelper.getLLMHelper();
      const result = await llmHelper.testConnection();
      return result;
    } catch (error: any) {
      console.error("Error testing LLM connection:", error);
      return { success: false, error: error.message };
    }
  });
}
