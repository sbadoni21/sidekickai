// preload.ts - FIXED: Single contextBridge.exposeInMainWorld call

import { contextBridge, ipcRenderer } from "electron"

type MeetingAudioSource = "user" | "interviewer"

// Meeting-related types
interface MeetingNote {
  timestamp: number;
  speaker: string;
  type: string;
  content: string;
  tags: string[];
}

interface MeetingTranscript {
  timestamp: number;
  text: string;
  source?: MeetingAudioSource;
}

interface MeetingSummary {
  keyPoints: string[];
  decisions: string[];
  actionItems: string[];
  participants: string[];
  nextSteps: string[];
}

interface MindMapNode {
  id: string;
  label: string;
  children?: MindMapNode[];
}

interface LiveTranscriptPayload {
  text: string;
  source: MeetingAudioSource;
}

interface MeetingSttStatus {
  provider: string | null;
  providerChain: string[];
  providerIndex: number;
  reconnectAttempts: number;
  reconnectCount: number;
  fallbackCount: number;
  queueHighWaterMark: number;
  droppedAudioChunks: number;
  avgSttLatencyMs: number;
}

type MeetingSttProvider = "auto" | "elevenlabs" | "google" | "groq" | "puter"

interface MeetingStartOptions {
  sttProvider?: MeetingSttProvider
  sttProviderChain?: string[]
}

interface PuterTranscribeRequestPayload {
  requestId: string
  audioBase64: string
  mimeType: string
  source: MeetingAudioSource
}

interface Meeting {
  id: string;
  title: string;
  startTime: number;
  endTime?: number;
  isRecording: boolean;
  isPaused: boolean;
  notes: MeetingNote[];
  transcripts: MeetingTranscript[];
  analytics?: any;
  summary?: MeetingSummary;
  mindMap?: MindMapNode;
}

// Types for the exposed Electron API
interface ElectronAPI {
  updateContentDimensions: (dimensions: {
    width: number
    height: number
  }) => Promise<void>
  getScreenshots: () => Promise<Array<{ path: string; preview: string }>>
  deleteScreenshot: (
    path: string
  ) => Promise<{ success: boolean; error?: string }>
  onScreenshotTaken: (
    callback: (data: { path: string; preview: string }) => void
  ) => () => void
  
  onSolutionsReady: (callback: (solutions: string) => void) => () => void
  onResetView: (callback: () => void) => () => void
  onSolutionStart: (callback: () => void) => () => void
  onDebugStart: (callback: () => void) => () => void
  onDebugSuccess: (callback: (data: any) => void) => () => void
  onSolutionError: (callback: (error: string) => void) => () => void
  onProcessingNoScreenshots: (callback: () => void) => () => void
  onProblemExtracted: (callback: (data: any) => void) => () => void
  onSolutionSuccess: (callback: (data: any) => void) => () => void

  onUnauthorized: (callback: () => void) => () => void
  onDebugError: (callback: (error: string) => void) => () => void
  takeScreenshot: () => Promise<void>
  moveWindowLeft: () => Promise<void>
  moveWindowRight: () => Promise<void>
  moveWindowUp: () => Promise<void>
  moveWindowDown: () => Promise<void>
  resizeWindowBy: (payload: { deltaWidth: number; deltaHeight: number }) => Promise<void>
  analyzeAudioFromBase64: (data: string, mimeType: string) => Promise<{ text: string; timestamp: number }>
  analyzeAudioFile: (path: string) => Promise<{ text: string; timestamp: number }>
  analyzeImageFile: (path: string) => Promise<void>
  quitApp: () => Promise<void>
  getIncognitoMode: () => Promise<{ enabled: boolean }>
  setIncognitoMode: (enabled: boolean) => Promise<{ success: boolean; enabled: boolean }>
  toggleIncognitoMode: () => Promise<{ success: boolean; enabled: boolean }>
  onIncognitoModeChanged: (callback: (enabled: boolean) => void) => () => void
  
