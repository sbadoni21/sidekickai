import { BrowserWindow } from "electron";
import type { MeetingAudioSource } from "./streamingSTT";

// `ws` is available at runtime via transitive dependencies.
// Use `any` here to keep electron main compilation strict without extra type packages.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Ws = require("ws") as any;
type WsSocket = any;

interface LiveTranscriptPayload {
  text: string;
  source: MeetingAudioSource;
}

interface StreamingSTTOptions {
  onFinalTranscript?: (payload: LiveTranscriptPayload) => void;
  onPartialTranscript?: (payload: LiveTranscriptPayload) => void;
  onError?: (payload: { source: MeetingAudioSource; message: string }) => void;
}

const DEFAULT_SOURCES: MeetingAudioSource[] = ["user"];
const REALTIME_ENDPOINT = "wss://api.elevenlabs.io/v1/speech-to-text/realtime";
const DEFAULT_MODEL_ID = "scribe_v2_realtime";
const DEFAULT_AUDIO_FORMAT = "pcm_16000";
const DEFAULT_LANGUAGE = "en";
const DEFAULT_COMMIT_STRATEGY = "vad";

let sockets: Partial<Record<MeetingAudioSource, WsSocket>> = {};
let activeSources = new Set<MeetingAudioSource>();
let sourceReady: Partial<Record<MeetingAudioSource, boolean>> = {};
let pendingChunks: Partial<Record<MeetingAudioSource, string[]>> = {};
let currentWindow: BrowserWindow | null = null;
let streamOptions: StreamingSTTOptions = {};
const firstPCMSeen: Partial<Record<MeetingAudioSource, boolean>> = {};

const getApiKey = (): string => (process.env.ELEVENLABS_API_KEY || "").trim();
const getModelId = (): string =>
  (process.env.ELEVENLABS_STT_REALTIME_MODEL || process.env.ELEVENLABS_STT_MODEL || DEFAULT_MODEL_ID).trim();
const getLanguage = (): string => (process.env.ELEVENLABS_STT_LANGUAGE || DEFAULT_LANGUAGE).trim();
const getAudioFormat = (): string => (process.env.ELEVENLABS_STT_AUDIO_FORMAT || DEFAULT_AUDIO_FORMAT).trim();
const getCommitStrategy = (): string =>
  (process.env.ELEVENLABS_STT_COMMIT_STRATEGY || DEFAULT_COMMIT_STRATEGY).trim();

const isAudioSource = (value: unknown): value is MeetingAudioSource =>
  value === "user" || value === "interviewer";

const normalizeSources = (sources?: MeetingAudioSource[]): MeetingAudioSource[] => {
  const requested = Array.isArray(sources) ? sources.filter(isAudioSource) : [];
  const deduped = Array.from(new Set(requested));
  return deduped.length > 0 ? deduped : DEFAULT_SOURCES;
};

const sendToRenderer = (channel: "meeting:transcript" | "meeting:partial", payload: LiveTranscriptPayload) => {
  if (!currentWindow || currentWindow.isDestroyed()) return;
  currentWindow.webContents.send(channel, payload);
};

const emitError = (source: MeetingAudioSource, message: string) => {
  streamOptions.onError?.({ source, message });
  if (!currentWindow || currentWindow.isDestroyed()) return;
  currentWindow.webContents.send("meeting:error", { source, message });
};

const extractText = (raw: any): string => {
  if (typeof raw?.text === "string") return raw.text.trim();
  if (typeof raw?.transcript === "string") return raw.transcript.trim();
  if (typeof raw?.partial_transcript?.text === "string") return raw.partial_transcript.text.trim();
  if (typeof raw?.committed_transcript?.text === "string") return raw.committed_transcript.text.trim();
  return "";
};

const handleSocketMessage = (source: MeetingAudioSource, rawData: unknown) => {
  let parsed: any;
  try {
    const payload = Buffer.isBuffer(rawData)
      ? rawData.toString("utf8")
      : typeof rawData === "string"
      ? rawData
      : Buffer.from(rawData as ArrayBuffer).toString("utf8");
    parsed = JSON.parse(payload);
  } catch {
    return;
  }

  const messageType = parsed?.message_type || parsed?.type;
  if (!messageType) return;

  if (messageType === "partial_transcript") {
    const text = extractText(parsed);
    if (!text) return;
    const payload = { text, source };
    streamOptions.onPartialTranscript?.(payload);
    sendToRenderer("meeting:partial", payload);
    return;
  }

  if (
    messageType === "committed_transcript" ||
    messageType === "committed_transcript_with_timestamps" ||
    messageType === "transcript"
  ) {
    const text = extractText(parsed);
    if (!text) return;
    const payload = { text, source };
    streamOptions.onFinalTranscript?.(payload);
    sendToRenderer("meeting:transcript", payload);
    return;
  }

  if (messageType === "error") {
    const message =
      parsed?.error?.message ||
      parsed?.message ||
      "Unknown ElevenLabs realtime STT error";
    emitError(source, message);
  }
};

