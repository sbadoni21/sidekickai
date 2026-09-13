import React, { useEffect, useRef, useState } from "react";
import { BriefcaseBusiness, MessageSquare, Mic, MicOff, Pause, Play, Terminal, X } from "lucide-react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { dracula } from "react-syntax-highlighter/dist/esm/styles/prism";
import { cleanLLMResponse, parseLLMResponse } from "../../utils/lmResponseParser";
import { getCurrentUser } from "../../lib/authStore";
import {
  DEFAULT_KNOWLEDGE_FOLDER_ID,
  loadResources,
  RESOURCE_FOLDER_TYPE_LABELS,
  UserResources
} from "../../lib/resourcesStore";
import {
  estimateAnswerQuality,
  generateFastDraftAnswer,
  generateRefinedAnswer
} from "../../lib/meetingAI/answerEngine";
import {
  buildHeuristicQuestionCandidate,
  buildQuestionUnderstanding,
  classifyQuestionIntentWithModel,
  getQuestionDetectionThreshold,
  normalizeQuestionSignature
} from "../../lib/meetingAI/questionDetection";
import {
  buildProblemMemoryContext,
  buildProblemMemoryPatchFromCandidate,
  buildScreenProblemExtractionPrompt,
  inferFrameworkFromText,
  inferMeetingIntent,
  inferLanguageFromText,
  isCodeHeavyIntent,
  mergeProblemMemory,
  normalizeFrameworkLabel,
  normalizeLanguageLabel,
  parseScreenProblemAnalysis
} from "../../lib/meetingAI/problemMemory";
import type {
  AnswerResponseMetadata,
  CodingIntent,
  MeetingRole,
  ProblemMemory
} from "../../lib/meetingAI/types";
import { buildHybridResourceContext } from "../../lib/meetingAI/ragContext";
import type {
  AnswerAnalytics,
  CodingQuestionUnderstanding,
  CpuMode,
  DetectedQuestionAnalytics,
  MeetingAnalytics,
  MeetingPerformanceControls,
  MeetingPerformanceSnapshot,
  TranscriptSegmentAnalytics
} from "../../lib/meetingsStore";

type MeetingAudioSource = "user" | "interviewer";

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

interface Meeting {
  id: string;
  title: string;
  startTime: number;
  endTime?: number;
  isRecording: boolean;
  isPaused: boolean;
  notes: MeetingNote[];
  transcripts: MeetingTranscript[];
  analytics?: MeetingAnalytics;
  summary?: MeetingSummary;
  mindMap?: MindMapNode;
}

interface LogEntry {
  timestamp: number;
  level: "info" | "success" | "warning" | "error";
  message: string;
}

interface LiveTranscriptPayload {
  text: string;
  source: MeetingAudioSource;
}

interface AudioPipelineNodes {
  sourceNode: MediaStreamAudioSourceNode;
  workletNode: AudioWorkletNode;
  sinkGainNode: GainNode;
}

interface AnswerSuggestion {
  id: string;
  questionId?: string;
  question: string;
  role?: MeetingRole;
  response?: string;
  status: "pending" | "ready" | "error";
  stage?: "draft" | "refined";
  isRefining?: boolean;
  createdAt: number;
  error?: string;
  confidence?: number;
  followUps?: string[];
  understanding?: CodingQuestionUnderstanding;
  qualityOverall?: number;
  qualityNotes?: string;
  latencyMs?: number;
  draftLatencyMs?: number;
  refineLatencyMs?: number;
  provider?: string;
  model?: string;
  intent?: CodingIntent;
  languageHint?: string;
  frameworkHint?: string;
  responseMetadata?: AnswerResponseMetadata;
  deepDives?: AnswerDeepDive[];
}

interface AnswerDeepDive {
  id: string;
  prompt: string;
  status: "pending" | "ready" | "error";
  response?: string;
  error?: string;
  createdAt: number;
}

interface QuestionCandidate {
  id: string;
  question: string;
  source: MeetingAudioSource;
  role?: MeetingRole;
  confidence: number;
  contextWindow: string;
  detectedAt: number;
  understanding: CodingQuestionUnderstanding;
  intent?: CodingIntent;
  languageHint?: string;
  frameworkHint?: string;
}

interface SttStatusPayload {
  provider: string | null;
  providerChain: string[];
  providerIndex: number;
  reconnectAttempts: number;
  reconnectCount: number;
  fallbackCount: number;
  queueHighWaterMark: number;
  droppedAudioChunks: number;
  avgSttLatencyMs: number;
  event?: string;
  detail?: string;
}

interface MeetingModeProps {
  onClose: () => void;
  onMeetingSaved?: (meeting: Meeting) => Promise<void> | void;
  endRequestToken?: number;
  compact?: boolean;
}

interface ResourceScopeSelection {
  resume: boolean;
  jd: boolean;
  resources: boolean;
  jdIds: string[];
  resourceFolderIds: string[];
}

const DEFAULT_RESOURCE_SCOPE_SELECTION: ResourceScopeSelection = {
  resume: true,
  jd: true,
  resources: true,
  jdIds: [],
  resourceFolderIds: []
};

const RESOURCE_SCOPE_KEY_PREFIX = "cluely_meeting_resource_scope_v1_";
const MEETING_ROLE_KEY_PREFIX = "cluely_meeting_role_v1_";

type MeetingSttProviderChoice = "auto" | "elevenlabs" | "google" | "groq" | "puter";
type AnswerCaptureMode = "auto" | "manual";

const STT_PROVIDER_KEY_PREFIX = "cluely_meeting_stt_provider_v1_";
const CONTEXTUAL_CODE_REQUEST_REGEX =
  /^(give( me)?|show( me)?|write|send|provide|create)?\s*(a\s*)?(short\s+)?(code|example|sample|snippet|implementation|solution)\b/i;
const CONTEXTUAL_EXPLANATION_REGEX =
  /^(and|also|then|what about|how about|plus|one more|another|more|more details?|explain more|go deeper|elaborate)\b/i;
const CONTEXT_DEPENDENT_QUESTION_REGEX =
  /^(it|that|this|same|same thing|same one|the same|do it|continue|next|now|for this)\b/i;

const normalizeMeetingRole = (value: unknown): MeetingRole =>
  value === "product_manager" ? "product_manager" : "developer";

const getMeetingRoleLabel = (role: MeetingRole): string =>
  role === "product_manager" ? "Product Manager" : "Developer";

const getMeetingRoleDescription = (role: MeetingRole): string =>
  role === "product_manager"
    ? "Answers product sense, prioritization, roadmap, metrics, launches, and stakeholder questions."
    : "Answers coding, debugging, system design, and software engineering interview questions.";

const normalizeSttProviderChoice = (value: unknown): MeetingSttProviderChoice => {
  if (
    value === "auto" ||
    value === "elevenlabs" ||
    value === "google" ||
    value === "groq" ||
    value === "puter"
  ) {
    return value;
  }
  return "auto";
};

const parseConfiguredSttProvider = (value: unknown): MeetingSttProviderChoice => {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "elevenlabs" || normalized === "google" || normalized === "groq" || normalized === "puter") {
    return normalized;
  }
  return "elevenlabs";
};

const normalizeResourceScopeSelection = (
  value: Partial<ResourceScopeSelection> | null | undefined
): ResourceScopeSelection => ({
  resume: value?.resume !== false,
  jd: value?.jd !== false,
  resources: value?.resources !== false,
  jdIds: Array.isArray(value?.jdIds)
    ? value!.jdIds.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [],
  resourceFolderIds: Array.isArray(value?.resourceFolderIds)
    ? value!.resourceFolderIds.filter(
        (item): item is string => typeof item === "string" && item.trim().length > 0
      )
    : []
});

const loadResourceScopeSelection = (): ResourceScopeSelection => {
  try {
    const user = getCurrentUser();
    if (!user) return DEFAULT_RESOURCE_SCOPE_SELECTION;
    const raw = localStorage.getItem(`${RESOURCE_SCOPE_KEY_PREFIX}${user.id}`);
    if (!raw) return DEFAULT_RESOURCE_SCOPE_SELECTION;
    const parsed = JSON.parse(raw) as Partial<ResourceScopeSelection>;
    return normalizeResourceScopeSelection(parsed);
  } catch {
    return DEFAULT_RESOURCE_SCOPE_SELECTION;
  }
};