  // LLM Model Management
  getCurrentLlmConfig: () => Promise<{ provider: "ollama" | "groq"; model: string; isOllama: boolean }>
  getAvailableOllamaModels: () => Promise<string[]>
  switchToOllama: (model?: string, url?: string) => Promise<{ success: boolean; error?: string }>
  switchToGroq: (apiKey?: string) => Promise<{ success: boolean; error?: string }>
  switchToGemini: (apiKey?: string) => Promise<{ success: boolean; error?: string }>
  testLlmConnection: () => Promise<{ success: boolean; error?: string }>
  getRuntimeSecretsStatus: () => Promise<{
    groqApiKeyConfigured: boolean
    elevenLabsApiKeyConfigured: boolean
  }>
  setRuntimeSecrets: (payload: {
    groqApiKey?: string
    elevenLabsApiKey?: string
  }) => Promise<{
    success: boolean
    status?: {
      groqApiKeyConfigured: boolean
      elevenLabsApiKeyConfigured: boolean
    }
    error?: string
  }>
  fetchUrlContent: (url: string) => Promise<{
    success: boolean
    url?: string
    title?: string
    content?: string
    truncated?: boolean
    source?: "direct" | "reader-proxy" | "browser-render" | "direct-lite"
    error?: string
  }>
  extractDocumentText: (filePath: string, fileName?: string) => Promise<{
    success: boolean
    content?: string
    error?: string
  }>
  extractDocumentTextFromUpload: (fileName: string, base64: string) => Promise<{
    success: boolean
    content?: string
    error?: string
  }>
  
  // Audio Streaming API
  audio: {
    sendPCM: (buffer: ArrayBuffer, source?: MeetingAudioSource) => void;
  };
     
  
  // Meeting Assistant API
  meeting: {
    start: (title: string, sources?: MeetingAudioSource[], options?: MeetingStartOptions) => Promise<{ success: boolean; meetingId?: string; provider?: string; error?: string }>;
    pause: () => Promise<{ success: boolean; error?: string }>;
    resume: () => Promise<{ success: boolean; error?: string }>;
    stop: () => Promise<{ success: boolean; meeting?: Meeting; error?: string }>;
    transcribeChunk: (audioBase64: string, mimeType: string) => Promise<{ success: boolean; transcript?: string; error?: string }>;
    respondPuterTranscribe: (
      requestId: string,
      payload: { success: boolean; transcript?: string; error?: string }
    ) => Promise<{ success: boolean; error?: string }>;
    getCurrent: () => Promise<{ success: boolean; meeting?: Meeting; error?: string }>;
    getSttStatus: () => Promise<{ success: boolean; status?: MeetingSttStatus; error?: string }>;
    updateAnalytics: (payload: Record<string, unknown>) => Promise<{ success: boolean; error?: string }>;
    onMindMapUpdated: (callback: (mindMap: MindMapNode) => void) => () => void;
    onNoteAdded: (callback: (note: MeetingNote) => void) => () => void;
    onTranscriptAdded: (callback: (transcript: MeetingTranscript) => void) => () => void;
    onTranscript: (callback: (payload: string | LiveTranscriptPayload) => void) => () => void;
    onPartial: (callback: (payload: string | LiveTranscriptPayload) => void) => () => void;
    onError: (callback: (payload: { source: MeetingAudioSource; message: string }) => void) => () => void;
    onSttStatus: (callback: (payload: MeetingSttStatus & { event?: string; detail?: string }) => void) => () => void;
    onPuterTranscribeRequest: (callback: (payload: PuterTranscribeRequestPayload) => void) => () => void;
  };
  
  invoke: (channel: string, ...args: any[]) => Promise<any>
}

