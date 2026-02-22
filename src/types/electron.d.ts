type MeetingAudioSource = "user" | "interviewer"

interface MeetingNote {
  timestamp: number
  speaker: string
  type: string
  content: string
  tags: string[]
}

interface MeetingTranscript {
  timestamp: number
  text: string
  source?: MeetingAudioSource
}

interface MindMapNode {
  id: string
  label: string
  children?: MindMapNode[]
}

interface LiveTranscriptPayload {
  text: string
  source: MeetingAudioSource
}

interface MeetingSttStatus {
  provider: string | null
  providerChain: string[]
  providerIndex: number
  reconnectAttempts: number
  reconnectCount: number
  fallbackCount: number
  queueHighWaterMark: number
  droppedAudioChunks: number
  avgSttLatencyMs: number
}

interface Meeting {
  id: string
  title: string
  startTime: number
  endTime?: number
  isRecording: boolean
  isPaused: boolean
  notes: MeetingNote[]
  transcripts: MeetingTranscript[]
  analytics?: any
}

export interface ElectronAPI {
  updateContentDimensions: (dimensions: {
    width: number
    height: number
  }) => Promise<void>
  getScreenshots: () => Promise<Array<{ path: string; preview: string }>>
  deleteScreenshot: (path: string) => Promise<{ success: boolean; error?: string }>
  onScreenshotTaken: (callback: (data: { path: string; preview: string }) => void) => () => void
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
  analyzeAudioFromBase64: (data: string, mimeType: string) => Promise<{ text: string; timestamp: number }>
  analyzeAudioFile: (path: string) => Promise<{ text: string; timestamp: number }>
  getCurrentLlmConfig: () => Promise<{ provider: "ollama" | "groq"; model: string; isOllama: boolean }>
  getAvailableOllamaModels: () => Promise<string[]>
  switchToOllama: (model?: string, url?: string) => Promise<{ success: boolean; error?: string }>
  switchToGroq: (apiKey?: string) => Promise<{ success: boolean; error?: string }>
  switchToGemini: (apiKey?: string) => Promise<{ success: boolean; error?: string }>
  testLlmConnection: () => Promise<{ success: boolean; error?: string }>
  getIncognitoMode: () => Promise<{ enabled: boolean }>
  setIncognitoMode: (enabled: boolean) => Promise<{ success: boolean; enabled: boolean }>
  toggleIncognitoMode: () => Promise<{ success: boolean; enabled: boolean }>
  onIncognitoModeChanged: (callback: (enabled: boolean) => void) => () => void
  audio: {
    sendPCM: (buffer: ArrayBuffer, source?: MeetingAudioSource) => void
  }
  meeting: {
    start: (title: string, sources?: MeetingAudioSource[]) => Promise<{ success: boolean; meetingId?: string; provider?: string; error?: string }>
    pause: () => Promise<{ success: boolean; error?: string }>
    resume: () => Promise<{ success: boolean; error?: string }>
    stop: () => Promise<{ success: boolean; meeting?: Meeting; error?: string }>
    transcribeChunk: (audioBase64: string, mimeType: string) => Promise<{ success: boolean; transcript?: string; error?: string }>
    getCurrent: () => Promise<{ success: boolean; meeting?: Meeting; error?: string }>
    getSttStatus: () => Promise<{ success: boolean; status?: MeetingSttStatus; error?: string }>
    updateAnalytics: (payload: Record<string, unknown>) => Promise<{ success: boolean; error?: string }>
    onMindMapUpdated: (callback: (mindMap: MindMapNode) => void) => () => void
    onNoteAdded: (callback: (note: MeetingNote) => void) => () => void
    onTranscriptAdded: (callback: (transcript: MeetingTranscript) => void) => () => void
    onTranscript: (callback: (payload: string | LiveTranscriptPayload) => void) => () => void
    onPartial: (callback: (payload: string | LiveTranscriptPayload) => void) => () => void
    onError: (callback: (payload: { source: MeetingAudioSource; message: string }) => void) => () => void
    onSttStatus: (callback: (payload: MeetingSttStatus & { event?: string; detail?: string }) => void) => () => void
  }
  quitApp: () => Promise<void>
  invoke: (channel: string, ...args: any[]) => Promise<any>
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
} 