const MeetingMode: React.FC<MeetingModeProps> = ({
  onClose,
  onMeetingSaved,
  endRequestToken = 0,
  compact = false
}) => {
  const envDefaultSttProvider = parseConfiguredSttProvider(import.meta.env.VITE_STT_PROVIDER);

  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [meetingTitle, setMeetingTitle] = useState("");
  const [showTitleInput, setShowTitleInput] = useState(true);
  const [liveTranscript, setLiveTranscript] = useState<LiveTranscriptPayload | null>(null);
  const [partialTranscript, setPartialTranscript] = useState<LiveTranscriptPayload | null>(null);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [showDebug, setShowDebug] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [answers, setAnswers] = useState<AnswerSuggestion[]>([]);
  const [isScreenAnswering, setIsScreenAnswering] = useState(false);
  const [isClearingContext, setIsClearingContext] = useState(false);
  const [sttStatus, setSttStatus] = useState<SttStatusPayload | null>(null);
  const [isEndingMeeting, setIsEndingMeeting] = useState(false);
  const [isMicEnabled, setIsMicEnabled] = useState(true);
  const [resourceScopeSelection, setResourceScopeSelection] = useState<ResourceScopeSelection>(() =>
    loadResourceScopeSelection()
  );
  const [selectedSttProvider, setSelectedSttProvider] = useState<MeetingSttProviderChoice>(() => {
    try {
      const user = getCurrentUser();
      if (!user) return "auto";
      const raw = localStorage.getItem(`${STT_PROVIDER_KEY_PREFIX}${user.id}`);
      return normalizeSttProviderChoice(raw);
    } catch {
      return "auto";
    }
  });
  const [meetingRole, setMeetingRole] = useState<MeetingRole>(() => {
    try {
      const user = getCurrentUser();
      if (!user) return "developer";
      const raw = localStorage.getItem(`${MEETING_ROLE_KEY_PREFIX}${user.id}`);
      return normalizeMeetingRole(raw);
    } catch {
      return "developer";
    }
  });
  const [answerCaptureMode, setAnswerCaptureMode] = useState<AnswerCaptureMode>("auto");
  const [cpuMode, setCpuMode] = useState<CpuMode>("balanced");
  const [chunkRateMs, setChunkRateMs] = useState<number>(1800);
  const [maxChunkQueue, setMaxChunkQueue] = useState<number>(8);
  const [answerThrottleMs, setAnswerThrottleMs] = useState<number>(1200);
  const [modelThrottleMs, setModelThrottleMs] = useState<number>(800);
  const [cloudOffload] = useState<boolean>(true);
  const [isManualQuestionRecording, setIsManualQuestionRecording] = useState(false);
  const [isManualQuestionProcessing, setIsManualQuestionProcessing] = useState(false);
  const [manualQuestionPreview, setManualQuestionPreview] = useState("");
  const [typedQuestionInput, setTypedQuestionInput] = useState("");
  const [problemMemory, setProblemMemory] = useState<ProblemMemory | null>(null);

  const resolvedSttProvider = selectedSttProvider === "auto" ? envDefaultSttProvider : selectedSttProvider;
  const useStreamingStt = resolvedSttProvider === "google" || resolvedSttProvider === "elevenlabs";
  const useChunkedStt = !useStreamingStt;

  const answerInFlightRef = useRef(false);
  const pendingAnswerRef = useRef<QuestionCandidate | null>(null);
  const lastAnsweredRef = useRef<string | null>(null);
  const pendingDetectionRef = useRef<QuestionCandidate | null>(null);
  const analyticsSyncTimerRef = useRef<NodeJS.Timeout | null>(null);
  const answerLastStartedAtRef = useRef(0);
  const questionDebounceRef = useRef<NodeJS.Timeout | null>(null);
  const transcriptHistoryRef = useRef<MeetingTranscript[]>([]);
  const lastQuestionSignatureRef = useRef<string | null>(null);
  const lastQuestionTimestampRef = useRef(0);
  const hasInterviewerAudioRef = useRef(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunkTranscriptionInFlightRef = useRef(false);
  const chunkQueueRef = useRef<Blob[]>([]);
  const droppedLocalChunksRef = useRef(0);
  const modelLastCallAtRef = useRef(0);
  const cloudOffloadAttemptedRef = useRef(false);
  const lastHandledEndRequestRef = useRef(0);
  const vectorLookupWarningShownRef = useRef(false);
  const questionClassificationInFlightRef = useRef(false);
  const puterScriptPromiseRef = useRef<Promise<void> | null>(null);
  const puterReadyRef = useRef(false);
  const answerCaptureModeRef = useRef<AnswerCaptureMode>("auto");
  const contextVersionRef = useRef(0);
  const lastTranscriptSignatureRef = useRef<{ signature: string; timestamp: number } | null>(null);
  const manualQuestionRecordingRef = useRef(false);
  const manualQuestionFinalizingRef = useRef(false);
  const manualQuestionSegmentsRef = useRef<string[]>([]);
  const manualQuestionFinalizeTimerRef = useRef<NodeJS.Timeout | null>(null);
  const manualQuestionPreviewRef = useRef("");
  const problemMemoryRef = useRef<ProblemMemory | null>(null);

  const audioContextRef = useRef<AudioContext | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const interviewerStreamRef = useRef<MediaStream | null>(null);
  const audioPipelinesRef = useRef<AudioPipelineNodes[]>([]);
  const meetingStateRef = useRef({ isRecording: false, isPaused: false });
  const micEnabledRef = useRef(true);
  const durationIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const transcriptScrollRef = useRef<HTMLDivElement>(null);
  const analyticsRef = useRef<MeetingAnalytics>({
    transcriptSegments: [],
    detectedQuestions: [],
    answers: [],
    controls: {
      cpuMode: "balanced",
      chunkRateMs: 1800,
      maxChunkQueue: 8,
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
  });

  const addLog = (level: LogEntry["level"], message: string) => {
    const log: LogEntry = { timestamp: Date.now(), level, message };
    setLogs((prev) => [...prev.slice(-80), log]);
    console.log(`[${level.toUpperCase()}]`, message);
  };

  const updateManualQuestionPreview = (value: string) => {
    manualQuestionPreviewRef.current = value;
    setManualQuestionPreview(value);
  };

  const updateProblemMemory = (
    patch: Partial<ProblemMemory> | null | undefined,
    options?: { replace?: boolean }
  ) => {
    const next = options?.replace
      ? patch
        ? mergeProblemMemory(null, patch)
        : null
      : mergeProblemMemory(problemMemoryRef.current, patch);
    problemMemoryRef.current = next;
    setProblemMemory(next);
    return next;
  };

  const isManualCaptureMode = () => answerCaptureModeRef.current === "manual";
  const isManualCaptureActive = () =>
    manualQuestionRecordingRef.current || manualQuestionFinalizingRef.current;
  const shouldProcessLiveAudio = () => !isManualCaptureMode() || isManualCaptureActive();

  const getConfiguredSttProviderChain = (provider: MeetingSttProviderChoice): string[] => {
    if (provider === "auto") return [];
    if (provider === "puter") return ["puter", "groq"];
    if (provider === "groq") return ["groq", "puter"];
    if (provider === "google") return ["google", "puter", "groq", "elevenlabs"];
    return ["elevenlabs", "puter", "groq"];
  };

  const ensurePuterSdk = async (): Promise<void> => {
    if (window.puter?.ai?.speech2txt) {
      puterReadyRef.current = true;
      return;
    }
    if (puterScriptPromiseRef.current) {
      return puterScriptPromiseRef.current;
    }

    puterScriptPromiseRef.current = new Promise<void>((resolve, reject) => {
      const existingScript = document.getElementById("puter-sdk-v2") as HTMLScriptElement | null;
      if (existingScript) {
        if (window.puter?.ai?.speech2txt) {
          puterReadyRef.current = true;
          resolve();
          return;
        }
        existingScript.addEventListener("load", () => {
          if (window.puter?.ai?.speech2txt) {
            puterReadyRef.current = true;
            resolve();
          } else {
            reject(new Error("Puter SDK loaded but API is unavailable"))
          }
        });
        existingScript.addEventListener("error", () => {
          reject(new Error("Failed to load Puter SDK"))
        });
        return;
      }

      const script = document.createElement("script");
      script.id = "puter-sdk-v2";
      script.src = "https://js.puter.com/v2/";
      script.async = true;
      script.onload = () => {
        if (window.puter?.ai?.speech2txt) {
          puterReadyRef.current = true;
          resolve();
        } else {
          reject(new Error("Puter SDK loaded but speech2txt is unavailable"));
        }
      };
      script.onerror = () => {
        reject(new Error("Failed to load Puter SDK script"));
      };
      document.head.appendChild(script);
    }).catch((error) => {
      puterScriptPromiseRef.current = null;
      throw error;
    });

    return puterScriptPromiseRef.current;
  };

  const transcribeWithPuter = async (audioBase64: string, mimeType: string): Promise<string> => {
    await ensurePuterSdk();
    const speech2txt = window.puter?.ai?.speech2txt;
    if (!speech2txt) {
      throw new Error("Puter STT API unavailable");
    }

    const dataUrl = `data:${mimeType || "audio/webm"};base64,${audioBase64}`;
    const result = await speech2txt(
      {
        file: dataUrl,
        model: "gpt-4o-mini-transcribe"
      },
      {
        model: "gpt-4o-mini-transcribe"
      }
    );

    if (typeof result === "string") {
      return result.trim();
    }

    const payload = (result || {}) as {
      text?: unknown;
      transcript?: unknown;
    };
    const text =
      (typeof payload.text === "string" ? payload.text : "") ||
      (typeof payload.transcript === "string" ? payload.transcript : "");
    return text.trim();
  };

  const getCurrentResources = (): UserResources => {
    const user = getCurrentUser();
    if (!user) {
      return {
        resume: "",
        documents: [],
        knowledge: [],
        knowledgeFolders: []
      };
    }
    return loadResources(user.id);
  };

  const getEffectiveSelectedJdIds = (resources: UserResources): Set<string> => {
    const available = new Set(resources.documents.map((item) => item.id));
    if (available.size === 0) return new Set<string>();
    const configured = resourceScopeSelection.jdIds.filter((id) => available.has(id));
    if (configured.length > 0) {
      return new Set(configured);
    }
    return available;
  };

  const getEffectiveSelectedResourceFolderIds = (resources: UserResources): Set<string> => {
    const available = new Set(
      (resources.knowledgeFolders || []).map((folder) => folder.id)
    );
    if (available.size === 0) return new Set<string>();
    const configured = resourceScopeSelection.resourceFolderIds.filter((id) => available.has(id));
    if (configured.length > 0) {
      return new Set(configured);
    }
    return available;
  };

  const getSelectedVectorFolders = (): Array<"resume" | "jd" | "resource"> => {
    const folders: Array<"resume" | "jd" | "resource"> = [];
    if (resourceScopeSelection.resume) folders.push("resume");
    if (resourceScopeSelection.jd) folders.push("jd");
    if (resourceScopeSelection.resources) folders.push("resource");
    return folders;
  };

  const getSelectedFolderLabels = (): string[] => {
    const resources = getCurrentResources();
    const labels: string[] = [];
    if (resourceScopeSelection.resume) labels.push("Resume");
    if (resourceScopeSelection.jd) {
      const jdIds = getEffectiveSelectedJdIds(resources);
      labels.push(`Interview JD (${jdIds.size}/${resources.documents.length})`);
    }
    if (resourceScopeSelection.resources) {
      const folderIds = getEffectiveSelectedResourceFolderIds(resources);
      const selectedFolders = resources.knowledgeFolders.filter((folder) => folderIds.has(folder.id));
      if (selectedFolders.length > 0) {
        labels.push(
          `Resources: ${selectedFolders
            .slice(0, 3)
            .map((folder) => folder.name)
            .join(", ")}${selectedFolders.length > 3 ? "..." : ""}`
        );
      } else {
        labels.push("Resources");
      }
    }
    return labels;
  };

  const clamp01 = (value: number) =>
    Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));

  const addDetectedQuestionAnalytics = (candidate: QuestionCandidate) => {
    const detectedQuestion: DetectedQuestionAnalytics = {
      id: candidate.id,
      question: candidate.question,
      source: candidate.source,
      confidence: clamp01(candidate.confidence),
      detectedAt: candidate.detectedAt,
      contextWindow: candidate.contextWindow,
      understanding: candidate.understanding
    };
    updateAnalyticsRef((current) => ({
      ...current,
      detectedQuestions: [detectedQuestion, ...(current.detectedQuestions || [])].slice(0, 80)
    }));
  };

  const getControlsForCpuMode = (mode: CpuMode): MeetingPerformanceControls => {
    if (mode === "low") {
      return {
        cpuMode: "low",
        chunkRateMs: 2600,
        maxChunkQueue: 5,
        answerThrottleMs: 2400,
        modelThrottleMs: 1600,
        cloudOffload
      };
    }
    if (mode === "high") {
      return {
        cpuMode: "high",
        chunkRateMs: 1200,
        maxChunkQueue: 14,
        answerThrottleMs: 700,
        modelThrottleMs: 400,
        cloudOffload
      };
    }
    return {
      cpuMode: "balanced",
      chunkRateMs: 1800,
      maxChunkQueue: 8,
      answerThrottleMs: 1200,
      modelThrottleMs: 800,
      cloudOffload
    };
  };

  const buildDefaultPerformanceSnapshot = (): MeetingPerformanceSnapshot => ({
    droppedAudioChunks: 0,
    queueHighWaterMark: 0,
    reconnectCount: 0,
    fallbackCount: 0,
    avgSttLatencyMs: 0
  });

  const buildMeetingAnalytics = (options?: { preservePerformance?: boolean }): MeetingAnalytics => ({
    transcriptSegments: [],
    detectedQuestions: [],
    answers: [],
    controls: {
      cpuMode,
      chunkRateMs,
      maxChunkQueue,
      answerThrottleMs,
      modelThrottleMs,
      cloudOffload
    },
    performance: options?.preservePerformance
      ? {
          droppedAudioChunks: analyticsRef.current.performance?.droppedAudioChunks || 0,
          queueHighWaterMark: analyticsRef.current.performance?.queueHighWaterMark || 0,
          reconnectCount: analyticsRef.current.performance?.reconnectCount || 0,
          fallbackCount: analyticsRef.current.performance?.fallbackCount || 0,
          avgSttLatencyMs: analyticsRef.current.performance?.avgSttLatencyMs || 0
        }
      : buildDefaultPerformanceSnapshot()
  });

  const syncMeetingAnalytics = async (immediate = false) => {
    const runSync = async () => {
      try {
        if (!meetingStateRef.current.isRecording) return;
        const result = await window.electronAPI.meeting.updateAnalytics(
          analyticsRef.current as unknown as Record<string, unknown>
        );
        if (!result.success && result.error) {
          addLog("warning", `⚠️ Analytics sync skipped: ${result.error}`);
        }
      } catch (syncError: any) {
        addLog("warning", `⚠️ Analytics sync error: ${syncError?.message || "unknown"}`);
      }
    };

    if (immediate) {
      if (analyticsSyncTimerRef.current) {
        clearTimeout(analyticsSyncTimerRef.current);
        analyticsSyncTimerRef.current = null;
      }
      await runSync();
      return;
    }

    if (analyticsSyncTimerRef.current) return;
    analyticsSyncTimerRef.current = setTimeout(() => {
      analyticsSyncTimerRef.current = null;
      runSync().catch(() => undefined);
    }, 650);
  };

  const updateAnalyticsRef = (updater: (current: MeetingAnalytics) => MeetingAnalytics) => {
    analyticsRef.current = updater(analyticsRef.current);
    syncMeetingAnalytics(false).catch(() => undefined);
  };

  const clearLocalMeetingContext = (options?: { preservePerformance?: boolean }) => {
    contextVersionRef.current += 1;
    answerInFlightRef.current = false;
    questionClassificationInFlightRef.current = false;
    pendingAnswerRef.current = null;
    pendingDetectionRef.current = null;
    lastAnsweredRef.current = null;
    lastQuestionSignatureRef.current = null;
    lastQuestionTimestampRef.current = 0;
    lastTranscriptSignatureRef.current = null;
    transcriptHistoryRef.current = [];
    chunkQueueRef.current = [];
    modelLastCallAtRef.current = 0;
    answerLastStartedAtRef.current = 0;
    manualQuestionRecordingRef.current = false;
    manualQuestionFinalizingRef.current = false;
    manualQuestionSegmentsRef.current = [];
    if (questionDebounceRef.current) {
      clearTimeout(questionDebounceRef.current);
      questionDebounceRef.current = null;
    }
    if (manualQuestionFinalizeTimerRef.current) {
      clearTimeout(manualQuestionFinalizeTimerRef.current);
      manualQuestionFinalizeTimerRef.current = null;
    }

    const nextAnalytics = buildMeetingAnalytics(options);
    analyticsRef.current = nextAnalytics;

    setAnswers([]);
    setTypedQuestionInput("");
    setLiveTranscript(null);
    setPartialTranscript(null);
    setIsScreenAnswering(false);
    setIsManualQuestionRecording(false);
    setIsManualQuestionProcessing(false);
    updateManualQuestionPreview("");
    updateProblemMemory(null, { replace: true });
    setError(null);
    setMeeting((prev) =>
      prev
        ? {
            ...prev,
            transcripts: [],
            analytics: nextAnalytics
          }
        : prev
    );
  };

  const resetAnsweringStateForRoleSwitch = () => {
    contextVersionRef.current += 1;
    answerInFlightRef.current = false;
    questionClassificationInFlightRef.current = false;
    pendingAnswerRef.current = null;
    pendingDetectionRef.current = null;
    lastAnsweredRef.current = null;
    lastQuestionSignatureRef.current = null;
    lastQuestionTimestampRef.current = 0;
    modelLastCallAtRef.current = 0;
    answerLastStartedAtRef.current = 0;
    manualQuestionRecordingRef.current = false;
    manualQuestionFinalizingRef.current = false;
    manualQuestionSegmentsRef.current = [];
    if (questionDebounceRef.current) {
      clearTimeout(questionDebounceRef.current);
      questionDebounceRef.current = null;
    }
    if (manualQuestionFinalizeTimerRef.current) {
      clearTimeout(manualQuestionFinalizeTimerRef.current);
      manualQuestionFinalizeTimerRef.current = null;
    }
    setIsManualQuestionRecording(false);
    setIsManualQuestionProcessing(false);
    updateManualQuestionPreview("");
    setTypedQuestionInput("");
    setLiveTranscript(null);
    setPartialTranscript(null);
    updateProblemMemory(null, { replace: true });
    setError(null);
  };

  const handleMeetingRoleChange = (nextRole: MeetingRole) => {
    if (nextRole === meetingRole) return;
    setMeetingRole(nextRole);

    if (meetingStateRef.current.isRecording) {
      resetAnsweringStateForRoleSwitch();
      addLog(
        "info",
        `🧭 Switched answer mode to ${getMeetingRoleLabel(nextRole)}. New questions will use ${getMeetingRoleDescription(nextRole).toLowerCase()}`
      );
    }
  };

  const handleClearMeetingContext = async () => {
    if (!meetingStateRef.current.isRecording || isClearingContext) return;

    setIsClearingContext(true);
    try {
      const result = await window.electronAPI.meeting.clearContext();
      if (!result.success) {
        throw new Error(result.error || "Failed to clear meeting context.");
      }

      clearLocalMeetingContext({ preservePerformance: true });
      addLog("success", "🧹 Cleared meeting conversation and AI context.");
    } catch (clearError: any) {
      addLog("error", `❌ Failed to clear meeting context: ${clearError?.message || "unknown error"}`);
      setError(clearError?.message || "Failed to clear meeting context.");
    } finally {
      setIsClearingContext(false);
    }
  };

  useEffect(() => {
    const controls = getControlsForCpuMode(cpuMode);
    setChunkRateMs(controls.chunkRateMs);
    setMaxChunkQueue(controls.maxChunkQueue);
    setAnswerThrottleMs(controls.answerThrottleMs);
    setModelThrottleMs(controls.modelThrottleMs);
  }, [cpuMode]);

  useEffect(() => {
    answerCaptureModeRef.current = answerCaptureMode;
    setLiveTranscript(null);
    setPartialTranscript(null);
    if (answerCaptureMode !== "manual") {
      manualQuestionRecordingRef.current = false;
      manualQuestionFinalizingRef.current = false;
      manualQuestionSegmentsRef.current = [];
      setIsManualQuestionRecording(false);
      setIsManualQuestionProcessing(false);
      updateManualQuestionPreview("");
    }
    pendingDetectionRef.current = null;
    if (questionDebounceRef.current) {
      clearTimeout(questionDebounceRef.current);
      questionDebounceRef.current = null;
    }
    if (manualQuestionFinalizeTimerRef.current) {
      clearTimeout(manualQuestionFinalizeTimerRef.current);
      manualQuestionFinalizeTimerRef.current = null;
    }
  }, [answerCaptureMode]);

  useEffect(() => {
    updateAnalyticsRef((current) => ({
      ...current,
      controls: {
        cpuMode,
        chunkRateMs,
        maxChunkQueue,
        answerThrottleMs,
        modelThrottleMs,
        cloudOffload
      }
    }));
  }, [cpuMode, chunkRateMs, maxChunkQueue, answerThrottleMs, modelThrottleMs, cloudOffload]);

  const buildConversationContext = (maxTurns = 6): string => {
    const recentTurns = transcriptHistoryRef.current.slice(-maxTurns);
    return recentTurns
      .map((turn) => `${turn.source === "interviewer" ? "Interviewer" : "Candidate"}: ${turn.text}`)
      .join("\n");
  };

  const getLatestAskedTranscriptLine = (): string => {
    const latestTranscriptQuestion = [...transcriptHistoryRef.current]
      .reverse()
      .find((turn) => {
        const normalized = turn.text.replace(/\s+/g, " ").trim();
        return normalized.length >= 4 && /[?]$/.test(normalized);
      });

    if (latestTranscriptQuestion) {
      return `${latestTranscriptQuestion.source === "interviewer" ? "Interviewer" : "Candidate"}: ${latestTranscriptQuestion.text}`;
    }

    if (problemMemoryRef.current?.lastInterviewerAsk) {
      return `Interviewer: ${problemMemoryRef.current.lastInterviewerAsk}`;
    }

    if (problemMemoryRef.current?.lastQuestion) {
      return `Candidate: ${problemMemoryRef.current.lastQuestion}`;
    }

    return "";
  };

  const appendLastAskedTranscriptContext = (contextWindow: string): string => {
    const latestAskedLine = getLatestAskedTranscriptLine();
    if (!latestAskedLine) return contextWindow;
    if (contextWindow.includes(latestAskedLine)) return contextWindow;

    return [contextWindow, `Most recent asked transcript:\n${latestAskedLine}`]
      .filter(Boolean)
      .join("\n\n");
  };

  const truncate = (text: string, limit: number) => {
    if (text.length <= limit) return text;
    return `${text.slice(0, limit)}...`;
  };

  const getMostRelevantQuestionAnchor = (question: string): string => {
    const signature = normalizeQuestionSignature(question);
    const entries = [...transcriptHistoryRef.current].reverse();

    for (const entry of entries) {
      const text = entry.text.replace(/\s+/g, " ").trim();
      if (!text) continue;
      if (normalizeQuestionSignature(text) === signature) continue;
      if (text.split(/\s+/).length < 4) continue;
      return text;
    }

    return "";
  };

  const enrichQuestionWithContext = (
    candidate: QuestionCandidate
  ): QuestionCandidate => {
    const originalQuestion = candidate.question.replace(/\s+/g, " ").trim();
    if (!originalQuestion) return candidate;

    const wordCount = originalQuestion.split(/\s+/).filter(Boolean).length;
    const needsContext =
      wordCount <= 4 ||
      CONTEXTUAL_CODE_REQUEST_REGEX.test(originalQuestion) ||
      CONTEXTUAL_EXPLANATION_REGEX.test(originalQuestion) ||
      CONTEXT_DEPENDENT_QUESTION_REGEX.test(originalQuestion);

    if (!needsContext) return candidate;

    const anchor = getMostRelevantQuestionAnchor(originalQuestion);
    if (!anchor) return candidate;

    let resolvedQuestion = originalQuestion;
    if (CONTEXTUAL_CODE_REQUEST_REGEX.test(originalQuestion)) {
      resolvedQuestion =
        meetingRole === "product_manager"
          ? `Give a concrete product example for: ${anchor}`
          : `Give a code example for: ${anchor}`;
    } else if (CONTEXTUAL_EXPLANATION_REGEX.test(originalQuestion)) {
      resolvedQuestion = `Explain in more detail: ${anchor}`;
    } else {
      resolvedQuestion = `${originalQuestion} about: ${anchor}`;
    }

    addLog("info", `🧠 Resolved follow-up using context: ${truncate(resolvedQuestion, 100)}`);

    const contextWindow = appendLastAskedTranscriptContext(buildConversationContext(8));
    return {
      ...candidate,
      question: resolvedQuestion,
      contextWindow,
      understanding: buildQuestionUnderstanding(resolvedQuestion, contextWindow, meetingRole)
    };
  };

  const ensureExplicitQuestionTranscriptContext = (candidate: QuestionCandidate): QuestionCandidate => {
    const contextWindow = appendLastAskedTranscriptContext(candidate.contextWindow);
    if (contextWindow === candidate.contextWindow) return candidate;

    return {
      ...candidate,
      contextWindow,
      understanding: buildQuestionUnderstanding(candidate.question, contextWindow, meetingRole)
    };
  };

  const resolveCandidateLanguage = (candidate: QuestionCandidate): string | undefined =>
    meetingRole === "product_manager"
      ? undefined
      :
    normalizeLanguageLabel(
      candidate.languageHint ||
        problemMemoryRef.current?.preferredLanguage ||
        inferLanguageFromText(
          `${candidate.question}\n${candidate.contextWindow}\n${buildProblemMemoryContext(problemMemoryRef.current)}`
        )
    );

  const resolveCandidateFramework = (candidate: QuestionCandidate): string | undefined =>
    meetingRole === "product_manager"
      ? undefined
      :
    normalizeFrameworkLabel(
      candidate.frameworkHint ||
        problemMemoryRef.current?.preferredFramework ||
        inferFrameworkFromText(
          `${candidate.question}\n${candidate.contextWindow}\n${buildProblemMemoryContext(problemMemoryRef.current)}`
        )
    );

  const syncProblemMemoryFromCandidate = (
    candidate: QuestionCandidate,
    source: ProblemMemory["source"] = "conversation"
  ) => {
    updateProblemMemory({
      ...buildProblemMemoryPatchFromCandidate(candidate, source),
      preferredLanguage: resolveCandidateLanguage(candidate),
      preferredFramework: resolveCandidateFramework(candidate)
    });
  };

  const syncProblemMemoryFromAnswer = (
    candidate: QuestionCandidate,
    metadata: AnswerResponseMetadata | undefined,
    response: string
  ) => {
    const parsed = parseLLMResponse(response);
    const activeIntent =
      metadata?.intent || candidate.intent || inferMeetingIntent(candidate.question, candidate.contextWindow, meetingRole);
    updateProblemMemory({
      preferredLanguage: normalizeLanguageLabel(
        resolveCandidateLanguage(candidate) || problemMemoryRef.current?.preferredLanguage || metadata?.language
      ),
      preferredFramework: normalizeFrameworkLabel(
        resolveCandidateFramework(candidate) || problemMemoryRef.current?.preferredFramework || metadata?.framework
      ),
      currentApproach: metadata?.approach || problemMemoryRef.current?.currentApproach,
      timeComplexity: metadata?.timeComplexity || problemMemoryRef.current?.timeComplexity,
      spaceComplexity: metadata?.spaceComplexity || problemMemoryRef.current?.spaceComplexity,
      edgeCases: metadata?.edgeCases || problemMemoryRef.current?.edgeCases,
      examples: metadata?.examples || problemMemoryRef.current?.examples,
      currentCode:
        isCodeHeavyIntent(activeIntent) && (parsed.type === "code" || parsed.type === "structured")
          ? parsed.content
          : problemMemoryRef.current?.currentCode,
      lastIntent: activeIntent,
      updatedAt: Date.now()
    });
  };

  const resolveCandidateForAnswer = async (
    candidate: QuestionCandidate,
    options?: { allowModelClassification?: boolean }
  ): Promise<QuestionCandidate> => {
    const enrichedCandidate = ensureExplicitQuestionTranscriptContext(enrichQuestionWithContext(candidate));
    let resolvedCandidate: QuestionCandidate = {
      ...enrichedCandidate,
      intent: enrichedCandidate.intent || inferMeetingIntent(enrichedCandidate.question, enrichedCandidate.contextWindow, meetingRole)
    };

    if (
      options?.allowModelClassification !== false &&
      (resolvedCandidate.intent === "other" || resolvedCandidate.confidence < 0.72)
    ) {
      try {
        await maybeUseCloudOffload();
        await applyModelThrottle();
        const modelClassification = await classifyQuestionIntentWithModel(
          enrichedCandidate,
          (prompt) => window.electronAPI.invoke("llm-chat", prompt),
          meetingRole
        );

        resolvedCandidate = {
          ...enrichedCandidate,
          question: modelClassification.normalizedQuestion || enrichedCandidate.question,
          confidence: Math.max(enrichedCandidate.confidence, modelClassification.confidence),
          understanding: modelClassification.understanding,
          intent: modelClassification.intent,
          languageHint: modelClassification.languageHint,
          frameworkHint: modelClassification.frameworkHint,
          detectedAt: Date.now()
        };
      } catch (classificationError: any) {
        addLog(
          "warning",
          `⚠️ Model classifier unavailable, using heuristic detection (${classificationError?.message || "unknown"}).`
        );
      }
    }

    return {
      ...resolvedCandidate,
      intent:
        resolvedCandidate.intent || inferMeetingIntent(resolvedCandidate.question, resolvedCandidate.contextWindow, meetingRole),
      languageHint: resolveCandidateLanguage(resolvedCandidate),
      frameworkHint: resolveCandidateFramework(resolvedCandidate)
    };
  };

  const buildResourceContext = async (question: string) => {
    const user = getCurrentUser();
    if (!user) return { context: "", sources: [] as string[] };
    const resources = loadResources(user.id);
    const selectedFolders = new Set(getSelectedVectorFolders());
    if (selectedFolders.size === 0) {
      return { context: "", sources: [] as string[] };
    }

    const selectedJdIds = getEffectiveSelectedJdIds(resources);
    const selectedResourceFolderIds = getEffectiveSelectedResourceFolderIds(resources);
    const result = await buildHybridResourceContext({
      userId: user.id,
      question,
      resources,
      includeResume: selectedFolders.has("resume"),
      includeJd: selectedFolders.has("jd"),
      includeResources: selectedFolders.has("resource"),
      selectedJdIds,
      selectedResourceFolderIds,
      maxContextLength: 4000,
      vectorTopK: 8,
      finalTopK: 7,
      onWarning: message => {
        if (!vectorLookupWarningShownRef.current) {
          vectorLookupWarningShownRef.current = true;
          addLog("warning", `⚠️ ${message}`);
        }
      }
    });

    return {
      context: result.context,
      sources: result.sources
    };
  };

  const coerceLlmResponseText = (payload: unknown): string => {
    if (typeof payload === "string") return payload;
    if (payload && typeof payload === "object") {
      const value = payload as Record<string, unknown>;
      if (typeof value.text === "string") return value.text;
      if (typeof value.response === "string") return value.response;
    }
    try {
      return JSON.stringify(payload);
    } catch {
      return String(payload ?? "");
    }
  };

  const getDefaultExpansionSuggestions = (): string[] =>
    meetingRole === "product_manager"
      ? ["Add more detail", "Give a concrete PM example", "Mention tradeoffs and metrics"]
      : ["Add more details", "Give a short code example", "Mention pitfalls and edge cases"];

  const getIntentSpecificSuggestions = (intent?: CodingIntent): string[] => {
    if (meetingRole === "product_manager") {
      if (intent === "behavioral") {
        return ["Make it more STAR", "Add the measurable outcome", "Mention stakeholder alignment"];
      }
      if (intent === "system_design") {
        return ["Add prioritization tradeoffs", "Mention success metrics", "Call out risks and dependencies"];
      }
      return ["Add user pain point", "Mention one metric", "Add a tradeoff"];
    }

    if (intent === "write_code" || intent === "debug_code") {
      return ["Explain the code briefly", "Add test cases", "Show time and space complexity"];
    }
    if (intent === "optimize") {
      return ["Compare old vs new complexity", "Show a shorter optimized version", "Mention tradeoffs"];
    }
    if (intent === "complexity") {
      return ["Explain why that complexity holds", "Give a worst-case example", "Suggest an optimization"];
    }
    if (intent === "dry_run") {
      return ["Dry run another example", "Show the state changes", "List edge cases"];
    }
    if (intent === "test_cases") {
      return ["Add more edge cases", "Give expected outputs", "Mention failure cases"];
    }
    return [];
  };

  const getExpansionSuggestions = (item: AnswerSuggestion): string[] => {
    const byKey = new Map<string, string>();
    [
      ...getDefaultExpansionSuggestions(),
      ...getIntentSpecificSuggestions(item.responseMetadata?.intent || item.intent),
      ...(item.followUps || [])
    ].forEach((entry) => {
      const normalized = entry.replace(/\s+/g, " ").trim();
      if (!normalized) return;
      const key = normalized.toLowerCase();
      if (!byKey.has(key)) {
        byKey.set(key, normalized);
      }
    });
    return Array.from(byKey.values()).slice(0, 6);
  };

  const maybeUseCloudOffload = async () => {
    if (!cloudOffload) return;
    if (cloudOffloadAttemptedRef.current) return;
    cloudOffloadAttemptedRef.current = true;

    try {
      const config = await window.electronAPI.getCurrentLlmConfig();
      if (config.provider === "ollama") {
        const switched = await window.electronAPI.switchToGroq();
        if (switched.success) {
          addLog("info", "☁️ Cloud offload enabled for answer generation.");
        } else {
          addLog("warning", `⚠️ Cloud offload unavailable: ${switched.error || "switch failed"}`);
        }
      }
    } catch (error: any) {
      addLog("warning", `⚠️ Cloud offload check failed: ${error?.message || "unknown"}`);
    }
  };

  const applyModelThrottle = async () => {
    const elapsed = Date.now() - modelLastCallAtRef.current;
    const waitMs = Math.max(0, modelThrottleMs - elapsed);
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    modelLastCallAtRef.current = Date.now();
  };

  const getAutoRefinementGoal = (intent?: CodingIntent): string => {
    if (meetingRole === "product_manager") {
      if (intent === "behavioral") {
        return "Tighten the story into a crisp STAR answer with a clear result.";
      }
      if (intent === "system_design") {
        return "Make the recommendation more structured with user impact, tradeoffs, metric, and risk.";
      }
      return "Make the PM answer sharper, more user-focused, and more measurable.";
    }

    if (intent === "write_code") {
      return "Tighten the code example, then add only the most important explanation, complexity, and edge case.";
    }
    if (intent === "debug_code") {
      return "Emphasize the root cause, minimal fix, and one failing case the fix addresses.";
    }
    if (intent === "optimize") {
      return "Highlight the optimization, compare old vs new complexity, and keep the code concise.";
    }
    if (intent === "complexity") {
      return "Make the time and space complexity explicit and easy to justify.";
    }
    if (intent === "dry_run") {
      return "Keep the dry run concrete and step-by-step on one clear example.";
    }
    if (intent === "test_cases") {
      return "Focus on representative edge cases with expected outputs.";
    }
    return "Add concise detail for follow-up depth while staying interview-ready.";
  };

  const upsertAnswerAnalytics = (entry: AnswerAnalytics) => {
    updateAnalyticsRef((current) => {
      const next = [entry, ...(current.answers || []).filter((item) => item.id !== entry.id)].slice(0, 80);
      return {
        ...current,
        answers: next
      };
    });
  };

  const generateAnswer = async (candidate: QuestionCandidate) => {
    const contextVersion = contextVersionRef.current;
    const resolvedCandidate = await resolveCandidateForAnswer(candidate);
    if (contextVersion !== contextVersionRef.current) return;
    const trimmed = resolvedCandidate.question.trim();
    if (!trimmed) return;
    if (lastAnsweredRef.current === normalizeQuestionSignature(trimmed)) return;

    const elapsedSinceLastAnswer = Date.now() - answerLastStartedAtRef.current;
    if (elapsedSinceLastAnswer < answerThrottleMs && answerLastStartedAtRef.current > 0) {
      pendingAnswerRef.current = candidate;
      const waitMs = answerThrottleMs - elapsedSinceLastAnswer;
      setTimeout(() => {
        if (pendingAnswerRef.current?.id === candidate.id && !answerInFlightRef.current) {
          const queued = pendingAnswerRef.current;
          pendingAnswerRef.current = null;
          if (queued) {
            generateAnswer(queued);
          }
        }
      }, waitMs);
      return;
    }

    if (answerInFlightRef.current) {
      pendingAnswerRef.current = candidate;
      return;
    }

    lastAnsweredRef.current = normalizeQuestionSignature(trimmed);
    answerInFlightRef.current = true;
    answerLastStartedAtRef.current = Date.now();

    const answerId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const pendingAnswer: AnswerSuggestion = {
      id: answerId,
      questionId: resolvedCandidate.id,
      question: trimmed,
      role: resolvedCandidate.role || meetingRole,
      status: "pending",
      stage: "draft",
      isRefining: false,
      createdAt: Date.now(),
      confidence: Math.round(resolvedCandidate.confidence * 100),
      understanding: resolvedCandidate.understanding,
      intent: resolvedCandidate.intent,
      languageHint: resolvedCandidate.languageHint,
      frameworkHint: resolvedCandidate.frameworkHint
    };
    setAnswers((prev) => [pendingAnswer, ...prev].slice(0, 24));

    try {
      syncProblemMemoryFromCandidate(resolvedCandidate);
      const retrievalQuery = [
        trimmed,
        problemMemoryRef.current?.problemStatement,
        problemMemoryRef.current?.currentApproach
      ]
        .filter(Boolean)
        .join("\n");
      const { context } = await buildResourceContext(retrievalQuery);
      const user = getCurrentUser();
      const selectedFolderLabels = getSelectedFolderLabels();

      await maybeUseCloudOffload();
      await applyModelThrottle();

      const draftStartedAt = Date.now();
      const parsedDraft = await generateFastDraftAnswer({
        candidate: resolvedCandidate,
        candidateName: user?.name || "Candidate",
        selectedFolderLabels,
        resourceContext: context,
        problemMemory: problemMemoryRef.current,
        invokeLlm: (prompt) => window.electronAPI.invoke("llm-chat", prompt)
      });
      if (contextVersion !== contextVersionRef.current) return;
      const draftLatencyMs = Date.now() - draftStartedAt;
      const draftAnswer = cleanLLMResponse(parsedDraft.answer);
      syncProblemMemoryFromAnswer(resolvedCandidate, parsedDraft.metadata, draftAnswer);
      const draftQuality = estimateAnswerQuality(
        {
          ...resolvedCandidate,
          understanding: parsedDraft.understanding
        },
        draftAnswer,
        problemMemoryRef.current
      );

      const config = await window.electronAPI.getCurrentLlmConfig().catch(() => ({
        provider: "groq" as const,
        model: "unknown",
        isOllama: false
      }));

      const draftQualityOverall = clamp01(draftQuality.overall);
      setAnswers((prev) =>
        prev.map((item) =>
          item.id === answerId
            ? {
                ...item,
                response: draftAnswer,
                status: "ready",
                stage: "draft",
                isRefining: false,
                followUps: parsedDraft.followUps,
                understanding: parsedDraft.understanding,
                qualityOverall: draftQualityOverall,
                latencyMs: draftLatencyMs,
                draftLatencyMs,
                provider: config.provider,
                model: config.model,
                role: resolvedCandidate.role || meetingRole,
                intent: resolvedCandidate.intent,
                languageHint: resolvedCandidate.languageHint,
                frameworkHint: resolvedCandidate.frameworkHint,
                responseMetadata: parsedDraft.metadata
              }
            : item
        )
      );

      upsertAnswerAnalytics({
        id: answerId,
        questionId: resolvedCandidate.id,
        question: trimmed,
        answer: draftAnswer,
        followUps: parsedDraft.followUps,
        provider: config.provider,
        model: config.model,
        createdAt: Date.now(),
        latencyMs: draftLatencyMs,
        draftLatencyMs,
        generationStage: "draft",
        quality: draftQuality
      });
    } catch (err: any) {
      if (contextVersion !== contextVersionRef.current) return;
      setAnswers((prev) =>
        prev.map((item) =>
          item.id === answerId
            ? { ...item, status: "error", isRefining: false, error: err?.message || "Failed to generate answer." }
            : item
        )
      );
    } finally {
      if (contextVersion !== contextVersionRef.current) return;
      answerInFlightRef.current = false;
      const pending = pendingAnswerRef.current;
      pendingAnswerRef.current = null;
      if (pending && normalizeQuestionSignature(pending.question) !== normalizeQuestionSignature(trimmed)) {
        generateAnswer(pending);
      }
    }
  };

  const requestAnswerRefinement = async (answerId: string) => {
    const contextVersion = contextVersionRef.current;
    const selectedAnswer = answers.find((item) => item.id === answerId);
    if (!selectedAnswer || selectedAnswer.status !== "ready" || !selectedAnswer.response || selectedAnswer.isRefining) {
      return;
    }

    const contextWindow = appendLastAskedTranscriptContext(buildConversationContext(8));
    const answerRole = selectedAnswer.role || meetingRole;
    const answerIntent =
      selectedAnswer.responseMetadata?.intent ||
      selectedAnswer.intent ||
      inferMeetingIntent(selectedAnswer.question, contextWindow, answerRole);
    const refinementCandidate: QuestionCandidate = {
      id: selectedAnswer.questionId || `refine-${answerId}`,
      question: selectedAnswer.question,
      source: "user",
      role: answerRole,
      confidence: Math.max((selectedAnswer.confidence || 80) / 100, 0.6),
      contextWindow,
      detectedAt: Date.now(),
      understanding:
        selectedAnswer.understanding || buildQuestionUnderstanding(selectedAnswer.question, contextWindow, answerRole),
      intent: answerIntent,
      languageHint: normalizeLanguageLabel(
        selectedAnswer.responseMetadata?.language || selectedAnswer.languageHint || problemMemoryRef.current?.preferredLanguage
      ),
      frameworkHint: normalizeFrameworkLabel(
        selectedAnswer.responseMetadata?.framework || selectedAnswer.frameworkHint || problemMemoryRef.current?.preferredFramework
      )
    };

    setAnswers((prev) =>
      prev.map((item) =>
        item.id === answerId
          ? {
              ...item,
              isRefining: true
            }
          : item
      )
    );

    try {
      await maybeUseCloudOffload();
      const retrievalQuery = [
        selectedAnswer.question,
        selectedAnswer.responseMetadata?.approach,
        problemMemoryRef.current?.problemStatement
      ]
        .filter(Boolean)
        .join("\n");
      const { context } = await buildResourceContext(retrievalQuery);

      await applyModelThrottle();
      const refineStartedAt = Date.now();
      const refinedAnswer = await generateRefinedAnswer({
        candidate: refinementCandidate,
        draftAnswer: selectedAnswer.response,
        suggestion: getAutoRefinementGoal(answerIntent),
        resourceContext: context,
        problemMemory: problemMemoryRef.current,
        invokeLlm: (prompt) => window.electronAPI.invoke("llm-chat", prompt)
      });
      if (contextVersion !== contextVersionRef.current) return;
      const refineLatencyMs = Date.now() - refineStartedAt;
      syncProblemMemoryFromAnswer(refinementCandidate, selectedAnswer.responseMetadata, refinedAnswer);
      const refinedQuality = estimateAnswerQuality(refinementCandidate, refinedAnswer, problemMemoryRef.current);
      const refinedOverall = clamp01(refinedQuality.overall);

      const config = await window.electronAPI.getCurrentLlmConfig().catch(() => ({
        provider: "groq" as const,
        model: "unknown",
        isOllama: false
      }));

      setAnswers((prev) =>
        prev.map((item) =>
          item.id === answerId
            ? {
                ...item,
                response: refinedAnswer,
                stage: "refined",
                isRefining: false,
                qualityOverall: refinedOverall,
                refineLatencyMs,
                latencyMs: (item.draftLatencyMs || item.latencyMs || 0) + refineLatencyMs,
                provider: config.provider,
                model: config.model
              }
            : item
        )
      );

      upsertAnswerAnalytics({
        id: answerId,
        questionId: selectedAnswer.questionId,
        question: selectedAnswer.question,
        answer: refinedAnswer,
        followUps: selectedAnswer.followUps || [],
        provider: config.provider,
        model: config.model,
        createdAt: Date.now(),
        latencyMs: (selectedAnswer.draftLatencyMs || selectedAnswer.latencyMs || 0) + refineLatencyMs,
        draftLatencyMs: selectedAnswer.draftLatencyMs,
        refineLatencyMs,
        generationStage: "refined",
        quality: refinedQuality
      });
    } catch (error: any) {
      if (contextVersion !== contextVersionRef.current) return;
      const message = error?.message || "Failed to refine answer.";
      setAnswers((prev) =>
        prev.map((item) =>
          item.id === answerId
            ? {
                ...item,
                isRefining: false
              }
            : item
        )
      );
      addLog("warning", `⚠️ Manual refine failed: ${message}`);
    }
  };

  const requestAnswerExpansion = async (answerId: string, suggestion: string) => {
    const normalizedSuggestion = suggestion.replace(/\s+/g, " ").trim();
    if (!normalizedSuggestion) return;

    const selectedAnswer = answers.find((item) => item.id === answerId);
    if (!selectedAnswer || selectedAnswer.status !== "ready" || !selectedAnswer.response) return;

    const deepDiveId = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const pendingDive: AnswerDeepDive = {
      id: deepDiveId,
      prompt: normalizedSuggestion,
      status: "pending",
      createdAt: Date.now()
    };

    setAnswers((prev) =>
      prev.map((item) =>
        item.id === answerId
          ? {
              ...item,
              deepDives: [pendingDive, ...(item.deepDives || [])].slice(0, 6)
            }
          : item
      )
    );

    try {
      await maybeUseCloudOffload();
      await applyModelThrottle();

      const contextWindow = appendLastAskedTranscriptContext(buildConversationContext(8));
      const { context } = await buildResourceContext(`${selectedAnswer.question} ${normalizedSuggestion}`);
      const answerRole = selectedAnswer.role || meetingRole;
      const answerIntent =
        selectedAnswer.responseMetadata?.intent ||
        selectedAnswer.intent ||
        inferMeetingIntent(selectedAnswer.question, contextWindow, answerRole);
      const preferredLanguage =
        answerRole === "product_manager"
          ? undefined
          : normalizeLanguageLabel(
              selectedAnswer.responseMetadata?.language ||
                selectedAnswer.languageHint ||
                problemMemoryRef.current?.preferredLanguage
            );
      const preferredFramework =
        answerRole === "product_manager"
          ? undefined
          : normalizeFrameworkLabel(
              selectedAnswer.responseMetadata?.framework ||
                selectedAnswer.frameworkHint ||
                problemMemoryRef.current?.preferredFramework
            );
      const prompt = `You are an interview copilot for ${
        answerRole === "product_manager" ? "Product Manager interviews" : "coding interviews"
      }.

Original interview question:
${selectedAnswer.question}

Detected intent:
${answerIntent}

Current answer:
${selectedAnswer.response}

User follow-up request:
${normalizedSuggestion}

Recent conversation context:
${contextWindow || "No recent context."}

Active problem memory:
${buildProblemMemoryContext(problemMemoryRef.current) || "None"}

${answerRole === "product_manager"
  ? `PM answer style:
- Answer like a product manager, not an engineer.
- Lead with user impact, recommendation, tradeoff, and metric.
- Avoid code or implementation details unless explicitly requested.`
  : `Preferred language:
${preferredLanguage || "unspecified"}

Preferred framework:
${preferredFramework || "unspecified"}`}

Candidate resources:
${context || "No resources provided."}

Return plain text only. Keep it concise, interview-ready, and actionable.
${
  answerRole === "product_manager"
    ? "If helpful, mention the user impact, one tradeoff, and one metric or risk."
    : "If coding-related, preserve the original language and framework and include quick complexity and one edge case."
}`;

      const raw = await window.electronAPI.invoke("llm-chat", prompt);
      const expanded = cleanLLMResponse(coerceLlmResponseText(raw));

      setAnswers((prev) =>
        prev.map((item) =>
          item.id === answerId
            ? {
                ...item,
                deepDives: (item.deepDives || []).map((dive) =>
                  dive.id === deepDiveId ? { ...dive, status: "ready", response: expanded } : dive
                )
              }
            : item
        )
      );
    } catch (error: any) {
      const message = error?.message || "Failed to generate more details.";
      setAnswers((prev) =>
        prev.map((item) =>
          item.id === answerId
            ? {
                ...item,
                deepDives: (item.deepDives || []).map((dive) =>
                  dive.id === deepDiveId ? { ...dive, status: "error", error: message } : dive
                )
              }
            : item
        )
      );
      addLog("error", `❌ Follow-up generation failed: ${message}`);
    }
  };

  const handleAnswerFromScreen = async () => {
    if (isScreenAnswering) return;
    if (meetingRole === "product_manager") {
      addLog("warning", "⚠️ Screen answer is currently optimized for Developer mode only.");
      return;
    }
    const contextVersion = contextVersionRef.current;
    setIsScreenAnswering(true);

    const contextWindow = appendLastAskedTranscriptContext(buildConversationContext(8));

    try {
      await maybeUseCloudOffload();

      const screenshot = await window.electronAPI.invoke("take-screenshot");
      const screenshotPath =
        screenshot && typeof screenshot.path === "string" ? screenshot.path : "";
      if (!screenshotPath) {
        throw new Error("Failed to capture screen.");
      }

      await applyModelThrottle();
      const visionRaw = await window.electronAPI.invoke("analyze-image-file", screenshotPath);
      const screenSummary = cleanLLMResponse(coerceLlmResponseText(visionRaw));
      if (!screenSummary.trim()) {
        throw new Error("Screen analysis returned no text.");
      }

      await applyModelThrottle();
      const extractionRaw = await window.electronAPI.invoke(
        "llm-chat",
        buildScreenProblemExtractionPrompt(screenSummary, contextWindow, problemMemoryRef.current)
      );
      if (contextVersion !== contextVersionRef.current) return;
      const extracted = parseScreenProblemAnalysis(coerceLlmResponseText(extractionRaw), {
        activeRequest: "Help me solve the visible coding problem",
        intent: inferMeetingIntent(screenSummary, contextWindow, meetingRole),
        problemStatement: problemMemoryRef.current?.problemStatement || screenSummary,
        preferredLanguage: inferLanguageFromText(
          `${screenSummary}\n${problemMemoryRef.current?.preferredLanguage || ""}`
        ),
        preferredFramework: inferFrameworkFromText(
          `${screenSummary}\n${problemMemoryRef.current?.preferredFramework || ""}`
        ),
        constraints: problemMemoryRef.current?.constraints || [],
        edgeCases: problemMemoryRef.current?.edgeCases || [],
        examples: problemMemoryRef.current?.examples || []
      });

      const inferredIntent =
        extracted.intent === "other"
          ? inferMeetingIntent(extracted.activeRequest || extracted.problemStatement, screenSummary, meetingRole)
          : extracted.intent;
      const languageHint = normalizeLanguageLabel(
        extracted.preferredLanguage || problemMemoryRef.current?.preferredLanguage
      );
      const frameworkHint = normalizeFrameworkLabel(
        extracted.preferredFramework || problemMemoryRef.current?.preferredFramework
      );
      const fallbackQuestion =
        inferredIntent === "debug_code"
          ? "Debug the visible code"
          : inferredIntent === "optimize"
          ? "Optimize the visible solution"
          : inferredIntent === "complexity"
          ? "Explain the complexity of the visible solution"
          : inferredIntent === "dry_run"
          ? "Dry run the visible solution"
          : inferredIntent === "test_cases"
          ? "Give test cases for the visible problem"
          : `Write ${frameworkHint ? `${frameworkHint} ` : ""}${languageHint ? `${languageHint} ` : ""}code for the visible problem`;

      updateProblemMemory({
        problemStatement: extracted.problemStatement || problemMemoryRef.current?.problemStatement || fallbackQuestion,
        constraints: extracted.constraints,
        edgeCases: extracted.edgeCases,
        examples: extracted.examples,
        preferredLanguage: languageHint,
        preferredFramework: frameworkHint,
        currentCode: extracted.visibleCode,
        currentApproach: extracted.currentApproach,
        timeComplexity: extracted.timeComplexity,
        spaceComplexity: extracted.spaceComplexity,
        screenSummary,
        lastIntent: inferredIntent,
        lastQuestion: extracted.activeRequest || fallbackQuestion,
        source: "screen",
        updatedAt: Date.now()
      });

      const screenCandidate: QuestionCandidate = {
        id: `screen-${Date.now()}`,
        question: extracted.activeRequest || fallbackQuestion,
        source: "user",
        confidence: 0.96,
        contextWindow,
        detectedAt: Date.now(),
        understanding: {
          problemStatement:
            extracted.problemStatement || buildQuestionUnderstanding(fallbackQuestion, contextWindow, meetingRole).problemStatement,
          constraints: extracted.constraints,
          edgeCases: extracted.edgeCases
        },
        intent: inferredIntent,
        role: meetingRole,
        languageHint,
        frameworkHint
      };

      addDetectedQuestionAnalytics(screenCandidate);
      addLog(
        "info",
        `🖼️ Screen context loaded: ${truncate(
          extracted.problemStatement || extracted.activeRequest || fallbackQuestion,
          90
        )}`
      );
      await generateAnswer(screenCandidate);
      if (contextVersion !== contextVersionRef.current) return;
      addLog("success", "🖼️ Screen analyzed and answer generated.");
    } catch (error: any) {
      if (contextVersion !== contextVersionRef.current) return;
      const message = error?.message || "Failed to answer from screen.";
      addLog("error", `❌ Screen answer failed: ${message}`);
    } finally {
      if (contextVersion !== contextVersionRef.current) return;
      setIsScreenAnswering(false);
    }
  };

  const formatSourceLabel = (source: MeetingAudioSource) => (source === "interviewer" ? "Interviewer" : "You");

  const formatIntentLabel = (intent?: CodingIntent): string => {
    if (!intent) return "General";
    return intent
      .replace(/_/g, " ")
      .replace(/\b\w/g, (match) => match.toUpperCase());
  };

  const toSyntaxLanguage = (languageHint?: string, frameworkHint?: string): string => {
    const normalized = String(languageHint || "").trim().toLowerCase();
    const framework = String(frameworkHint || "").trim().toLowerCase();
    const jsxFramework =
      framework === "react" ||
      framework === "next.js" ||
      framework === "remix" ||
      framework === "solidjs" ||
      framework === "preact" ||
      framework === "react native" ||
      framework === "expo";

    if (framework === "vue" || framework === "nuxt" || framework === "svelte" || framework === "sveltekit") {
      return "html";
    }
    if (framework === "astro") return "astro";

    if (!normalized && jsxFramework) return "jsx";
    if (normalized === "typescript") return jsxFramework ? "tsx" : "typescript";
    if (normalized === "javascript" && jsxFramework) return "jsx";
    if (normalized === "javascript") return "javascript";
    if (normalized === "python") return "python";
    if (normalized === "kotlin") return "kotlin";
    if (normalized === "swift") return "swift";
    if (normalized === "php") return "php";
    if (normalized === "ruby") return "ruby";
    if (normalized === "scala") return "scala";
    if (normalized === "dart") return "dart";
    if (normalized === "sql") return "sql";
    if (normalized === "java") return "java";
    if (normalized === "c++") return "cpp";
    if (normalized === "c#") return "csharp";
    if (normalized === "go") return "go";
    if (normalized === "rust") return "rust";
    return normalized || "javascript";
  };

  const extractCodeBlock = (content: string) => {
    const match = content.match(/```(\w+)?\n([\s\S]+?)```/);
    if (!match || typeof match.index !== "number") return null;
    return {
      language: match[1] || "",
      code: match[2].trim(),
      before: content.slice(0, match.index).trim(),
      after: content.slice(match.index + match[0].length).trim()
    };
  };

  const copyToClipboard = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      addLog("success", `📋 Copied ${label}`);
    } catch (error: any) {
      addLog("error", `❌ Failed to copy ${label}: ${error?.message || "unknown error"}`);
    }
  };

  const renderAnswerContent = (item: AnswerSuggestion) => {
    if (!item.response) return null;

    const extracted = extractCodeBlock(item.response);
    if (extracted) {
      return (
        <div className="meeting-answer-rendered space-y-2">
          {extracted.before && (
            <div className="meeting-answer-response whitespace-pre-wrap text-sm">{extracted.before}</div>
          )}
          <div className="meeting-answer-code-shell">
            <div className="meeting-answer-code-toolbar">
              <span className="meeting-answer-code-label">
                {normalizeLanguageLabel(extracted.language || item.responseMetadata?.language) || "Code"}
              </span>
              <button
                type="button"
                onClick={() => copyToClipboard(extracted.code, "code")}
                className="meeting-answer-copy-button"
              >
                Copy
              </button>
            </div>
            <SyntaxHighlighter
              language={toSyntaxLanguage(
                extracted.language || item.responseMetadata?.language || item.languageHint,
                item.responseMetadata?.framework || item.frameworkHint
              )}
              style={dracula}
              customStyle={{
                margin: 0,
                padding: "0.85rem",
                borderRadius: "0.8rem",
                fontSize: "0.75rem",
                lineHeight: "1.55",
                background: "rgba(2, 6, 23, 0.92)"
              }}
              showLineNumbers
              wrapLongLines
            >
              {extracted.code}
            </SyntaxHighlighter>
          </div>
          {extracted.after && (
            <div className="meeting-answer-response whitespace-pre-wrap text-sm">{extracted.after}</div>
          )}
        </div>
      );
    }

    const parsed = parseLLMResponse(item.response);
    if (parsed.type === "code" || parsed.type === "structured") {
      return (
        <div className="meeting-answer-rendered space-y-2">
          <div className="meeting-answer-code-shell">
            <div className="meeting-answer-code-toolbar">
              <span className="meeting-answer-code-label">
                {normalizeLanguageLabel(parsed.language || item.responseMetadata?.language) || "Code"}
              </span>
              <button
                type="button"
                onClick={() => copyToClipboard(parsed.content, "code")}
                className="meeting-answer-copy-button"
              >
                Copy
              </button>
            </div>
            <SyntaxHighlighter
              language={toSyntaxLanguage(
                parsed.language || item.responseMetadata?.language || item.languageHint,
                item.responseMetadata?.framework || item.frameworkHint
              )}
              style={dracula}
              customStyle={{
                margin: 0,
                padding: "0.85rem",
                borderRadius: "0.8rem",
                fontSize: "0.75rem",
                lineHeight: "1.55",
                background: "rgba(2, 6, 23, 0.92)"
              }}
              showLineNumbers
              wrapLongLines
            >
              {parsed.content}
            </SyntaxHighlighter>
          </div>
          {parsed.metadata?.thoughts && parsed.metadata.thoughts.length > 0 && (
            <div className="meeting-answer-response whitespace-pre-wrap text-sm">
              {parsed.metadata.thoughts.join("\n")}
            </div>
          )}
        </div>
      );
    }

    return <div className="meeting-answer-response whitespace-pre-wrap text-sm">{item.response}</div>;
  };

  const toTranscriptPayload = (payload: string | LiveTranscriptPayload): LiveTranscriptPayload => {
    if (typeof payload === "string") return { text: payload, source: "user" };
    return {
      text: payload?.text || "",
      source: payload?.source === "interviewer" ? "interviewer" : "user",
    };
  };

  const flushDetectedQuestion = async () => {
    const contextVersion = contextVersionRef.current;
    if (isManualCaptureMode()) {
      pendingDetectionRef.current = null;
      return;
    }
    if (questionClassificationInFlightRef.current) return;
    const pending = pendingDetectionRef.current;
    pendingDetectionRef.current = null;
    if (!pending) return;
    questionClassificationInFlightRef.current = true;

    try {
      const classifiedCandidate = await resolveCandidateForAnswer(pending);
      if (contextVersion !== contextVersionRef.current) return;

      const threshold = getQuestionDetectionThreshold(
        classifiedCandidate.question,
        classifiedCandidate.role || meetingRole
      );
      if (classifiedCandidate.confidence < threshold) {
        addLog(
          "info",
          `🧠 Ignored low-confidence question (${Math.round(classifiedCandidate.confidence * 100)}% < ${Math.round(
            threshold * 100
          )}%): ${truncate(
            classifiedCandidate.question,
            80
          )}`
        );
        return;
      }

      const signature = normalizeQuestionSignature(classifiedCandidate.question);
      const now = Date.now();
      const cooldownMs = Math.max(answerThrottleMs, 3000);
      if (
        signature &&
        signature === lastQuestionSignatureRef.current &&
        now - lastQuestionTimestampRef.current < cooldownMs
      ) {
        return;
      }

      lastQuestionSignatureRef.current = signature;
      lastQuestionTimestampRef.current = now;
      addLog(
        "info",
        `🧠 Question detected [${classifiedCandidate.intent || "other"}${
          classifiedCandidate.languageHint ? ` | ${classifiedCandidate.languageHint}` : ""
        }] (${Math.round(classifiedCandidate.confidence * 100)}%): ${truncate(classifiedCandidate.question, 80)}`
      );

      addDetectedQuestionAnalytics(classifiedCandidate);
      syncProblemMemoryFromCandidate(classifiedCandidate);

      if (isManualCaptureMode()) return;
      generateAnswer(classifiedCandidate);
    } finally {
      if (contextVersion !== contextVersionRef.current) return;
      questionClassificationInFlightRef.current = false;
    }
  };

  const handleTranscriptForAnswer = (payload: LiveTranscriptPayload) => {
    if (isManualCaptureMode()) return;
    const shouldProcess = hasInterviewerAudioRef.current ? payload.source === "interviewer" : payload.source === "user";
    if (!shouldProcess) return;

    const candidateFromPayload = buildHeuristicQuestionCandidate(
      payload.text,
      payload.source,
      appendLastAskedTranscriptContext(buildConversationContext(6)),
      meetingRole
    );
    const recentMergedText = transcriptHistoryRef.current
      .slice(-4)
      .map((entry) => entry.text)
      .join(" ")
      .trim();
    const candidateFromRecent = recentMergedText
      ? buildHeuristicQuestionCandidate(
          recentMergedText,
          payload.source,
          appendLastAskedTranscriptContext(buildConversationContext(8)),
          meetingRole
        )
      : null;
    const candidate =
      !candidateFromPayload
        ? candidateFromRecent
        : !candidateFromRecent
        ? candidateFromPayload
        : candidateFromRecent.confidence >= candidateFromPayload.confidence
        ? candidateFromRecent
        : candidateFromPayload;
    if (!candidate) return;

    const existing = pendingDetectionRef.current;
    if (
      existing &&
      candidate.detectedAt - existing.detectedAt < 1800 &&
      normalizeQuestionSignature(candidate.question) !== normalizeQuestionSignature(existing.question)
    ) {
      const mergedQuestion = `${existing.question} ${candidate.question}`.replace(/\s+/g, " ").trim();
      const mergedContext = appendLastAskedTranscriptContext(buildConversationContext(8));
      const mergedCandidate = buildHeuristicQuestionCandidate(
        mergedQuestion,
        candidate.source,
        mergedContext,
        meetingRole
      );
      pendingDetectionRef.current = mergedCandidate
        ? {
            ...mergedCandidate,
            id: mergedCandidate.id,
            confidence: Math.max(existing.confidence, mergedCandidate.confidence),
            detectedAt: candidate.detectedAt,
          }
        : candidate;
    } else {
      pendingDetectionRef.current = candidate;
    }

    if (questionDebounceRef.current) {
      clearTimeout(questionDebounceRef.current);
    }
    questionDebounceRef.current = setTimeout(() => {
      flushDetectedQuestion().catch((error: any) => {
        addLog("warning", `⚠️ Question detection flush failed: ${error?.message || "unknown"}`);
      });
    }, 1400);
  };

  const appendTranscriptEntry = (transcript: LiveTranscriptPayload) => {
    if (!shouldProcessLiveAudio()) return;
    const normalizedText = transcript.text.trim();
    if (!normalizedText) return;
    const timestamp = Date.now();
    const signature = `${transcript.source}:${normalizedText.toLowerCase()}`;
    const lastSignature = lastTranscriptSignatureRef.current;
    if (lastSignature && lastSignature.signature === signature && timestamp - lastSignature.timestamp < 1400) {
      return;
    }
    lastTranscriptSignatureRef.current = { signature, timestamp };
    const transcriptEntry: MeetingTranscript = {
      timestamp,
      text: normalizedText,
      source: transcript.source,
    };
    transcriptHistoryRef.current = [...transcriptHistoryRef.current, transcriptEntry].slice(-24);

    const segment: TranscriptSegmentAnalytics = {
      id: `segment-${timestamp}-${Math.random().toString(16).slice(2, 8)}`,
      timestamp,
      text: normalizedText,
      source: transcript.source,
      provider: sttStatus?.provider || resolvedSttProvider || "unknown",
      latencyMs:
        sttStatus && Number.isFinite(sttStatus.avgSttLatencyMs)
          ? Math.max(0, Math.round(sttStatus.avgSttLatencyMs))
          : undefined,
      dropped: false
    };
    updateAnalyticsRef((current) => ({
      ...current,
      transcriptSegments: [segment, ...(current.transcriptSegments || [])].slice(0, 240)
    }));

    if (isManualCaptureActive()) {
      manualQuestionSegmentsRef.current = [...manualQuestionSegmentsRef.current, normalizedText].slice(-12);
      updateManualQuestionPreview(manualQuestionSegmentsRef.current.join(" ").trim());
    }

    addLog("success", `📄 [${formatSourceLabel(transcript.source)}] "${normalizedText}"`);
    setLiveTranscript({ ...transcript, text: normalizedText });
    setPartialTranscript(null);
    setMeeting((prev) => {
      if (!prev) return null;
      return { ...prev, transcripts: [...prev.transcripts, transcriptEntry] };
    });

    handleTranscriptForAnswer({ ...transcript, text: normalizedText });
  };

  const blobToBase64 = (blob: Blob): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const result = typeof reader.result === "string" ? reader.result : "";
        const commaIndex = result.indexOf(",");
        resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
      };
      reader.onerror = () => reject(new Error("Failed to read audio chunk"));
      reader.readAsDataURL(blob);
    });

  const cancelManualQuestionCapture = (message?: string) => {
    manualQuestionRecordingRef.current = false;
    manualQuestionFinalizingRef.current = false;
    manualQuestionSegmentsRef.current = [];
    if (manualQuestionFinalizeTimerRef.current) {
      clearTimeout(manualQuestionFinalizeTimerRef.current);
      manualQuestionFinalizeTimerRef.current = null;
    }
    setIsManualQuestionRecording(false);
    setIsManualQuestionProcessing(false);
    updateManualQuestionPreview("");
    setLiveTranscript(null);
    setPartialTranscript(null);
    if (message) {
      addLog("warning", message);
    }
  };

  const finalizeManualQuestionCapture = () => {
    if (manualQuestionFinalizeTimerRef.current) {
      clearTimeout(manualQuestionFinalizeTimerRef.current);
      manualQuestionFinalizeTimerRef.current = null;
    }
    manualQuestionFinalizingRef.current = false;

    const question =
      manualQuestionSegmentsRef.current.join(" ").replace(/\s+/g, " ").trim() ||
      manualQuestionPreviewRef.current.trim();
    manualQuestionSegmentsRef.current = [];

    if (!question) {
      setIsManualQuestionProcessing(false);
      updateManualQuestionPreview("");
      setLiveTranscript(null);
      setPartialTranscript(null);
      addLog("warning", "⚠️ No question captured. Try recording again.");
      return;
    }

    const detectedAt = Date.now();
    const contextWindow = appendLastAskedTranscriptContext(buildConversationContext(8));
    const candidate: QuestionCandidate = {
      id: `manual-${detectedAt}`,
      question,
      source: "user",
      role: meetingRole,
      confidence: 1,
      contextWindow,
      detectedAt,
      understanding: buildQuestionUnderstanding(question, contextWindow, meetingRole),
      intent: inferMeetingIntent(question, contextWindow, meetingRole),
      languageHint: normalizeLanguageLabel(
        inferLanguageFromText(`${question}\n${contextWindow}\n${buildProblemMemoryContext(problemMemoryRef.current)}`)
      ),
      frameworkHint: normalizeFrameworkLabel(
        inferFrameworkFromText(`${question}\n${contextWindow}\n${buildProblemMemoryContext(problemMemoryRef.current)}`)
      )
    };

    lastAnsweredRef.current = null;
    lastQuestionSignatureRef.current = normalizeQuestionSignature(question);
    lastQuestionTimestampRef.current = detectedAt;
    addDetectedQuestionAnalytics(candidate);
    updateManualQuestionPreview(question);
    setIsManualQuestionProcessing(false);
    setLiveTranscript(null);
    setPartialTranscript(null);
    addLog("info", `🎙️ Manual question ready: ${truncate(question, 80)}`);
    generateAnswer(candidate).catch((error: any) => {
      addLog("error", `❌ Manual answer failed: ${error?.message || "unknown error"}`);
    });
  };

  const startManualQuestionCapture = () => {
    if (!meetingStateRef.current.isRecording || meetingStateRef.current.isPaused) {
      setError("Resume the meeting before recording a manual question.");
      return;
    }
    if (!micEnabledRef.current) {
      setError("Turn the mic on before recording a manual question.");
      return;
    }
    if (isManualQuestionProcessing || isManualQuestionRecording) return;

    if (manualQuestionFinalizeTimerRef.current) {
      clearTimeout(manualQuestionFinalizeTimerRef.current);
      manualQuestionFinalizeTimerRef.current = null;
    }
    manualQuestionSegmentsRef.current = [];
    manualQuestionRecordingRef.current = true;
    manualQuestionFinalizingRef.current = false;
    setIsManualQuestionRecording(true);
    setIsManualQuestionProcessing(false);
    updateManualQuestionPreview("");
    setLiveTranscript(null);
    setPartialTranscript(null);
    setError(null);
    addLog("info", "🎙️ Manual question capture started.");
  };

  const stopManualQuestionCapture = () => {
    if (!manualQuestionRecordingRef.current) return;
    manualQuestionRecordingRef.current = false;
    manualQuestionFinalizingRef.current = true;
    setIsManualQuestionRecording(false);
    setIsManualQuestionProcessing(true);
    setPartialTranscript(null);
    manualQuestionFinalizeTimerRef.current = setTimeout(() => {
      finalizeManualQuestionCapture();
    }, 900);
  };

  const submitTypedQuestion = () => {
    const question = typedQuestionInput.replace(/\s+/g, " ").trim();
    if (!question) return;

    const detectedAt = Date.now();
    const contextWindow = appendLastAskedTranscriptContext(buildConversationContext(8));
    const candidate: QuestionCandidate = {
      id: `typed-${detectedAt}`,
      question,
      source: "user",
      role: meetingRole,
      confidence: 1,
      contextWindow,
      detectedAt,
      understanding: buildQuestionUnderstanding(question, contextWindow, meetingRole),
      intent: inferMeetingIntent(question, contextWindow, meetingRole),
      languageHint: normalizeLanguageLabel(
        inferLanguageFromText(`${question}\n${contextWindow}\n${buildProblemMemoryContext(problemMemoryRef.current)}`)
      ),
      frameworkHint: normalizeFrameworkLabel(
        inferFrameworkFromText(`${question}\n${contextWindow}\n${buildProblemMemoryContext(problemMemoryRef.current)}`)
      )
    };

    lastAnsweredRef.current = null;
    lastQuestionSignatureRef.current = normalizeQuestionSignature(question);
    lastQuestionTimestampRef.current = detectedAt;
    addDetectedQuestionAnalytics(candidate);
    setTypedQuestionInput("");
    setError(null);
    addLog("info", `⌨️ Typed question submitted: ${truncate(question, 80)}`);
    generateAnswer(candidate).catch((error: any) => {
      addLog("error", `❌ Typed question failed: ${error?.message || "unknown error"}`);
    });
  };

  const stopChunkedTranscription = () => {
    const recorder = mediaRecorderRef.current;
    if (!recorder) return;
    recorder.ondataavailable = null;
    recorder.onerror = null;
    recorder.onstop = null;
    try {
      if (recorder.state !== "inactive") recorder.stop();
    } catch {
      // no-op
    }
    mediaRecorderRef.current = null;
    chunkTranscriptionInFlightRef.current = false;
    chunkQueueRef.current = [];
  };

  const startChunkedTranscription = (stream: MediaStream) => {
    stopChunkedTranscription();

    const preferredMimeTypes = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
    const selectedMimeType =
      preferredMimeTypes.find((type) => MediaRecorder.isTypeSupported?.(type)) || "";

    const recorder = selectedMimeType
      ? new MediaRecorder(stream, { mimeType: selectedMimeType })
      : new MediaRecorder(stream);

    const processChunkQueue = async () => {
      if (chunkTranscriptionInFlightRef.current) return;
      chunkTranscriptionInFlightRef.current = true;

      try {
        while (chunkQueueRef.current.length > 0) {
          if (!meetingStateRef.current.isRecording || meetingStateRef.current.isPaused) break;
          if (!micEnabledRef.current) {
            chunkQueueRef.current = [];
            break;
          }
          if (!shouldProcessLiveAudio()) {
            chunkQueueRef.current = [];
            break;
          }
          const nextChunk = chunkQueueRef.current.shift();
          if (!nextChunk) continue;

          const mimeType = nextChunk.type || selectedMimeType || "audio/webm";
          const startedAt = Date.now();
          const base64 = await blobToBase64(nextChunk);
          const result = await window.electronAPI.meeting.transcribeChunk(base64, mimeType);
          if (!result.success) {
            if (result.error) {
              addLog("error", `❌ Chunk STT error: ${result.error}`);
            }
            continue;
          }
          const transcript = (result.transcript || "").trim();
          if (transcript) {
            appendTranscriptEntry({ text: transcript, source: "user" });
          }

          updateAnalyticsRef((current) => ({
            ...current,
            performance: {
              ...(current.performance || {}),
              droppedAudioChunks: droppedLocalChunksRef.current,
              avgSttLatencyMs: Date.now() - startedAt
            } as MeetingPerformanceSnapshot
          }));
        }
      } catch (error: any) {
        addLog("error", `❌ Chunk STT failed: ${error?.message || "Unknown transcription error"}`);
      } finally {
        chunkTranscriptionInFlightRef.current = false;
      }
    };

    recorder.ondataavailable = (event: BlobEvent) => {
      if (!event.data || event.data.size === 0) return;
      if (!meetingStateRef.current.isRecording || meetingStateRef.current.isPaused) return;
      if (!micEnabledRef.current) return;
      if (!shouldProcessLiveAudio()) return;

      chunkQueueRef.current.push(event.data);
      if (chunkQueueRef.current.length > maxChunkQueue) {
        chunkQueueRef.current.shift();
        droppedLocalChunksRef.current += 1;
      }
      processChunkQueue().catch(() => undefined);
    };

    recorder.onerror = (event: any) => {
      addLog("error", `❌ Chunk recorder error: ${event?.error?.message || "unknown"}`);
    };

    recorder.start(chunkRateMs);
    mediaRecorderRef.current = recorder;
    addLog(
      "success",
      `✅ Chunked STT recorder started (${chunkRateMs}ms chunks, queue cap ${maxChunkQueue})`
    );
  };

  const teardownAudioCapture = async () => {
    if (manualQuestionFinalizeTimerRef.current) {
      clearTimeout(manualQuestionFinalizeTimerRef.current);
      manualQuestionFinalizeTimerRef.current = null;
    }
    manualQuestionRecordingRef.current = false;
    manualQuestionFinalizingRef.current = false;
    manualQuestionSegmentsRef.current = [];

    for (const pipeline of audioPipelinesRef.current) {
      try {
        pipeline.sourceNode.disconnect();
      } catch {
        // no-op
      }
      try {
        pipeline.workletNode.disconnect();
      } catch {
        // no-op
      }
      try {
        pipeline.sinkGainNode.disconnect();
      } catch {
        // no-op
      }
    }
    audioPipelinesRef.current = [];

    const context = audioContextRef.current;
    audioContextRef.current = null;
    if (context && context.state !== "closed") {
      try {
        await context.close();
      } catch {
        // no-op
      }
    }

    [micStreamRef.current, interviewerStreamRef.current].forEach((stream) => {
      stream?.getTracks().forEach((track) => track.stop());
    });
    micStreamRef.current = null;
    interviewerStreamRef.current = null;
    hasInterviewerAudioRef.current = false;
    stopChunkedTranscription();
  };

  const createAudioPipeline = (audioContext: AudioContext, stream: MediaStream, source: MeetingAudioSource) => {
    const sourceNode = audioContext.createMediaStreamSource(stream);
    const workletNode = new AudioWorkletNode(audioContext, "pcm-processor");
    const sinkGainNode = audioContext.createGain();
    sinkGainNode.gain.value = 0;

    workletNode.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      const state = meetingStateRef.current;
      if (!state.isRecording || state.isPaused) return;
      if (source === "user" && !micEnabledRef.current) return;
      if (!shouldProcessLiveAudio()) return;
      window.electronAPI.audio.sendPCM(event.data, source);
    };

    sourceNode.connect(workletNode);
    workletNode.connect(sinkGainNode);
    sinkGainNode.connect(audioContext.destination);
    audioPipelinesRef.current.push({ sourceNode, workletNode, sinkGainNode });
  };

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  useEffect(() => {
    const user = getCurrentUser();
    if (!user) return;
    try {
      localStorage.setItem(
        `${RESOURCE_SCOPE_KEY_PREFIX}${user.id}`,
        JSON.stringify(resourceScopeSelection)
      );
    } catch {
      // no-op
    }
  }, [resourceScopeSelection]);

  useEffect(() => {
    const user = getCurrentUser();
    if (!user) return;
    try {
      localStorage.setItem(`${STT_PROVIDER_KEY_PREFIX}${user.id}`, selectedSttProvider);
    } catch {
      // no-op
    }
  }, [selectedSttProvider]);

  useEffect(() => {
    const user = getCurrentUser();
    if (!user) return;
    try {
      localStorage.setItem(`${MEETING_ROLE_KEY_PREFIX}${user.id}`, meetingRole);
    } catch {
      // no-op
    }
  }, [meetingRole]);

  useEffect(() => {
    if (resolvedSttProvider !== "puter") return;
    ensurePuterSdk().catch((error: any) => {
      addLog("warning", `⚠️ Puter SDK not ready: ${error?.message || "unknown error"}`);
    });
  }, [resolvedSttProvider]);

  useEffect(() => {
    if (transcriptScrollRef.current) {
      transcriptScrollRef.current.scrollTop = transcriptScrollRef.current.scrollHeight;
    }
  }, [meeting?.transcripts, liveTranscript, partialTranscript]);

  useEffect(() => {
    meetingStateRef.current = {
      isRecording: Boolean(meeting?.isRecording),
      isPaused: Boolean(meeting?.isPaused),
    };
  }, [meeting?.isPaused, meeting?.isRecording]);

  useEffect(() => {
    micEnabledRef.current = isMicEnabled;
  }, [isMicEnabled]);

  useEffect(() => {
    addLog("info", "🎬 Meeting mode started");

    const unsubscribeTranscript = window.electronAPI.meeting.onTranscript((payload) => {
      const transcript = toTranscriptPayload(payload);
      if (!shouldProcessLiveAudio()) return;
      appendTranscriptEntry(transcript);
    });

    const unsubscribePartial = window.electronAPI.meeting.onPartial((payload) => {
      const partial = toTranscriptPayload(payload);
      if (!partial.text.trim()) return;
      if (!shouldProcessLiveAudio()) return;
      setPartialTranscript(partial);
      if (isManualCaptureActive()) {
        const committed = manualQuestionSegmentsRef.current.join(" ").trim();
        updateManualQuestionPreview(`${committed} ${partial.text}`.replace(/\s+/g, " ").trim());
      }
    });

    const unsubscribeError = window.electronAPI.meeting.onError((payload) => {
      const source = payload.source === "interviewer" ? "Interviewer" : "You";
      addLog("error", `❌ STT error [${source}]: ${payload.message}`);
      const lower = payload.message.toLowerCase();
      if (
        lower.includes("credential") ||
        lower.includes("permission") ||
        lower.includes("google") ||
        lower.includes("authentication")
      ) {
        setError(
          "Speech-to-text authentication failed. Configure Google credentials (GOOGLE_APPLICATION_CREDENTIALS or google-service-file.json)."
        );
      }
    });

    const unsubscribeSttStatus = window.electronAPI.meeting.onSttStatus((payload) => {
      setSttStatus(payload);
      updateAnalyticsRef((current) => ({
        ...current,
        performance: {
          ...(current.performance || {}),
          droppedAudioChunks: payload.droppedAudioChunks,
          queueHighWaterMark: payload.queueHighWaterMark,
          reconnectCount: payload.reconnectCount,
          fallbackCount: payload.fallbackCount,
          avgSttLatencyMs: payload.avgSttLatencyMs
        }
      }));
    });

    const unsubscribePuterRequest = window.electronAPI.meeting.onPuterTranscribeRequest((payload) => {
      const handleRequest = async () => {
        if (!payload?.requestId) return;
        try {
          const transcript = await transcribeWithPuter(payload.audioBase64, payload.mimeType);
          await window.electronAPI.meeting.respondPuterTranscribe(payload.requestId, {
            success: true,
            transcript
          });
        } catch (error: any) {
          await window.electronAPI.meeting.respondPuterTranscribe(payload.requestId, {
            success: false,
            error: error?.message || "Puter transcription failed"
          });
        }
      };
      handleRequest().catch(() => undefined);
    });

    return () => {
      if (meetingStateRef.current.isRecording) {
        meetingStateRef.current = { isRecording: false, isPaused: false };
        teardownAudioCapture().catch(() => undefined);
        window.electronAPI.meeting.stop().catch(() => undefined);
      }

      unsubscribeTranscript();
      unsubscribePartial();
      unsubscribeError();
      unsubscribeSttStatus();
      unsubscribePuterRequest();

      if (durationIntervalRef.current) clearInterval(durationIntervalRef.current);
      if (questionDebounceRef.current) {
        clearTimeout(questionDebounceRef.current);
        questionDebounceRef.current = null;
      }
      if (manualQuestionFinalizeTimerRef.current) {
        clearTimeout(manualQuestionFinalizeTimerRef.current);
        manualQuestionFinalizeTimerRef.current = null;
      }
      if (analyticsSyncTimerRef.current) {
        clearTimeout(analyticsSyncTimerRef.current);
        analyticsSyncTimerRef.current = null;
      }
    };
  }, []);

  const startRecording = async () => {
    if (!meetingTitle.trim()) {
      setError("Enter a title");
      return;
    }

    let meetingStarted = false;
    try {
      setError(null);
      setDuration(0);
      setLiveTranscript(null);
      setPartialTranscript(null);
      setAnswers([]);
      setTypedQuestionInput("");
      setIsScreenAnswering(false);
      contextVersionRef.current += 1;
      answerInFlightRef.current = false;
      questionClassificationInFlightRef.current = false;
      updateProblemMemory(null, { replace: true });
      setIsMicEnabled(true);
      micEnabledRef.current = true;
      transcriptHistoryRef.current = [];
      pendingAnswerRef.current = null;
      pendingDetectionRef.current = null;
      lastAnsweredRef.current = null;
      lastQuestionSignatureRef.current = null;
      lastQuestionTimestampRef.current = 0;
      lastTranscriptSignatureRef.current = null;
      hasInterviewerAudioRef.current = false;
      cloudOffloadAttemptedRef.current = false;
      chunkQueueRef.current = [];
      droppedLocalChunksRef.current = 0;
      modelLastCallAtRef.current = 0;
      answerLastStartedAtRef.current = 0;
      manualQuestionRecordingRef.current = false;
      manualQuestionFinalizingRef.current = false;
      manualQuestionSegmentsRef.current = [];
      if (manualQuestionFinalizeTimerRef.current) {
        clearTimeout(manualQuestionFinalizeTimerRef.current);
        manualQuestionFinalizeTimerRef.current = null;
      }
      setIsManualQuestionRecording(false);
      setIsManualQuestionProcessing(false);
      updateManualQuestionPreview("");
      analyticsRef.current = buildMeetingAnalytics();
      if (questionDebounceRef.current) {
        clearTimeout(questionDebounceRef.current);
        questionDebounceRef.current = null;
      }

      const scopedResources = getCurrentResources();
      const scopedJdIds = getEffectiveSelectedJdIds(scopedResources);
      const scopedResourceFolderIds = getEffectiveSelectedResourceFolderIds(scopedResources);
      const hasScopedKnowledge = scopedResources.knowledge.some((item) =>
        scopedResourceFolderIds.has(item.folderId || DEFAULT_KNOWLEDGE_FOLDER_ID)
      );
      const hasScopedContext =
        (resourceScopeSelection.resume && scopedResources.resume.trim().length > 0) ||
        (resourceScopeSelection.jd && scopedJdIds.size > 0) ||
        (resourceScopeSelection.resources && scopedResourceFolderIds.size > 0 && hasScopedKnowledge);

      if (!hasScopedContext) {
        addLog("warning", "⚠️ No resource folders selected. Answers will use live conversation only.");
      } else {
        addLog("info", `📚 Active folders: ${getSelectedFolderLabels().join(", ")}`);
      }
      addLog("info", `🧭 Meeting role: ${getMeetingRoleLabel(meetingRole)}`);

      if (resolvedSttProvider === "puter") {
        await ensurePuterSdk();
        addLog("success", "✅ Puter STT bridge ready");
      }

      const micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      micStreamRef.current = micStream;
      micStream.getAudioTracks().forEach((track) => {
        track.enabled = true;
      });
      addLog("success", "✅ Mic capture enabled");

      const activeSources: MeetingAudioSource[] = ["user"];
      if (useChunkedStt) {
        addLog("info", `🆓 Using chunked STT mode (${resolvedSttProvider}).`);
      } else {
        try {
          const displayStream = await navigator.mediaDevices.getDisplayMedia({
            audio: true,
            video: true,
          });

          if (displayStream.getAudioTracks().length > 0) {
            interviewerStreamRef.current = displayStream;
            hasInterviewerAudioRef.current = true;
            activeSources.push("interviewer");
            addLog("success", "✅ Interviewer audio capture enabled");
          } else {
            displayStream.getTracks().forEach((track) => track.stop());
            addLog("warning", "⚠️ Shared screen has no audio track. Continuing with mic-only mode.");
          }
        } catch (displayError: any) {
          addLog(
            "warning",
            `⚠️ Interviewer audio unavailable (${displayError?.name || "not granted"}). Continuing with mic-only mode.`
          );
        }
      }

      const sttStartOptions =
        selectedSttProvider === "auto"
          ? undefined
          : {
              sttProvider: selectedSttProvider,
              sttProviderChain: getConfiguredSttProviderChain(selectedSttProvider)
            };
      const result = await window.electronAPI.meeting.start(
        meetingTitle.trim(),
        activeSources,
        sttStartOptions
      );
      if (!result.success || !result.meetingId) throw new Error(result.error || "Failed");
      meetingStarted = true;

      addLog("success", `✅ Started: ${result.meetingId}`);
      if (result.provider) {
        addLog("info", `🧠 STT provider active: ${result.provider}`);
      }
      setShowTitleInput(false);

      const newMeeting: Meeting = {
        id: result.meetingId,
        title: meetingTitle.trim(),
        startTime: Date.now(),
        isRecording: true,
        isPaused: false,
        notes: [],
        transcripts: [],
        analytics: analyticsRef.current
      };
      setMeeting(newMeeting);
      meetingStateRef.current = { isRecording: true, isPaused: false };
      await syncMeetingAnalytics(true);

      if (useChunkedStt) {
        startChunkedTranscription(micStream);
        addLog("success", "🎬 Listening with chunked STT");
      } else {
        const audioContext = new AudioContext({ sampleRate: 16000 });
        audioContextRef.current = audioContext;
        await audioContext.audioWorklet.addModule("/renderer/audio/audioWorklet.js");
        addLog("success", "✅ Audio worklet loaded");

        createAudioPipeline(audioContext, micStream, "user");
        if (interviewerStreamRef.current) {
          createAudioPipeline(audioContext, interviewerStreamRef.current, "interviewer");
        }

        addLog(
          "success",
          activeSources.includes("interviewer") ? "🎬 Streaming user + interviewer audio" : "🎬 Streaming mic audio"
        );
      }

      durationIntervalRef.current = setInterval(() => {
        setDuration((prev) => prev + 1);
      }, 1000);
    } catch (err: any) {
      meetingStateRef.current = { isRecording: false, isPaused: false };
      micEnabledRef.current = true;
      setIsMicEnabled(true);
      await teardownAudioCapture();
      if (meetingStarted) {
        try {
          await window.electronAPI.meeting.stop();
        } catch {
          // no-op
        }
      }
      setMeeting(null);
      setShowTitleInput(true);
      addLog("error", `❌ ${err.message}`);
      setError(err.name === "NotAllowedError" ? "Mic denied" : err.message);
    }
  };

  const togglePause = async () => {
    if (!meeting) return;
    try {
      if (meeting.isPaused) {
        const result = await window.electronAPI.meeting.resume();
        if (result.success) {
          setMeeting((prev) => {
            if (!prev) return null;
            const next = { ...prev, isPaused: false };
            meetingStateRef.current = { isRecording: next.isRecording, isPaused: next.isPaused };
            return next;
          });
          if (useChunkedStt && mediaRecorderRef.current?.state === "paused") {
            try {
              mediaRecorderRef.current.resume();
            } catch {
              if (micStreamRef.current) {
                startChunkedTranscription(micStreamRef.current);
              }
            }
          }
          addLog("success", "▶️ Resumed");
        }
      } else {
        const result = await window.electronAPI.meeting.pause();
        if (result.success) {
          if (isManualQuestionRecording || isManualQuestionProcessing) {
            cancelManualQuestionCapture("🎙️ Manual question capture cancelled while paused.");
          }
          setMeeting((prev) => {
            if (!prev) return null;
            const next = { ...prev, isPaused: true };
            meetingStateRef.current = { isRecording: next.isRecording, isPaused: next.isPaused };
            return next;
          });
          if (useChunkedStt && mediaRecorderRef.current?.state === "recording") {
            try {
              mediaRecorderRef.current.pause();
            } catch {
              stopChunkedTranscription();
            }
            setPartialTranscript(null);
          }
          addLog("warning", "⏸️ Paused");
        }
      }
    } catch (err: any) {
      addLog("error", `❌ ${err.message}`);
    }
  };

  const toggleMicCapture = () => {
    if (!meeting?.isRecording) return;
    const nextEnabled = !micEnabledRef.current;
    micEnabledRef.current = nextEnabled;
    setIsMicEnabled(nextEnabled);

    if (micStreamRef.current) {
      micStreamRef.current.getAudioTracks().forEach((track) => {
        track.enabled = nextEnabled;
      });
    }

    if (!nextEnabled) {
      if (isManualQuestionRecording || isManualQuestionProcessing) {
        cancelManualQuestionCapture("🎙️ Manual question capture cancelled because the mic was muted.");
      }
      chunkQueueRef.current = [];
      setPartialTranscript(null);
      addLog("warning", "🔇 Mic muted (your voice is not being transcribed)");
      return;
    }

    addLog("success", "🎤 Mic unmuted");
  };

  const stopRecording = async () => {
    if (!meeting?.isRecording) return;
    pendingDetectionRef.current = null;
    pendingAnswerRef.current = null;
    if (questionDebounceRef.current) {
      clearTimeout(questionDebounceRef.current);
      questionDebounceRef.current = null;
    }
    if (isManualQuestionRecording || isManualQuestionProcessing) {
      cancelManualQuestionCapture();
    }

    updateAnalyticsRef((current) => ({
      ...current,
      controls: {
        cpuMode,
        chunkRateMs,
        maxChunkQueue,
        answerThrottleMs,
        modelThrottleMs,
        cloudOffload
      },
      performance: {
        ...(current.performance || {}),
        droppedAudioChunks:
          (current.performance?.droppedAudioChunks || 0) + droppedLocalChunksRef.current,
        queueHighWaterMark: Math.max(
          current.performance?.queueHighWaterMark || 0,
          sttStatus?.queueHighWaterMark || 0
        ),
        reconnectCount: sttStatus?.reconnectCount || current.performance?.reconnectCount || 0,
        fallbackCount: sttStatus?.fallbackCount || current.performance?.fallbackCount || 0,
        avgSttLatencyMs:
          sttStatus?.avgSttLatencyMs || current.performance?.avgSttLatencyMs || 0
      }
    }));
    await syncMeetingAnalytics(true);
    meetingStateRef.current = { isRecording: false, isPaused: false };
    micEnabledRef.current = true;
    setIsMicEnabled(true);

    await teardownAudioCapture();
    if (durationIntervalRef.current) {
      clearInterval(durationIntervalRef.current);
      durationIntervalRef.current = null;
    }

    addLog("info", "🛑 Stopping...");
    try {
      const localMeetingSnapshot = meeting;
      const result = await window.electronAPI.meeting.stop();
      if (result.success && result.meeting) {
        const mergedPerformanceBase = {
          ...(result.meeting.analytics?.performance || {}),
          ...(analyticsRef.current.performance || {})
        } as Partial<MeetingPerformanceSnapshot>;

        const mergedAnalytics: MeetingAnalytics = {
          transcriptSegments:
            analyticsRef.current.transcriptSegments?.length
              ? analyticsRef.current.transcriptSegments
              : result.meeting.analytics?.transcriptSegments || [],
          detectedQuestions:
            analyticsRef.current.detectedQuestions?.length
              ? analyticsRef.current.detectedQuestions
              : result.meeting.analytics?.detectedQuestions || [],
          answers:
            analyticsRef.current.answers?.length
              ? analyticsRef.current.answers
              : result.meeting.analytics?.answers || [],
          controls: analyticsRef.current.controls ||
            result.meeting.analytics?.controls || {
              cpuMode,
              chunkRateMs,
              maxChunkQueue,
              answerThrottleMs,
              modelThrottleMs,
              cloudOffload
            },
          performance: {
            droppedAudioChunks: mergedPerformanceBase.droppedAudioChunks || 0,
            queueHighWaterMark: mergedPerformanceBase.queueHighWaterMark || 0,
            reconnectCount: mergedPerformanceBase.reconnectCount || 0,
            fallbackCount: mergedPerformanceBase.fallbackCount || 0,
            avgSttLatencyMs: mergedPerformanceBase.avgSttLatencyMs || 0
          }
        };
        const mergedMeeting: Meeting = {
          ...result.meeting,
          transcripts:
            localMeetingSnapshot?.transcripts && localMeetingSnapshot.transcripts.length > 0
              ? localMeetingSnapshot.transcripts
              : result.meeting.transcripts || [],
          analytics: mergedAnalytics
        };
        transcriptHistoryRef.current = mergedMeeting.transcripts || [];
        setMeeting(mergedMeeting);
        setLiveTranscript(null);
        setPartialTranscript(null);
        addLog("success", "✅ Meeting saved");
        if (onMeetingSaved) {
          try {
            await onMeetingSaved(mergedMeeting);
            addLog("success", "☁️ Synced meeting history");
          } catch (syncError: any) {
            addLog("error", `⚠️ History sync failed: ${syncError?.message || "Unknown error"}`);
          }
        }
      }
    } catch (err: any) {
      addLog("error", `❌ ${err.message}`);
    }
  };

  const handleEndMeeting = async () => {
    if (isEndingMeeting) return;
    setIsEndingMeeting(true);
    try {
      if (meeting?.isRecording) {
        await stopRecording();
      }
      onClose();
    } finally {
      setIsEndingMeeting(false);
    }
  };

  useEffect(() => {
    if (!endRequestToken) return;
    if (endRequestToken === lastHandledEndRequestRef.current) return;
    lastHandledEndRequestRef.current = endRequestToken;
    handleEndMeeting().catch((error) => {
      addLog("error", `❌ Failed to end meeting: ${error?.message || "unknown error"}`);
    });
  }, [endRequestToken]);

  const formatDuration = (seconds: number) => {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return `${hrs.toString().padStart(2, "0")}:${mins.toString().padStart(2, "0")}:${secs
      .toString()
      .padStart(2, "0")}`;
  };

  const toggleJdSelection = (jdId: string) => {
    setResourceScopeSelection((prev) => {
      const resources = getCurrentResources();
      const allIds = resources.documents.map((item) => item.id);
      const next = new Set(prev.jdIds.length > 0 ? prev.jdIds : allIds);
      if (next.has(jdId)) {
        next.delete(jdId);
      } else {
        next.add(jdId);
      }
      const compacted = next.size === allIds.length ? [] : Array.from(next);
      return {
        ...prev,
        jdIds: compacted
      };
    });
  };

  const toggleResourceFolderSelection = (folderId: string) => {
    setResourceScopeSelection((prev) => {
      const resources = getCurrentResources();
      const allIds = resources.knowledgeFolders.map((folder) => folder.id);
      const next = new Set(prev.resourceFolderIds.length > 0 ? prev.resourceFolderIds : allIds);
      if (next.has(folderId)) {
        next.delete(folderId);
      } else {
        next.add(folderId);
      }
      const compacted = next.size === allIds.length ? [] : Array.from(next);
      return {
        ...prev,
        resourceFolderIds: compacted
      };
    });
  };

  if (showTitleInput && !meeting) {
    const currentUser = getCurrentUser();
    const resources = currentUser
      ? loadResources(currentUser.id)
      : { resume: "", documents: [], knowledge: [], knowledgeFolders: [] };
    const selectedJdIds = getEffectiveSelectedJdIds(resources);
    const selectedResourceFolderIds = getEffectiveSelectedResourceFolderIds(resources);
    const knowledgeCountByFolder = resources.knowledge.reduce<Record<string, number>>((acc, item) => {
      const folderId = item.folderId || DEFAULT_KNOWLEDGE_FOLDER_ID;
      acc[folderId] = (acc[folderId] || 0) + 1;
      return acc;
    }, {});

    return (
      <div
        className={`meeting-mode-shell meeting-mode-start mx-auto w-full min-w-0 rounded-2xl p-5 ${
          compact ? "max-w-[680px]" : "max-w-[860px]"
        }`}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold text-slate-900">🎤 Start Meeting</h2>
          <button onClick={onClose} className="rounded-lg p-1.5 text-slate-600 transition hover:bg-slate-100">
            {compact ? (
              <span className="px-2 text-sm font-semibold text-slate-700">Back</span>
            ) : (
              <X className="h-4 w-4 text-gray-600" />
            )}
          </button>
        </div>

        {error && (
          <div className="mb-3 rounded-lg border border-red-300 bg-red-50 p-2.5 text-sm text-red-700">{error}</div>
        )}

        <input
          type="text"
          value={meetingTitle}
          onChange={(e) => setMeetingTitle(e.target.value)}
          placeholder="Meeting title..."
          className="mb-4 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
          onKeyDown={(e) => e.key === "Enter" && startRecording()}
          autoFocus
        />

        <div className="meeting-section mb-4 rounded-xl p-3">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-700">
            Interview Role
          </div>
          <div className="inline-flex rounded-xl border border-slate-200 bg-white p-1 text-xs font-semibold">
            <button
              type="button"
              onClick={() => handleMeetingRoleChange("developer")}
              className={`rounded-lg px-3 py-1.5 transition ${
                meetingRole === "developer"
                  ? "bg-blue-600 text-white shadow-sm"
                  : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              Developer
            </button>
            <button
              type="button"
              onClick={() => handleMeetingRoleChange("product_manager")}
              className={`rounded-lg px-3 py-1.5 transition ${
                meetingRole === "product_manager"
                  ? "bg-blue-600 text-white shadow-sm"
                  : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              Product Manager
            </button>
          </div>
          <div className="mt-2 text-[11px] text-slate-600">
            {getMeetingRoleDescription(meetingRole)}
          </div>
        </div>

        <div className="meeting-section mb-4 rounded-xl p-3">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-700">
            {meetingRole === "product_manager"
              ? "Context Folders (for PM answers)"
              : "RAG Folders (for interview answers)"}
          </div>
          <div className="space-y-1.5 text-xs text-slate-700">
            <label className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5">
              <input
                type="checkbox"
                checked={resourceScopeSelection.resume}
                onChange={(event) =>
                  setResourceScopeSelection((prev) => ({ ...prev, resume: event.target.checked }))
                }
              />
              Resume ({resources.resume.trim() ? "available" : "empty"})
            </label>
            <label className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5">
              <input
                type="checkbox"
                checked={resourceScopeSelection.jd}
                onChange={(event) =>
                  setResourceScopeSelection((prev) => ({ ...prev, jd: event.target.checked }))
                }
              />
              Interview JD ({selectedJdIds.size}/{resources.documents.length})
            </label>
            {resourceScopeSelection.jd && resources.documents.length > 0 && (
              <div className="rounded-lg border border-slate-200 bg-white p-2">
                <div className="mb-1 text-[11px] font-semibold text-slate-700">Choose JD file(s)</div>
                <div className="max-h-20 space-y-1 overflow-y-auto">
                  {resources.documents.map((item) => (
                    <label key={item.id} className="flex items-center gap-2 text-[11px] text-slate-700">
                      <input
                        type="checkbox"
                        checked={selectedJdIds.has(item.id)}
                        onChange={() => toggleJdSelection(item.id)}
                      />
                      <span className="truncate">{item.title}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
            <label className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5">
              <input
                type="checkbox"
                checked={resourceScopeSelection.resources}
                onChange={(event) =>
                  setResourceScopeSelection((prev) => ({ ...prev, resources: event.target.checked }))
                }
              />
              Resource Folders ({selectedResourceFolderIds.size}/{resources.knowledgeFolders.length})
            </label>
            {resourceScopeSelection.resources && resources.knowledgeFolders.length > 0 && (
              <div className="rounded-lg border border-slate-200 bg-white p-2">
                <div className="mb-1 text-[11px] font-semibold text-slate-700">Choose resource folders</div>
                <div className="max-h-24 space-y-1 overflow-y-auto">
                  {resources.knowledgeFolders.map((folder) => (
                    <label key={folder.id} className="flex items-center gap-2 text-[11px] text-slate-700">
                      <input
                        type="checkbox"
                        checked={selectedResourceFolderIds.has(folder.id)}
                        onChange={() => toggleResourceFolderSelection(folder.id)}
                      />
                      <span className="truncate">
                        {folder.name} [{RESOURCE_FOLDER_TYPE_LABELS[folder.type]}] (
                        {knowledgeCountByFolder[folder.id] || 0})
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>
          <div className="mt-2 text-[11px] text-slate-600">
            AI will search only selected folders and can use multiple folders together.
          </div>
        </div>

        <div className="meeting-section mb-4 rounded-xl p-3">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-700">
            Speech-To-Text Provider
          </div>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-slate-700">Provider</span>
            <select
              value={selectedSttProvider}
              onChange={(event) =>
                setSelectedSttProvider(normalizeSttProviderChoice(event.target.value))
              }
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800"
            >
              <option value="auto">Auto ({envDefaultSttProvider})</option>
              <option value="elevenlabs">ElevenLabs Realtime</option>
              <option value="puter">Puter (renderer bridge)</option>
              <option value="groq">Groq Whisper</option>
              <option value="google">Google Speech</option>
            </select>
          </label>
          <div className="mt-2 text-[11px] text-slate-600">
            Active provider: <strong>{resolvedSttProvider}</strong>.{" "}
            {useStreamingStt
              ? "Realtime streaming mode (supports interviewer audio capture)."
              : "Chunked mode (runs robust fallback chain through main pipeline)."}
          </div>
          {resolvedSttProvider === "puter" && (
            <div className="mt-1 text-[11px] text-slate-600">
              Uses Puter JS in renderer while keeping reconnect/backpressure/fallback orchestration in Electron main.
            </div>
          )}
        </div>

        <div className="meeting-section mb-4 rounded-xl p-3">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-700">
            Answer Trigger
          </div>
          <div className="inline-flex rounded-xl border border-slate-200 bg-white p-1 text-xs font-semibold">
            <button
              type="button"
              onClick={() => setAnswerCaptureMode("auto")}
              className={`rounded-lg px-3 py-1.5 transition ${
                answerCaptureMode === "auto"
                  ? "bg-blue-600 text-white shadow-sm"
                  : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              Auto
            </button>
            <button
              type="button"
              onClick={() => setAnswerCaptureMode("manual")}
              className={`rounded-lg px-3 py-1.5 transition ${
                answerCaptureMode === "manual"
                  ? "bg-blue-600 text-white shadow-sm"
                  : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              Manual
            </button>
          </div>
          <div className="mt-2 text-[11px] text-slate-600">
            {answerCaptureMode === "manual"
              ? `AI answers only after you tap Record question and stop recording in ${getMeetingRoleLabel(meetingRole)} mode.`
              : `AI listens to the live transcript and answers when it detects a likely ${getMeetingRoleLabel(meetingRole).toLowerCase()} question.`}
          </div>
        </div>

        <div className="meeting-section mb-4 rounded-xl p-3">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-700">
            Performance Controls
          </div>
          <div className="grid grid-cols-1 gap-2 text-xs md:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="text-slate-700">CPU Mode</span>
              <select
                value={cpuMode}
                onChange={(event) => setCpuMode(event.target.value as CpuMode)}
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800"
              >
                <option value="low">Low CPU</option>
                <option value="balanced">Balanced</option>
                <option value="high">High accuracy</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-slate-700">Chunk Rate (ms)</span>
              <input
                type="number"
                min={600}
                max={6000}
                value={chunkRateMs}
                onChange={(event) => setChunkRateMs(Math.max(600, Math.min(6000, Number(event.target.value) || 1800)))}
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-slate-700">Model Throttle (ms)</span>
              <input
                type="number"
                min={0}
                max={10000}
                value={modelThrottleMs}
                onChange={(event) => setModelThrottleMs(Math.max(0, Math.min(10000, Number(event.target.value) || 0)))}
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800"
              />
            </label>
            <label className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs text-slate-700">
              <input
                type="checkbox"
                checked={cloudOffload}
                readOnly
                disabled
              />
              Cloud API answers (API-only)
            </label>
          </div>
        </div>

        <button
          onClick={startRecording}
          disabled={!meetingTitle.trim()}
          className="app-btn app-btn-primary flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-rose-500 to-red-600 px-3 py-3 text-base text-white shadow-lg hover:from-rose-600 hover:to-red-700 disabled:cursor-not-allowed disabled:opacity-55"
        >
          <Mic className="h-3 w-3" />
          Start {getMeetingRoleLabel(meetingRole)} Meeting
        </button>

        {logs.length > 0 && (
          <div className="mt-3 max-h-28 overflow-y-auto rounded-lg border border-slate-200 bg-white p-2 text-xs">
            {logs.slice(-3).map((log, i) => (
              <div key={i} className="mb-1 text-slate-700">
                {log.message}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className={`meeting-mode-shell meeting-mode-live chat-container mx-auto flex w-full min-w-0 flex-col p-4 ${
        compact ? "max-w-[700px]" : "max-w-[880px]"
      }`}
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1">
          <div className="flex items-center gap-1 rounded bg-white/20 px-2 py-1 text-xs text-white">
            <Mic className="h-3 w-3 text-white" />
            <span className="font-semibold">{meeting?.title}</span>
          </div>
          <div className="flex items-center gap-1 rounded bg-white/20 px-2 py-1 text-xs text-white">
            <BriefcaseBusiness className="h-3 w-3 text-white" />
            <span className="font-semibold">{getMeetingRoleLabel(meetingRole)}</span>
          </div>
          {meeting?.isRecording && (
            <div className="flex items-center gap-1 rounded bg-white/20 px-2 py-1 text-xs text-white">
              <div
                className={`h-1.5 w-1.5 rounded-full ${
                  meeting.isPaused ? "bg-yellow-500" : "animate-pulse bg-red-500"
                }`}
              />
              <span className="font-mono">{formatDuration(duration)}</span>
            </div>
          )}
        </div>

        <div className="flex gap-1">
          {meeting?.isRecording && (
            <>
              <button
                onClick={togglePause}
                className="flex items-center gap-1 rounded bg-yellow-500/80 px-2 py-1 text-xs text-white hover:bg-yellow-600/80"
              >
                {meeting.isPaused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
                {meeting.isPaused ? "Resume" : "Pause"}
              </button>
              <button
                onClick={toggleMicCapture}
                className={`flex items-center gap-1 rounded px-2 py-1 text-xs text-white ${
                  isMicEnabled ? "bg-emerald-600/80 hover:bg-emerald-700/80" : "bg-slate-600/80 hover:bg-slate-700/80"
                }`}
              >
                {isMicEnabled ? <Mic className="h-3 w-3" /> : <MicOff className="h-3 w-3" />}
                {isMicEnabled ? "Mic On" : "Mic Off"}
              </button>
            </>
          )}
          <button
            onClick={() => setShowDebug(!showDebug)}
            className={`flex items-center gap-1 rounded px-2 py-1 text-xs text-white ${
              showDebug ? "bg-blue-500/80" : "bg-white/20"
            }`}
          >
            <Terminal className="h-3 w-3" />
            Debug
          </button>
          <button
            onClick={compact ? handleEndMeeting : onClose}
            disabled={compact && isEndingMeeting}
            className={`rounded px-2 py-1 text-xs text-white ${
              compact
                ? "bg-red-500/80 hover:bg-red-600/80 disabled:cursor-not-allowed disabled:opacity-60"
                : "bg-white/20"
            }`}
          >
            {compact ? (isEndingMeeting ? "Ending..." : "End Meeting") : <X className="h-3 w-3" />}
          </button>
        </div>
      </div>

      {meeting?.isRecording && (liveTranscript || partialTranscript) && (
        <div className="mb-3 rounded-xl border border-blue-300/45 bg-gradient-to-r from-sky-500/30 via-cyan-500/20 to-emerald-500/25 p-3">
          <div className="mb-1 flex items-center gap-1">
            <div className="h-2 w-2 animate-pulse rounded-full bg-blue-500" />
            <span className="text-xs font-bold text-white">LIVE</span>
          </div>
          {liveTranscript && (
            <p className="mb-1 text-sm font-medium text-white">
              <span className="font-semibold text-white">{formatSourceLabel(liveTranscript.source)}:</span>{" "}
              {liveTranscript.text}
            </p>
          )}
          {partialTranscript && (
            <p className="text-sm italic text-white/90">
              <span className="font-semibold text-white">{formatSourceLabel(partialTranscript.source)}:</span>{" "}
              {partialTranscript.text}
            </p>
          )}
        </div>
      )}

      {sttStatus && (
        <div className="mb-3 rounded-xl border border-white/35 bg-slate-900/45 p-2.5 text-xs text-slate-100">
          <div className="flex flex-wrap items-center gap-3">
            <span>
              Provider: <strong>{sttStatus.provider || "unknown"}</strong>
            </span>
            <span>Reconnects: {sttStatus.reconnectCount}</span>
            <span>Fallbacks: {sttStatus.fallbackCount}</span>
            <span>Dropped chunks: {sttStatus.droppedAudioChunks}</span>
            <span>Avg STT latency: {Math.round(sttStatus.avgSttLatencyMs)}ms</span>
          </div>
        </div>
      )}

      <div
        className={`mb-3 grid ${compact ? "min-h-[260px]" : "min-h-[320px]"} flex-1 grid-cols-1 gap-3 md:grid-cols-2`}
      >
        <div
          ref={transcriptScrollRef}
          className="meeting-scroll-panel meeting-transcript-panel max-h-[52vh] overflow-y-auto rounded-xl p-3"
        >
          <div className="mb-2 flex items-center justify-between">
            <h3 className="meeting-transcript-title text-sm font-bold">Conversation</h3>
            <div className="flex items-center gap-2">
              {meeting?.isRecording && (
                <button
                  type="button"
                  onClick={handleClearMeetingContext}
                  disabled={isClearingContext}
                  className={`meeting-answer-action-button meeting-answer-clear-button rounded border px-2 py-1 text-xs font-semibold transition ${
                    isClearingContext ? "is-disabled cursor-not-allowed" : ""
                  }`}
                >
                  {isClearingContext ? "Clearing..." : "Clear context"}
                </button>
              )}
              <span className="meeting-transcript-count text-xs">{meeting?.transcripts.length || 0} lines</span>
            </div>
          </div>

          {(!meeting || meeting.transcripts.length === 0) && !partialTranscript && !liveTranscript && (
            <div className="meeting-transcript-empty py-8 text-center text-xs">
              <Mic className="meeting-transcript-empty-icon mx-auto mb-2 h-8 w-8" />
              <p>Waiting for transcript...</p>
            </div>
          )}

          <div className="space-y-2">
            {meeting?.transcripts.map((item, i) => (
              <div key={`${item.timestamp}-${i}`} className="meeting-transcript-card rounded-lg p-2.5">
                <div className="mb-1 flex items-center justify-between">
                  <span className="meeting-transcript-speaker text-xs font-semibold">
                    {formatSourceLabel(item.source === "interviewer" ? "interviewer" : "user")}
                  </span>
                  <span className="meeting-transcript-time font-mono text-[10px]">
                    {new Date(item.timestamp).toLocaleTimeString()}
                  </span>
                </div>
                <p className="meeting-transcript-text text-sm">{item.text}</p>
              </div>
            ))}

            {partialTranscript && (
              <div className="meeting-transcript-live rounded p-2">
                <div className="mb-1 flex items-center gap-1">
                  <div className="meeting-transcript-live-dot h-1.5 w-1.5 animate-pulse rounded-full" />
                  <span className="meeting-transcript-live-label text-xs font-semibold">
                    {formatSourceLabel(partialTranscript.source)} (live)
                  </span>
                </div>
                <p className="meeting-transcript-live-text text-sm italic">{partialTranscript.text}</p>
              </div>
            )}
          </div>
        </div>

        <div className="meeting-scroll-panel meeting-answer-panel max-h-[52vh] overflow-y-auto rounded-xl p-3">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="meeting-answer-title text-sm font-bold">
              {meetingRole === "product_manager" ? "PM Answers" : "AI Answers"}
            </h3>
            <div className="meeting-answer-toolbar flex flex-wrap items-center justify-end gap-2">
              <div className="meeting-answer-mode-toggle inline-flex rounded-lg p-0.5 text-xs font-semibold">
                <button
                  type="button"
                  onClick={() => handleMeetingRoleChange("developer")}
                  className={`meeting-answer-mode-button rounded-md px-2 py-1 transition ${
                    meetingRole === "developer" ? "is-active" : ""
                  }`}
                >
                  Developer
                </button>
                <button
                  type="button"
                  onClick={() => handleMeetingRoleChange("product_manager")}
                  className={`meeting-answer-mode-button rounded-md px-2 py-1 transition ${
                    meetingRole === "product_manager" ? "is-active" : ""
                  }`}
                >
                  Product Manager
                </button>
              </div>
              <div className="meeting-answer-mode-toggle inline-flex rounded-lg p-0.5 text-xs font-semibold">
                <button
                  type="button"
                  onClick={() => setAnswerCaptureMode("auto")}
                  disabled={isManualQuestionRecording || isManualQuestionProcessing}
                  className={`meeting-answer-mode-button rounded-md px-2 py-1 transition ${
                    answerCaptureMode === "auto"
                      ? "is-active"
                      : ""
                  } disabled:cursor-not-allowed disabled:opacity-60`}
                >
                  Auto
                </button>
                <button
                  type="button"
                  onClick={() => setAnswerCaptureMode("manual")}
                  disabled={isManualQuestionRecording || isManualQuestionProcessing}
                  className={`meeting-answer-mode-button rounded-md px-2 py-1 transition ${
                    answerCaptureMode === "manual"
                      ? "is-active"
                      : ""
                  } disabled:cursor-not-allowed disabled:opacity-60`}
                >
                  Manual
                </button>
              </div>
              {answerCaptureMode === "manual" && (
                <button
                  type="button"
                  onClick={isManualQuestionRecording ? stopManualQuestionCapture : startManualQuestionCapture}
                  disabled={isManualQuestionProcessing || meeting?.isPaused || !isMicEnabled}
                  className={`meeting-answer-action-button rounded border px-2 py-1 text-xs font-semibold transition ${
                    isManualQuestionRecording
                      ? "is-recording"
                      : isManualQuestionProcessing || meeting?.isPaused || !isMicEnabled
                      ? "is-disabled cursor-not-allowed"
                      : "is-manual"
                  }`}
                >
                  {isManualQuestionRecording
                    ? "Stop question"
                    : isManualQuestionProcessing
                    ? "Processing..."
                    : "Record question"}
                </button>
              )}
              <button
                type="button"
                onClick={handleAnswerFromScreen}
                disabled={isScreenAnswering || meetingRole === "product_manager"}
                className={`meeting-answer-action-button meeting-answer-screen-button rounded border px-2 py-1 text-xs font-semibold transition ${
                  isScreenAnswering || meetingRole === "product_manager"
                    ? "is-disabled cursor-not-allowed"
                    : ""
                }`}
              >
                {meetingRole === "product_manager"
                  ? "Screen Q&A (Dev only)"
                  : isScreenAnswering
                  ? "Analyzing screen..."
                  : "Answer from screen"}
              </button>
              <span className="meeting-answer-count text-xs">{answers.length} items</span>
            </div>
          </div>

          {answerCaptureMode === "manual" && (
            <div
              className={`meeting-answer-callout mb-3 rounded-lg px-3 py-2 text-xs ${
                isManualQuestionRecording
                  ? "is-recording"
                  : isManualQuestionProcessing
                  ? "is-processing"
                  : manualQuestionPreview
                  ? "has-preview"
                  : ""
              }`}
            >
              <div className="font-semibold">Manual mode</div>
              <div className="mt-1">
                {isManualQuestionRecording
                  ? "Recording your mic question now. Click Stop question when you finish."
                  : isManualQuestionProcessing
                  ? "Finalizing the captured question and preparing the answer..."
                  : manualQuestionPreview
                  ? `Last captured question: ${manualQuestionPreview}`
                  : "Click Record question to capture only your next question, then the AI will answer after you stop."}
              </div>
            </div>
          )}

          <form
            className="mb-3 flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              submitTypedQuestion();
            }}
          >
            <input
              type="text"
              value={typedQuestionInput}
              onChange={(event) => setTypedQuestionInput(event.target.value)}
              placeholder="Type a question and press Enter"
              disabled={isManualQuestionRecording || isManualQuestionProcessing}
              className="meeting-answer-input min-w-0 flex-1 rounded-lg px-3 py-2 text-sm focus:outline-none disabled:cursor-not-allowed"
            />
            <button
              type="submit"
              disabled={
                isManualQuestionRecording ||
                isManualQuestionProcessing ||
                typedQuestionInput.replace(/\s+/g, " ").trim().length === 0
              }
              className="meeting-answer-send rounded-lg px-3 py-2 text-xs font-semibold transition disabled:cursor-not-allowed"
            >
              Send
            </button>
          </form>

          {answers.length === 0 ? (
            <div className="meeting-answer-empty py-8 text-center text-xs">
              <MessageSquare className="meeting-answer-empty-icon mx-auto mb-2 h-8 w-8" />
              <p>No answers yet</p>
              <p className="meeting-answer-empty-subtext mt-1 text-xs">
                {answerCaptureMode === "manual"
                  ? `Manual mode is on. Record a question and stop to generate a ${getMeetingRoleLabel(meetingRole)} answer.`
                  : `Answers appear when a likely ${getMeetingRoleLabel(meetingRole).toLowerCase()} question is detected.`}
              </p>
              {!hasInterviewerAudioRef.current && (
                <p className="meeting-answer-empty-subtext mt-1 text-xs">Mic-only mode is active; question detection uses mic transcript.</p>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              {answers.map((item) => (
                <div key={item.id} className="meeting-answer-card rounded-lg p-2.5">
                  <div className="mb-1 flex items-center justify-between">
                    <span className="meeting-answer-card-label text-xs font-semibold">Question</span>
                    <span className="meeting-answer-time font-mono text-[10px]">
                      {new Date(item.createdAt).toLocaleTimeString()}
                    </span>
                  </div>
                  <p className="meeting-answer-question mb-2 text-sm">{item.question}</p>

                  <div className="mb-2 flex flex-wrap items-center gap-1">
                    {(item.responseMetadata?.intent || item.intent) && (
                      <div className="meeting-answer-badge is-intent inline-flex items-center rounded px-2 py-0.5 text-xs font-semibold">
                        {formatIntentLabel(item.responseMetadata?.intent || item.intent)}
                      </div>
                    )}
                    {item.role !== "product_manager" && (item.responseMetadata?.language || item.languageHint) && (
                      <div className="meeting-answer-badge is-language inline-flex items-center rounded px-2 py-0.5 text-xs font-semibold">
                        {item.responseMetadata?.language || item.languageHint}
                      </div>
                    )}
                    {item.role !== "product_manager" && (item.responseMetadata?.framework || item.frameworkHint) && (
                      <div className="meeting-answer-badge is-framework inline-flex items-center rounded px-2 py-0.5 text-xs font-semibold">
                        {item.responseMetadata?.framework || item.frameworkHint}
                      </div>
                    )}
                  </div>

                  {typeof item.confidence === "number" && (
                    <div className="meeting-answer-badge is-confidence mb-2 inline-flex items-center rounded px-2 py-0.5 text-xs font-semibold">
                      {item.confidence}% confidence
                    </div>
                  )}

                  {typeof item.qualityOverall === "number" && (
                    <div className="meeting-answer-badge is-quality mb-2 ml-1 inline-flex items-center rounded px-2 py-0.5 text-xs font-semibold">
                      {Math.round(item.qualityOverall * 100)}% quality
                    </div>
                  )}

                  {item.status === "pending" && <div className="meeting-answer-status text-xs">Generating answer...</div>}
                  {item.status === "error" && (
                    <div className="meeting-answer-status is-error text-xs">{item.error || "Failed to generate answer."}</div>
                  )}
                  {item.status === "ready" && item.response && (
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center gap-1">
                        <span className="meeting-answer-badge is-stage rounded px-2 py-0.5 text-[10px] font-semibold">
                          {item.stage === "refined" ? "Refined" : "Draft"}
                        </span>
                        {item.isRefining && (
                          <span className="meeting-answer-badge is-refining rounded px-2 py-0.5 text-[10px] font-semibold">
                            Refining...
                          </span>
                        )}
                        {!item.isRefining && (
                          <button
                            type="button"
                            onClick={() => requestAnswerRefinement(item.id)}
                            className="meeting-answer-expand-button rounded border px-2 py-0.5 text-[10px]"
                          >
                            {item.stage === "refined" ? "Refine again" : "Refine"}
                          </button>
                        )}
                        {item.qualityNotes && (
                          <span className="meeting-answer-inline-note text-[10px]">{item.qualityNotes}</span>
                        )}
                      </div>
                      {renderAnswerContent(item)}

                      {item.role !== "product_manager" && (item.responseMetadata?.framework ||
                        item.responseMetadata?.approach ||
                        item.responseMetadata?.timeComplexity ||
                        item.responseMetadata?.spaceComplexity) && (
                        <div className="meeting-answer-understanding rounded px-2 py-1 text-xs">
                          <div className="font-semibold">Answer metadata</div>
                          {item.responseMetadata?.framework && (
                            <div className="mt-1">
                              <span className="font-semibold">Framework:</span> {item.responseMetadata.framework}
                            </div>
                          )}
                          {item.responseMetadata?.approach && (
                            <div className="mt-1">
                              <span className="font-semibold">Approach:</span> {item.responseMetadata.approach}
                            </div>
                          )}
                          {(item.responseMetadata?.timeComplexity || item.responseMetadata?.spaceComplexity) && (
                            <div className="mt-1">
                              <span className="font-semibold">Complexity:</span>{" "}
                              {item.responseMetadata?.timeComplexity || "n/a"} /{" "}
                              {item.responseMetadata?.spaceComplexity || "n/a"}
                            </div>
                          )}
                        </div>
                      )}

                      <div className="meeting-answer-expand-panel rounded px-2 py-1 text-xs">
                        <div className="meeting-answer-expand-title mb-1 font-semibold">Need another angle?</div>
                        <div className="flex flex-wrap gap-1">
                          {getExpansionSuggestions(item).map((suggestion) => {
                            const pendingSamePrompt = Boolean(
                              (item.deepDives || []).find(
                                (dive) =>
                                  dive.status === "pending" &&
                                  dive.prompt.toLowerCase() === suggestion.toLowerCase()
                              )
                            );
                            return (
                              <button
                                key={`${item.id}-expand-${suggestion}`}
                                type="button"
                                disabled={pendingSamePrompt}
                                onClick={() => requestAnswerExpansion(item.id, suggestion)}
                                className={`meeting-answer-expand-button rounded border px-2 py-0.5 text-xs ${
                                  pendingSamePrompt
                                    ? "is-disabled cursor-not-allowed"
                                    : ""
                                }`}
                              >
                                {pendingSamePrompt ? `${suggestion}...` : suggestion}
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      {item.deepDives && item.deepDives.length > 0 && (
                        <div className="meeting-answer-deepdive rounded px-2 py-1 text-xs">
                          <div className="meeting-answer-deepdive-title mb-1 font-semibold">More details</div>
                          <div className="space-y-1">
                            {item.deepDives.map((dive) => (
                              <div key={dive.id} className="meeting-answer-deepdive-item rounded px-2 py-1">
                                <div className="meeting-answer-deepdive-prompt mb-0.5 text-[10px] font-semibold">{dive.prompt}</div>
                                {dive.status === "pending" && (
                                  <div className="meeting-answer-deepdive-status text-[10px]">Generating details...</div>
                                )}
                                {dive.status === "error" && (
                                  <div className="meeting-answer-deepdive-status is-error text-[10px]">{dive.error || "Failed to generate details."}</div>
                                )}
                                {dive.status === "ready" && (
                                  <div className="meeting-answer-deepdive-response whitespace-pre-wrap text-xs">
                                    {dive.response}
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {item.understanding && (
                        <div className="meeting-answer-understanding rounded px-2 py-1 text-xs">
                          <div className="font-semibold">Extracted constraints / edge cases</div>
                          <div className="mt-1">
                            Constraints: {item.understanding.constraints.join(", ") || "none"}
                          </div>
                          <div>
                            Edge cases: {item.understanding.edgeCases.join(", ") || "none"}
                          </div>
                        </div>
                      )}
                      {(item.provider || item.model || typeof item.latencyMs === "number") && (
                        <div className="meeting-answer-metadata text-[10px]">
                          {item.provider ? `Provider: ${item.provider}` : "Provider: unknown"}{" "}
                          {item.model ? `• Model: ${item.model}` : ""}{" "}
                          {typeof item.latencyMs === "number" ? `• ${item.latencyMs}ms` : ""}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {showDebug && (
        <div className="mb-3 max-h-32 overflow-y-auto rounded bg-gray-900/90 p-2">
          <div className="space-y-0.5 font-mono text-[10px]">
            {logs.map((log, i) => (
              <div
                key={i}
                className={
                  log.level === "error"
                    ? "text-red-400"
                    : log.level === "warning"
                    ? "text-yellow-400"
                    : log.level === "success"
                    ? "text-green-400"
                    : "text-blue-400"
                }
              >
                {log.message}
              </div>
            ))}
            <div ref={logsEndRef} />
          </div>
        </div>
      )}
    </div>
  );
};

export default MeetingMode;