const flushPendingChunks = (source: MeetingAudioSource) => {
  const ws = sockets[source];
  if (!ws || ws.readyState !== Ws.OPEN) return;
  const queue = pendingChunks[source];
  if (!queue || queue.length === 0) return;

  while (queue.length > 0) {
    const chunk = queue.shift();
    if (!chunk) continue;
    ws.send(
      JSON.stringify({
        message_type: "input_audio_chunk",
        audio_base_64: chunk,
        sample_rate: 16000,
      })
    );
  }
};

const deactivateSource = (source: MeetingAudioSource, reason: string) => {
  const ws = sockets[source];
  if (ws) {
    try {
      if (ws.readyState === Ws.OPEN) {
        ws.send(JSON.stringify({ message_type: "terminate_session" }));
      }
      ws.close();
    } catch {
      // no-op
    }
  }

  delete sockets[source];
  delete sourceReady[source];
  delete pendingChunks[source];
  activeSources.delete(source);
  console.warn(`ElevenLabs STT source deactivated (${source}): ${reason}`);
};

const createSourceSocket = (source: MeetingAudioSource): WsSocket | null => {
  const apiKey = getApiKey();
  if (!apiKey) {
    emitError(source, "ELEVENLABS_API_KEY is not configured.");
    return null;
  }

  const params = new URLSearchParams({
    model_id: getModelId(),
    language_code: getLanguage(),
    audio_format: getAudioFormat(),
    commit_strategy: getCommitStrategy(),
  });

  const ws = new Ws(`${REALTIME_ENDPOINT}?${params.toString()}`, {
    headers: {
      "xi-api-key": apiKey,
    },
  });

  ws.on("open", () => {
    sourceReady[source] = true;
    flushPendingChunks(source);
  });

  ws.on("message", (data: unknown) => {
    handleSocketMessage(source, data);
  });

  ws.on("error", (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    emitError(source, message);
    deactivateSource(source, `WebSocket error: ${message}`);
  });

  ws.on("close", (code: number, reason: Buffer) => {
    const message = `WebSocket closed (${code}) ${reason ? reason.toString() : ""}`.trim();
    emitError(source, message);
    deactivateSource(source, message);
  });

  return ws;
};

export function startElevenLabsStreamingSTT(
  win: BrowserWindow,
  sources?: MeetingAudioSource[],
  options?: StreamingSTTOptions
) {
  if (Object.keys(sockets).length > 0) {
    stopElevenLabsStreamingSTT();
  }

  currentWindow = win;
  streamOptions = options || {};

  const normalizedSources = normalizeSources(sources);
  activeSources = new Set(normalizedSources);

  Object.keys(firstPCMSeen).forEach((key) => {
    delete firstPCMSeen[key as MeetingAudioSource];
  });

  normalizedSources.forEach((source) => {
    pendingChunks[source] = [];
    sourceReady[source] = false;
    const ws = createSourceSocket(source);
    if (ws) {
      sockets[source] = ws;
    } else {
      activeSources.delete(source);
    }
  });
}

export function stopElevenLabsStreamingSTT() {
  Object.entries(sockets).forEach(([source, ws]) => {
    if (!ws) return;
    try {
      if (ws.readyState === Ws.OPEN) {
        ws.send(JSON.stringify({ message_type: "terminate_session" }));
      }
      ws.close();
    } catch {
      // no-op
    }
    delete sockets[source as MeetingAudioSource];
  });

  activeSources.clear();
  sourceReady = {};
  pendingChunks = {};
  currentWindow = null;
  streamOptions = {};
  Object.keys(firstPCMSeen).forEach((key) => {
    delete firstPCMSeen[key as MeetingAudioSource];
  });
}

export function writeElevenLabsPCM(buffer: Buffer, source: MeetingAudioSource = "user") {
  if (!buffer || buffer.length === 0) return;
  if (!activeSources.has(source)) return;

  if (!firstPCMSeen[source]) {
    firstPCMSeen[source] = true;
    console.log(`ElevenLabs STT received first PCM chunk (${source}, ${buffer.length} bytes)`);
  }

  const ws = sockets[source];
  const base64 = buffer.toString("base64");
  if (!ws || ws.readyState !== Ws.OPEN) {
    const queue = pendingChunks[source] || (pendingChunks[source] = []);
    if (queue.length >= 40) queue.shift();
    queue.push(base64);
    return;
  }

  ws.send(
    JSON.stringify({
      message_type: "input_audio_chunk",
      audio_base_64: base64,
      sample_rate: 16000,
    })
  );
}

export function getActiveElevenLabsSources(): MeetingAudioSource[] {
  return Array.from(activeSources);
}