export const PROCESSING_EVENTS = {
  //global states
  UNAUTHORIZED: "procesing-unauthorized",
  NO_SCREENSHOTS: "processing-no-screenshots",

  //states for generating the initial solution
  INITIAL_START: "initial-start",
  PROBLEM_EXTRACTED: "problem-extracted",
  SOLUTION_SUCCESS: "solution-success",
  INITIAL_SOLUTION_ERROR: "solution-error",

  //states for processing the debugging
  DEBUG_START: "debug-start",
  DEBUG_SUCCESS: "debug-success",
  DEBUG_ERROR: "debug-error"
} as const

export const MEETING_EVENTS = {
  MINDMAP_UPDATED: "meeting:mindmap-updated",
  NOTE_ADDED: "meeting:note-added",
  TRANSCRIPT_ADDED: "meeting:transcript-added",
  TRANSCRIPT: "meeting:transcript",
  PARTIAL: "meeting:partial",
  ERROR: "meeting:error",
  STT_STATUS: "meeting:stt-status",
  PUTER_TRANSCRIBE_REQUEST: "meeting:puter-transcribe-request",
} as const

export const APP_EVENTS = {
  INCOGNITO_MODE_CHANGED: "app:incognito-mode",
} as const

// SINGLE contextBridge.exposeInMainWorld call with ALL APIs merged
contextBridge.exposeInMainWorld("electronAPI", {
  // Screenshot & Window Management
  updateContentDimensions: (dimensions: { width: number; height: number }) =>
    ipcRenderer.invoke("update-content-dimensions", dimensions),
  takeScreenshot: () => ipcRenderer.invoke("take-screenshot"),
  getScreenshots: () => ipcRenderer.invoke("get-screenshots"),
  deleteScreenshot: (path: string) =>
    ipcRenderer.invoke("delete-screenshot", path),

  // Window Movement
  moveWindowLeft: () => ipcRenderer.invoke("move-window-left"),
  moveWindowRight: () => ipcRenderer.invoke("move-window-right"),
  moveWindowUp: () => ipcRenderer.invoke("move-window-up"),
  moveWindowDown: () => ipcRenderer.invoke("move-window-down"),
  resizeWindowBy: (payload: { deltaWidth: number; deltaHeight: number }) =>
    ipcRenderer.invoke("resize-window-by", payload),

  // Audio & Image Analysis
  analyzeAudioFromBase64: (data: string, mimeType: string) => 
    ipcRenderer.invoke("analyze-audio-base64", data, mimeType),
  analyzeAudioFile: (path: string) => 
    ipcRenderer.invoke("analyze-audio-file", path),
  analyzeImageFile: (path: string) => 
    ipcRenderer.invoke("analyze-image-file", path),

  // App Control
  quitApp: () => ipcRenderer.invoke("quit-app"),
  getIncognitoMode: () => ipcRenderer.invoke("get-incognito-mode"),
  setIncognitoMode: (enabled: boolean) => ipcRenderer.invoke("set-incognito-mode", enabled),
  toggleIncognitoMode: () => ipcRenderer.invoke("toggle-incognito-mode"),

  // Event listeners for screenshots
  onScreenshotTaken: (
    callback: (data: { path: string; preview: string }) => void
  ) => {
    const subscription = (_: any, data: { path: string; preview: string }) =>
      callback(data)
    ipcRenderer.on("screenshot-taken", subscription)
    return () => {
      ipcRenderer.removeListener("screenshot-taken", subscription)
    }
  },

  // Event listeners for solutions
  onSolutionsReady: (callback: (solutions: string) => void) => {
    const subscription = (_: any, solutions: string) => callback(solutions)
    ipcRenderer.on("solutions-ready", subscription)
    return () => {
      ipcRenderer.removeListener("solutions-ready", subscription)
    }
  },

  onResetView: (callback: () => void) => {
    const subscription = () => callback()
    ipcRenderer.on("reset-view", subscription)
    return () => {
      ipcRenderer.removeListener("reset-view", subscription)
    }
  },
  
  onSolutionStart: (callback: () => void) => {
    const subscription = () => callback()
    ipcRenderer.on(PROCESSING_EVENTS.INITIAL_START, subscription)
    return () => {
      ipcRenderer.removeListener(PROCESSING_EVENTS.INITIAL_START, subscription)
    }
  },

  onDebugStart: (callback: () => void) => {
    const subscription = () => callback()
    ipcRenderer.on(PROCESSING_EVENTS.DEBUG_START, subscription)
    return () => {
      ipcRenderer.removeListener(PROCESSING_EVENTS.DEBUG_START, subscription)
    }
  },

  onDebugSuccess: (callback: (data: any) => void) => {
    const subscription = (_: any, data: any) => callback(data)
    ipcRenderer.on("debug-success", subscription)
    return () => {
      ipcRenderer.removeListener("debug-success", subscription)
    }
  },

  onDebugError: (callback: (error: string) => void) => {
    const subscription = (_: any, error: string) => callback(error)
    ipcRenderer.on(PROCESSING_EVENTS.DEBUG_ERROR, subscription)
    return () => {
      ipcRenderer.removeListener(PROCESSING_EVENTS.DEBUG_ERROR, subscription)
    }
  },

  onSolutionError: (callback: (error: string) => void) => {
    const subscription = (_: any, error: string) => callback(error)
    ipcRenderer.on(PROCESSING_EVENTS.INITIAL_SOLUTION_ERROR, subscription)
    return () => {
      ipcRenderer.removeListener(
        PROCESSING_EVENTS.INITIAL_SOLUTION_ERROR,
        subscription
      )
    }
  },

  onProcessingNoScreenshots: (callback: () => void) => {
    const subscription = () => callback()
    ipcRenderer.on(PROCESSING_EVENTS.NO_SCREENSHOTS, subscription)
    return () => {
      ipcRenderer.removeListener(PROCESSING_EVENTS.NO_SCREENSHOTS, subscription)
    }
  },

  onProblemExtracted: (callback: (data: any) => void) => {
    const subscription = (_: any, data: any) => callback(data)
    ipcRenderer.on(PROCESSING_EVENTS.PROBLEM_EXTRACTED, subscription)
    return () => {
      ipcRenderer.removeListener(
        PROCESSING_EVENTS.PROBLEM_EXTRACTED,
        subscription
      )
    }
  },

  onSolutionSuccess: (callback: (data: any) => void) => {
    const subscription = (_: any, data: any) => callback(data)
    ipcRenderer.on(PROCESSING_EVENTS.SOLUTION_SUCCESS, subscription)
    return () => {
      ipcRenderer.removeListener(
        PROCESSING_EVENTS.SOLUTION_SUCCESS,
        subscription
      )
    }
  },

  onUnauthorized: (callback: () => void) => {
    const subscription = () => callback()
    ipcRenderer.on(PROCESSING_EVENTS.UNAUTHORIZED, subscription)
    return () => {
      ipcRenderer.removeListener(PROCESSING_EVENTS.UNAUTHORIZED, subscription)
    }
  },

  onIncognitoModeChanged: (callback: (enabled: boolean) => void) => {
    const subscription = (_: any, enabled: boolean) => callback(Boolean(enabled))
    ipcRenderer.on(APP_EVENTS.INCOGNITO_MODE_CHANGED, subscription)
    return () => {
      ipcRenderer.removeListener(APP_EVENTS.INCOGNITO_MODE_CHANGED, subscription)
    }
  },
  
  // LLM Model Management
  getCurrentLlmConfig: () => ipcRenderer.invoke("get-current-llm-config"),
  getAvailableOllamaModels: () => ipcRenderer.invoke("get-available-ollama-models"),
  switchToOllama: (model?: string, url?: string) => ipcRenderer.invoke("switch-to-ollama", model, url),
  switchToGroq: (apiKey?: string) => ipcRenderer.invoke("switch-to-groq", apiKey),
  switchToGemini: (apiKey?: string) => ipcRenderer.invoke("switch-to-gemini", apiKey),
  testLlmConnection: () => ipcRenderer.invoke("test-llm-connection"),
  getRuntimeSecretsStatus: () => ipcRenderer.invoke("get-runtime-secrets-status"),
  setRuntimeSecrets: (payload: { groqApiKey?: string; elevenLabsApiKey?: string }) =>
    ipcRenderer.invoke("set-runtime-secrets", payload),
  fetchUrlContent: (url: string) => ipcRenderer.invoke("workspace:fetch-url-content", url),
  extractDocumentText: (filePath: string, fileName?: string) =>
    ipcRenderer.invoke("workspace:extract-document-text", { filePath, fileName }),
  extractDocumentTextFromUpload: (fileName: string, base64: string) =>
    ipcRenderer.invoke("workspace:extract-document-upload", { fileName, base64 }),

  // Audio Streaming API
  audio: {
    sendPCM: (buffer: ArrayBuffer, source: MeetingAudioSource = "user") => {
      ipcRenderer.send("audio:pcm", { buffer, source })
    },
  },

  // Meeting Assistant API - ALL METHODS IN ONE OBJECT
  meeting: {
    // IPC Invoke methods
    start: (title: string, sources?: MeetingAudioSource[], options?: MeetingStartOptions) => 
      ipcRenderer.invoke("meeting:start", title, sources, options),

    pause: () => 
      ipcRenderer.invoke("meeting:pause"),

    resume: () => 
      ipcRenderer.invoke("meeting:resume"),

    stop: () => 
      ipcRenderer.invoke("meeting:stop"),

    transcribeChunk: (audioBase64: string, mimeType: string) => 
      ipcRenderer.invoke("meeting:transcribe-chunk", audioBase64, mimeType),

    respondPuterTranscribe: (
      requestId: string,
      payload: { success: boolean; transcript?: string; error?: string }
    ) =>
      ipcRenderer.invoke("meeting:puter-transcribe-response", {
        requestId,
        ...payload
      }),

    getCurrent: () => 
      ipcRenderer.invoke("meeting:get-current"),

    getSttStatus: () =>
      ipcRenderer.invoke("meeting:get-stt-status"),

    updateAnalytics: (payload: Record<string, unknown>) =>
      ipcRenderer.invoke("meeting:update-analytics", payload),

    // Event listeners
    onMindMapUpdated: (callback: (mindMap: MindMapNode) => void) => {
      const subscription = (_: any, mindMap: MindMapNode) => callback(mindMap)
      ipcRenderer.on(MEETING_EVENTS.MINDMAP_UPDATED, subscription)
      return () => {
        ipcRenderer.removeListener(MEETING_EVENTS.MINDMAP_UPDATED, subscription)
      }
    },

    onNoteAdded: (callback: (note: MeetingNote) => void) => {
      const subscription = (_: any, note: MeetingNote) => callback(note)
      ipcRenderer.on(MEETING_EVENTS.NOTE_ADDED, subscription)
      return () => {
        ipcRenderer.removeListener(MEETING_EVENTS.NOTE_ADDED, subscription)
      }
    },

    onTranscriptAdded: (callback: (transcript: MeetingTranscript) => void) => {
      const subscription = (_: any, transcript: MeetingTranscript) => callback(transcript)
      ipcRenderer.on(MEETING_EVENTS.TRANSCRIPT_ADDED, subscription)
      return () => {
        ipcRenderer.removeListener(MEETING_EVENTS.TRANSCRIPT_ADDED, subscription)
      }
    },

    // Streaming transcription listeners
    onTranscript: (callback: (payload: string | LiveTranscriptPayload) => void) => {
      const subscription = (_: any, payload: string | LiveTranscriptPayload) => callback(payload)
      ipcRenderer.on(MEETING_EVENTS.TRANSCRIPT, subscription)
      return () => {
        ipcRenderer.removeListener(MEETING_EVENTS.TRANSCRIPT, subscription)
      }
    },

    onPartial: (callback: (payload: string | LiveTranscriptPayload) => void) => {
      const subscription = (_: any, payload: string | LiveTranscriptPayload) => callback(payload)
      ipcRenderer.on(MEETING_EVENTS.PARTIAL, subscription)
      return () => {
        ipcRenderer.removeListener(MEETING_EVENTS.PARTIAL, subscription)
      }
    },

    onError: (callback: (payload: { source: MeetingAudioSource; message: string }) => void) => {
      const subscription = (
        _: any,
        payload: { source?: MeetingAudioSource; message?: string }
      ) => {
        callback({
          source: payload?.source === "interviewer" ? "interviewer" : "user",
          message: payload?.message || "Unknown STT error",
        })
      }
      ipcRenderer.on(MEETING_EVENTS.ERROR, subscription)
      return () => {
        ipcRenderer.removeListener(MEETING_EVENTS.ERROR, subscription)
      }
    },

    onSttStatus: (
      callback: (payload: MeetingSttStatus & { event?: string; detail?: string }) => void
    ) => {
      const subscription = (
        _: any,
        payload: Partial<MeetingSttStatus> & { event?: string; detail?: string }
      ) => {
        callback({
          provider: typeof payload?.provider === "string" ? payload.provider : null,
          providerChain: Array.isArray(payload?.providerChain)
            ? payload.providerChain.map(String)
            : [],
          providerIndex:
            typeof payload?.providerIndex === "number" ? payload.providerIndex : 0,
          reconnectAttempts:
            typeof payload?.reconnectAttempts === "number"
              ? payload.reconnectAttempts
              : 0,
          reconnectCount:
            typeof payload?.reconnectCount === "number" ? payload.reconnectCount : 0,
          fallbackCount:
            typeof payload?.fallbackCount === "number" ? payload.fallbackCount : 0,
          queueHighWaterMark:
            typeof payload?.queueHighWaterMark === "number"
              ? payload.queueHighWaterMark
              : 0,
          droppedAudioChunks:
            typeof payload?.droppedAudioChunks === "number"
              ? payload.droppedAudioChunks
              : 0,
          avgSttLatencyMs:
            typeof payload?.avgSttLatencyMs === "number" ? payload.avgSttLatencyMs : 0,
          event: payload?.event,
          detail: payload?.detail
        })
      }
      ipcRenderer.on(MEETING_EVENTS.STT_STATUS, subscription)
      return () => {
        ipcRenderer.removeListener(MEETING_EVENTS.STT_STATUS, subscription)
      }
    },

    onPuterTranscribeRequest: (
      callback: (payload: PuterTranscribeRequestPayload) => void
    ) => {
      const subscription = (_: any, payload: Partial<PuterTranscribeRequestPayload>) => {
        callback({
          requestId: String(payload?.requestId || ""),
          audioBase64: String(payload?.audioBase64 || ""),
          mimeType: String(payload?.mimeType || "audio/webm"),
          source: payload?.source === "interviewer" ? "interviewer" : "user"
        })
      }
      ipcRenderer.on(MEETING_EVENTS.PUTER_TRANSCRIBE_REQUEST, subscription)
      return () => {
        ipcRenderer.removeListener(MEETING_EVENTS.PUTER_TRANSCRIBE_REQUEST, subscription)
      }
    }
  },
  
  // Generic invoke for any IPC call
  invoke: (channel: string, ...args: any[]) => ipcRenderer.invoke(channel, ...args)
} as ElectronAPI)

// Export types for use in renderer
export type { 
  ElectronAPI, 
  Meeting, 
  MeetingNote, 
  MeetingTranscript, 
  MeetingSummary, 
  MindMapNode 
}
