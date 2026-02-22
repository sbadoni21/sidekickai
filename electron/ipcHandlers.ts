// ipcHandlers.ts

import { ipcMain, app } from "electron"
import { AppState } from "./main"
import {
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
        const transcript = await transcribeAudioBase64(wavBase64, "audio/wav", {
          provider: activeChunkProvider,
          providerChain: providerChain.slice(providerChainIndex),
          allowFallback: true
        })
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


  // Meeting Handlers
  ipcMain.handle("meeting:start", async (event, title: string, sources?: MeetingAudioSource[]) => {
    try {
      stopAllStt()

      providerChain = resolveSttProviderChain(resolveSttProvider())
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
  })

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
      const transcript = await transcribeAudioBase64(audioBase64, mimeType, {
        providerChain: sttProviders,
        allowFallback: true
      })
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
    try {
      const llmHelper = appState.processingHelper.getLLMHelper();
      const models = await llmHelper.getOllamaModels();
      return models;
    } catch (error: any) {
      console.error("Error getting Ollama models:", error);
      throw error;
    }
  });

  ipcMain.handle("switch-to-ollama", async (_, model?: string, url?: string) => {
    try {
      const llmHelper = appState.processingHelper.getLLMHelper();
      await llmHelper.switchToOllama(model, url);
      return { success: true };
    } catch (error: any) {
      console.error("Error switching to Ollama:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("switch-to-groq", async (_, apiKey?: string) => {
    try {
      const llmHelper = appState.processingHelper.getLLMHelper();
      await llmHelper.switchToGroq(apiKey);
      return { success: true };
    } catch (error: any) {
      console.error("Error switching to Groq:", error);
      return { success: false, error: error.message };
    }
  });

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
