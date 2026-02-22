import React, { useEffect, useRef, useState } from "react";
import { MessageSquare, Mic, MicOff, Pause, Play, Terminal, X } from "lucide-react";
import { cleanLLMResponse } from "../../utils/lmResponseParser";
import { getCurrentUser } from "../../lib/authStore";
import { loadResources, ResourceItem } from "../../lib/resourcesStore";
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
  response?: string;
  status: "pending" | "ready" | "error";
  createdAt: number;
  error?: string;
  confidence?: number;
  followUps?: string[];
  understanding?: CodingQuestionUnderstanding;
  qualityOverall?: number;
  latencyMs?: number;
  provider?: string;
  model?: string;
}

interface QuestionCandidate {
  id: string;
  question: string;
  source: MeetingAudioSource;
  confidence: number;
  contextWindow: string;
  detectedAt: number;
  understanding: CodingQuestionUnderstanding;
}

interface ParsedAnswerPayload {
  answer: string;
  followUps: string[];
  understanding: CodingQuestionUnderstanding;
  quality: {
    clarity: number;
    correctness: number;
    concision: number;
    relevance: number;
    overall: number;
  };
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
  compact?: boolean;
}

const MeetingMode: React.FC<MeetingModeProps> = ({ onClose, onMeetingSaved, compact = false }) => {
  const sttProvider = (import.meta.env.VITE_STT_PROVIDER || "elevenlabs").toLowerCase();
  const useStreamingStt = sttProvider === "google" || sttProvider === "elevenlabs";
  const useChunkedStt = !useStreamingStt;

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
  const [sttStatus, setSttStatus] = useState<SttStatusPayload | null>(null);
  const [isEndingMeeting, setIsEndingMeeting] = useState(false);
  const [cpuMode, setCpuMode] = useState<CpuMode>("balanced");
  const [chunkRateMs, setChunkRateMs] = useState<number>(1800);
  const [maxChunkQueue, setMaxChunkQueue] = useState<number>(8);
  const [answerThrottleMs, setAnswerThrottleMs] = useState<number>(1200);
  const [modelThrottleMs, setModelThrottleMs] = useState<number>(800);
  const [cloudOffload, setCloudOffload] = useState<boolean>(false);

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

  const audioContextRef = useRef<AudioContext | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const interviewerStreamRef = useRef<MediaStream | null>(null);
  const audioPipelinesRef = useRef<AudioPipelineNodes[]>([]);
  const meetingStateRef = useRef({ isRecording: false, isPaused: false });
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

  const clamp01 = (value: number) =>
    Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));

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

  const stopWords = useRef(
    new Set([
      "the",
      "a",
      "an",
      "and",
      "or",
      "to",
      "for",
      "of",
      "in",
      "on",
      "with",
      "is",
      "are",
      "was",
      "were",
      "be",
      "been",
      "being",
      "do",
      "does",
      "did",
      "can",
      "could",
      "would",
      "should",
      "what",
      "why",
      "how",
      "tell",
      "about",
      "me",
      "you",
      "we",
      "our",
      "your",
      "my",
      "i",
      "it",
      "this",
      "that",
      "these",
      "those",
      "as",
      "at",
      "from",
      "by",
      "have",
      "has",
      "had",
    ])
  );

  useEffect(() => {
    const controls = getControlsForCpuMode(cpuMode);
    setChunkRateMs(controls.chunkRateMs);
    setMaxChunkQueue(controls.maxChunkQueue);
    setAnswerThrottleMs(controls.answerThrottleMs);
    setModelThrottleMs(controls.modelThrottleMs);
  }, [cpuMode]);

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

  const tokenize = (text: string) =>
    (text.toLowerCase().match(/[a-z0-9]+/g) || []).filter(
      (token) => token.length > 2 && !stopWords.current.has(token)
    );

  const normalizeQuestionSignature = (text: string) =>
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const questionStarterRegex =
    /^(what|why|how|when|where|who|which|can you|could you|would you|will you|tell me|walk me through|describe|explain|give me|do you|are you|have you|did you)\b/i;
  const questionSignalRegex =
    /\b(explain|describe|walk me through|tell me|give me|compare|difference|trade-?off|approach|design|implement|optimi[sz]e|debug|why|how|what)\b/i;
  const technicalSignalRegex =
    /\b(array|string|graph|tree|heap|stack|queue|hash|map|set|dp|dynamic programming|greedy|binary search|two pointer|sliding window|sort|time complexity|space complexity|big o|edge case|constraints?)\b/i;
  const problemStatementRegex =
    /\b(you are given|given an? (integer|array|string|graph|tree)|group size|return (true|false)|consecutive|divide the array|can be divided|output|find|determine)\b/i;
  const followUpRegex = /^(and|also|then|what about|how about|plus|one more|another)\b/i;
  const nonQuestionFillerRegex = /^(ok|okay|right|sure|thanks|great|cool|nice|yep|yeah|hmm|uh|um)\b/i;
  const confirmationTailRegex = /\b(right|all right|ok|okay|correct)\?*$/i;
  const constraintSignalRegex =
    /\b(at most|at least|exactly|less than|greater than|no more than|must|cannot|without|in place|in-place|o\([^)]+\)|time complexity|space complexity|n\s*[<>=]{1,2}\s*\d+|k\s*[<>=]{1,2}\s*\d+)\b/gi;
  const edgeCaseSignalRegex =
    /\b(empty|null|undefined|single|one element|duplicate|negative|zero|overflow|underflow|sorted|reverse sorted|all same|all equal|large input)\b/gi;

  const extractQuestionUnderstanding = (
    question: string,
    contextWindow: string
  ): CodingQuestionUnderstanding => {
    const normalizedQuestion = question.replace(/\s+/g, " ").trim();
    const sourceText = `${contextWindow}\n${normalizedQuestion}`.toLowerCase();

    const constraints = Array.from(
      new Set((sourceText.match(constraintSignalRegex) || []).map(item => item.trim()))
    ).slice(0, 6);

    const edgeCases = Array.from(
      new Set((sourceText.match(edgeCaseSignalRegex) || []).map(item => item.trim()))
    ).slice(0, 6);

    const problemStatement = normalizedQuestion
      .replace(/^(can you|could you|would you|please|hey|ok|okay)\s+/i, "")
      .replace(/\?+$/, "")
      .trim();

    const defaultEdgeCases =
      edgeCases.length > 0
        ? edgeCases
        : [
            "empty input",
            "single element",
            "duplicates",
            "maximum constraint boundary"
          ];

    return {
      problemStatement: problemStatement || normalizedQuestion,
      constraints,
      edgeCases: defaultEdgeCases
    };
  };

  const splitTranscriptIntoCandidates = (text: string): string[] => {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (!normalized) return [];
    const sentences = normalized
      .split(/(?<=[?.!])\s+/)
      .map((item) => item.trim())
      .filter(Boolean);
    return sentences.length > 0 ? sentences : [normalized];
  };

  const scoreQuestionConfidence = (text: string): number => {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (!normalized) return 0;

    const words = normalized.split(" ").filter(Boolean);
    const hasQuestionMark = normalized.endsWith("?");
    const hasStarter = questionStarterRegex.test(normalized);
    const hasSignal = questionSignalRegex.test(normalized) || technicalSignalRegex.test(normalized);
    const hasProblemStatement = problemStatementRegex.test(normalized);
    const hasConfirmationTail = confirmationTailRegex.test(normalized);
    let score = 0;

    if (hasQuestionMark) score += 0.45;
    if (hasStarter) score += 0.32;
    if (questionSignalRegex.test(normalized)) score += 0.18;
    if (technicalSignalRegex.test(normalized)) score += 0.15;
    if (hasProblemStatement) score += 0.32;
    if (followUpRegex.test(normalized)) score += 0.12;
    if (words.length >= 7 && words.length <= 30) score += 0.1;
    if (words.length > 45) score -= 0.05;
    if (words.length < 6) score -= 0.25;
    if (nonQuestionFillerRegex.test(normalized) && words.length <= 5) score -= 0.4;
    if (hasConfirmationTail) score -= 0.45;
    if (!hasStarter && !hasSignal && !hasQuestionMark && !hasProblemStatement) score -= 0.25;

    return Math.max(0, Math.min(1, score));
  };

  const isLikelyInterviewQuestion = (question: string, confidence: number): boolean => {
    const normalized = question.replace(/\s+/g, " ").trim();
    const words = normalized.split(" ").filter(Boolean);
    const hasStarter = questionStarterRegex.test(normalized);
    const hasSignal = questionSignalRegex.test(normalized) || technicalSignalRegex.test(normalized);
    const hasQuestionMark = normalized.endsWith("?");
    const hasProblemStatement = problemStatementRegex.test(normalized);
    const confirmationOnly = confirmationTailRegex.test(normalized) && words.length <= 12;

    if (confirmationOnly && !hasStarter) return false;
    if (!hasStarter && !hasSignal && !hasQuestionMark && !hasProblemStatement) return false;
    if (words.length < 6 && !hasStarter) return false;
    if (hasProblemStatement && confidence >= 0.38) return true;
    if (confidence < 0.5) return false;
    return true;
  };

  const buildConversationContext = (maxTurns = 6): string => {
    const recentTurns = transcriptHistoryRef.current.slice(-maxTurns);
    return recentTurns
      .map((turn) => `${turn.source === "interviewer" ? "Interviewer" : "Candidate"}: ${turn.text}`)
      .join("\n");
  };

  const buildQuestionCandidate = (
    text: string,
    source: MeetingAudioSource,
    contextWindowOverride?: string
  ): QuestionCandidate | null => {
    const segments = splitTranscriptIntoCandidates(text);
    if (segments.length === 0) return null;

    let bestQuestion = "";
    let bestScore = 0;
    segments.forEach((segment, index) => {
      // Prefer later segments in a chunk, they more often contain the actual ask.
      const positionBoost = (index + 1) / Math.max(segments.length, 1) * 0.03;
      const score = Math.min(1, scoreQuestionConfidence(segment) + positionBoost);
      if (score > bestScore) {
        bestScore = score;
        bestQuestion = segment;
      }
    });

    if (!bestQuestion) return null;
    if (!isLikelyInterviewQuestion(bestQuestion, bestScore)) return null;
    const contextWindow = contextWindowOverride || buildConversationContext();
    return {
      id: `question-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      question: bestQuestion,
      source,
      confidence: bestScore,
      contextWindow,
      detectedAt: Date.now(),
      understanding: extractQuestionUnderstanding(bestQuestion, contextWindow),
    };
  };

  const truncate = (text: string, limit: number) => {
    if (text.length <= limit) return text;
    return `${text.slice(0, limit)}...`;
  };

  const scoreResource = (item: ResourceItem, tokens: string[]) => {
    const haystack = `${item.title} ${item.content} ${item.url || ""}`.toLowerCase();
    const title = item.title.toLowerCase();
    return tokens.reduce((score, token) => {
      if (haystack.includes(token)) {
        return score + (title.includes(token) ? 2 : 1);
      }
      return score;
    }, 0);
  };

  const selectRelevant = (items: ResourceItem[], tokens: string[], limit: number) => {
    if (items.length === 0) return [];
    const scored = items
      .map((item) => ({ item, score: scoreResource(item, tokens) }))
      .sort((a, b) => b.score - a.score);
    const filtered = scored.filter((entry) => entry.score > 0).slice(0, limit).map((entry) => entry.item);
    if (filtered.length > 0) return filtered;
    return scored.slice(0, limit).map((entry) => entry.item);
  };

  const buildResourceContext = (question: string) => {
    const user = getCurrentUser();
    if (!user) return { context: "", sources: [] as string[] };

    const resources = loadResources(user.id);
    const tokens = tokenize(question);
    const sections: string[] = [];
    const sources: string[] = [];

    if (resources.resume.trim()) {
      sections.push(`RESUME\n${truncate(resources.resume.trim(), 1200)}`);
      sources.push("Resume");
    }

    const docSelections = selectRelevant(resources.documents, tokens, 3);
    docSelections.forEach((item) => {
      sections.push(`DOCUMENT: ${item.title}\n${truncate(item.content.trim(), 800)}`);
      sources.push(item.title);
    });

    const knowledgeSelections = selectRelevant(resources.knowledge, tokens, 3);
    knowledgeSelections.forEach((item) => {
      sections.push(`KNOWLEDGE: ${item.title}\n${truncate(item.content.trim(), 800)}`);
      sources.push(item.title);
    });

    const combined = sections.join("\n\n");
    const maxLength = 4000;
    return {
      context: combined.length > maxLength ? `${combined.slice(0, maxLength)}...` : combined,
      sources,
    };
  };

  const parseAnswerPayload = (
    raw: string,
    fallbackCandidate: QuestionCandidate
  ): ParsedAnswerPayload => {
    const fallback: ParsedAnswerPayload = {
      answer: cleanLLMResponse(raw),
      followUps: [],
      understanding: fallbackCandidate.understanding,
      quality: {
        clarity: clamp01(fallbackCandidate.confidence),
        correctness: clamp01(fallbackCandidate.confidence),
        concision: 0.75,
        relevance: clamp01(fallbackCandidate.confidence),
        overall: clamp01((fallbackCandidate.confidence + 0.75 + fallbackCandidate.confidence) / 3)
      }
    };

    const sanitized = cleanLLMResponse(raw)
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```$/i, "")
      .trim();

    try {
      const parsed = JSON.parse(sanitized) as Record<string, any>;
      const answer =
        typeof parsed?.answer === "string" && parsed.answer.trim()
          ? parsed.answer.trim()
          : fallback.answer;
      const followUps = Array.isArray(parsed?.follow_ups)
        ? parsed.follow_ups.filter((item: unknown) => typeof item === "string").map((item: string) => item.trim()).filter(Boolean).slice(0, 4)
        : [];
      const understanding = parsed?.question_understanding
        ? {
            problemStatement:
              typeof parsed.question_understanding.problem_statement === "string"
                ? parsed.question_understanding.problem_statement.trim()
                : fallbackCandidate.understanding.problemStatement,
            constraints: Array.isArray(parsed.question_understanding.constraints)
              ? parsed.question_understanding.constraints
                  .filter((item: unknown) => typeof item === "string")
                  .map((item: string) => item.trim())
                  .filter(Boolean)
                  .slice(0, 8)
              : fallbackCandidate.understanding.constraints,
            edgeCases: Array.isArray(parsed.question_understanding.edge_cases)
              ? parsed.question_understanding.edge_cases
                  .filter((item: unknown) => typeof item === "string")
                  .map((item: string) => item.trim())
                  .filter(Boolean)
                  .slice(0, 8)
              : fallbackCandidate.understanding.edgeCases
          }
        : fallbackCandidate.understanding;

      const quality = {
        clarity: clamp01(Number(parsed?.quality?.clarity ?? fallback.quality.clarity)),
        correctness: clamp01(Number(parsed?.quality?.correctness ?? fallback.quality.correctness)),
        concision: clamp01(Number(parsed?.quality?.concision ?? fallback.quality.concision)),
        relevance: clamp01(Number(parsed?.quality?.relevance ?? fallback.quality.relevance)),
        overall: clamp01(
          Number(
            parsed?.quality?.overall ??
              (fallback.quality.clarity +
                fallback.quality.correctness +
                fallback.quality.concision +
                fallback.quality.relevance) /
                4
          )
        )
      };

      return { answer, followUps, understanding, quality };
    } catch {
      return fallback;
    }
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

  const generateAnswer = async (candidate: QuestionCandidate) => {
    const trimmed = candidate.question.trim();
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
      questionId: candidate.id,
      question: trimmed,
      status: "pending",
      createdAt: Date.now(),
      confidence: Math.round(candidate.confidence * 100),
      understanding: candidate.understanding
    };
    setAnswers((prev) => [pendingAnswer, ...prev].slice(0, 24));

    const { context } = buildResourceContext(trimmed);
    const user = getCurrentUser();
    const prompt = `You are an interview copilot for coding interviews.

Candidate: ${user?.name || "Candidate"}
Question source: ${candidate.source === "interviewer" ? "Interviewer" : "User"}

Recent conversation context:
${candidate.contextWindow || "No recent context."}

Detected question confidence: ${Math.round(candidate.confidence * 100)}%
Detected question: "${trimmed}"

Candidate resources:
${context || "No resources provided."}

Extracted coding intent:
- Problem statement: ${candidate.understanding.problemStatement}
- Constraints: ${candidate.understanding.constraints.join("; ") || "none detected"}
- Edge cases: ${candidate.understanding.edgeCases.join("; ") || "none detected"}

Return STRICT JSON only (no markdown):
{
  "answer": "one concise interview-ready response under 140 words",
  "follow_ups": ["optional short bullet 1", "optional short bullet 2"],
  "question_understanding": {
    "problem_statement": "normalized coding prompt",
    "constraints": ["constraint 1", "constraint 2"],
    "edge_cases": ["edge case 1", "edge case 2"]
  },
  "quality": {
    "clarity": 0.0,
    "correctness": 0.0,
    "concision": 0.0,
    "relevance": 0.0,
    "overall": 0.0
  }
}

Rules:
- Be direct and spoken-language friendly.
- If coding: include approach, core data structure, complexity, and one edge case.
- Keep follow_ups optional (0-2 bullets max).`;

    try {
      await maybeUseCloudOffload();
      await applyModelThrottle();

      const startedAt = Date.now();
      const [response, config] = await Promise.all([
        window.electronAPI.invoke("llm-chat", prompt),
        window.electronAPI.getCurrentLlmConfig().catch(() => ({
          provider: "groq" as const,
          model: "unknown",
          isOllama: false
        }))
      ]);
      const latencyMs = Date.now() - startedAt;
      const parsed = parseAnswerPayload(response, candidate);
      const cleaned = cleanLLMResponse(parsed.answer);
      const qualityOverall = clamp01(parsed.quality.overall);

      const answerAnalytics: AnswerAnalytics = {
        id: answerId,
        questionId: candidate.id,
        question: trimmed,
        answer: cleaned,
        followUps: parsed.followUps,
        provider: config.provider,
        model: config.model,
        createdAt: Date.now(),
        latencyMs,
        quality: parsed.quality
      };
      updateAnalyticsRef((current) => ({
        ...current,
        answers: [answerAnalytics, ...(current.answers || [])].slice(0, 80)
      }));

      setAnswers((prev) =>
        prev.map((item) =>
          item.id === answerId
            ? {
                ...item,
                response: cleaned,
                status: "ready",
                followUps: parsed.followUps,
                understanding: parsed.understanding,
                qualityOverall,
                latencyMs,
                provider: config.provider,
                model: config.model
              }
            : item
        )
      );
    } catch (err: any) {
      setAnswers((prev) =>
        prev.map((item) =>
          item.id === answerId ? { ...item, status: "error", error: err?.message || "Failed to generate answer." } : item
        )
      );
    } finally {
      answerInFlightRef.current = false;
      const pending = pendingAnswerRef.current;
      pendingAnswerRef.current = null;
      if (pending && normalizeQuestionSignature(pending.question) !== normalizeQuestionSignature(trimmed)) {
        generateAnswer(pending);
      }
    }
  };

  const formatSourceLabel = (source: MeetingAudioSource) => (source === "interviewer" ? "Interviewer" : "You");

  const toTranscriptPayload = (payload: string | LiveTranscriptPayload): LiveTranscriptPayload => {
    if (typeof payload === "string") return { text: payload, source: "user" };
    return {
      text: payload?.text || "",
      source: payload?.source === "interviewer" ? "interviewer" : "user",
    };
  };

  const flushDetectedQuestion = () => {
    const pending = pendingDetectionRef.current;
    pendingDetectionRef.current = null;
    if (!pending) return;

    const requiresLowerThreshold = problemStatementRegex.test(pending.question);
    const threshold = requiresLowerThreshold ? 0.42 : 0.68;
    if (pending.confidence < threshold) {
      addLog(
        "info",
        `🧠 Ignored low-confidence question (${Math.round(pending.confidence * 100)}%): ${truncate(
          pending.question,
          80
        )}`
      );
      return;
    }

    const signature = normalizeQuestionSignature(pending.question);
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
    addLog("info", `🧠 Question detected (${Math.round(pending.confidence * 100)}%): ${truncate(pending.question, 80)}`);

    const detectedQuestion: DetectedQuestionAnalytics = {
      id: pending.id,
      question: pending.question,
      source: pending.source,
      confidence: clamp01(pending.confidence),
      detectedAt: pending.detectedAt,
      contextWindow: pending.contextWindow,
      understanding: pending.understanding
    };
    updateAnalyticsRef((current) => ({
      ...current,
      detectedQuestions: [detectedQuestion, ...(current.detectedQuestions || [])].slice(0, 80)
    }));

    generateAnswer(pending);
  };

  const handleTranscriptForAnswer = (payload: LiveTranscriptPayload) => {
    const shouldProcess = hasInterviewerAudioRef.current ? payload.source === "interviewer" : payload.source === "user";
    if (!shouldProcess) return;

    const candidateFromPayload = buildQuestionCandidate(payload.text, payload.source);
    const recentMergedText = transcriptHistoryRef.current
      .slice(-4)
      .map((entry) => entry.text)
      .join(" ")
      .trim();
    const candidateFromRecent = recentMergedText
      ? buildQuestionCandidate(recentMergedText, payload.source, buildConversationContext(8))
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
      const mergedContext = buildConversationContext(8);
      const mergedCandidate = buildQuestionCandidate(
        mergedQuestion,
        candidate.source,
        mergedContext
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
      flushDetectedQuestion();
    }, 1400);
  };

  const appendTranscriptEntry = (transcript: LiveTranscriptPayload) => {
    if (!transcript.text.trim()) return;
    const timestamp = Date.now();
    const transcriptEntry: MeetingTranscript = {
      timestamp,
      text: transcript.text,
      source: transcript.source,
    };
    transcriptHistoryRef.current = [...transcriptHistoryRef.current, transcriptEntry].slice(-24);

    const segment: TranscriptSegmentAnalytics = {
      id: `segment-${timestamp}-${Math.random().toString(16).slice(2, 8)}`,
      timestamp,
      text: transcript.text,
      source: transcript.source,
      provider: sttStatus?.provider || sttProvider || "unknown",
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

    addLog("success", `📄 [${formatSourceLabel(transcript.source)}] "${transcript.text}"`);
    setLiveTranscript(transcript);
    setPartialTranscript(null);
    setMeeting((prev) => {
      if (!prev) return null;
      return { ...prev, transcripts: [...prev.transcripts, transcriptEntry] };
    });

    handleTranscriptForAnswer(transcript);
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
    addLog("info", "🎬 Meeting mode started (streaming)");

    const unsubscribeTranscript = window.electronAPI.meeting.onTranscript((payload) => {
      const transcript = toTranscriptPayload(payload);
      appendTranscriptEntry(transcript);
    });

    const unsubscribePartial = window.electronAPI.meeting.onPartial((payload) => {
      const partial = toTranscriptPayload(payload);
      if (!partial.text.trim()) return;
      setPartialTranscript(partial);
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

      if (durationIntervalRef.current) clearInterval(durationIntervalRef.current);
      if (questionDebounceRef.current) {
        clearTimeout(questionDebounceRef.current);
        questionDebounceRef.current = null;
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
      transcriptHistoryRef.current = [];
      pendingAnswerRef.current = null;
      pendingDetectionRef.current = null;
      lastAnsweredRef.current = null;
      lastQuestionSignatureRef.current = null;
      lastQuestionTimestampRef.current = 0;
      hasInterviewerAudioRef.current = false;
      cloudOffloadAttemptedRef.current = false;
      chunkQueueRef.current = [];
      droppedLocalChunksRef.current = 0;
      modelLastCallAtRef.current = 0;
      answerLastStartedAtRef.current = 0;
      analyticsRef.current = {
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
        performance: {
          droppedAudioChunks: 0,
          queueHighWaterMark: 0,
          reconnectCount: 0,
          fallbackCount: 0,
          avgSttLatencyMs: 0
        }
      };
      if (questionDebounceRef.current) {
        clearTimeout(questionDebounceRef.current);
        questionDebounceRef.current = null;
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
      addLog("success", "✅ Mic capture enabled");

      const activeSources: MeetingAudioSource[] = ["user"];
      if (useChunkedStt) {
        addLog("info", `🆓 Using chunked STT free tier (${sttProvider}).`);
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

      const result = await window.electronAPI.meeting.start(meetingTitle.trim(), activeSources);
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

  const stopRecording = async () => {
    if (!meeting?.isRecording) return;
    pendingDetectionRef.current = null;
    pendingAnswerRef.current = null;
    if (questionDebounceRef.current) {
      clearTimeout(questionDebounceRef.current);
      questionDebounceRef.current = null;
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

  const formatDuration = (seconds: number) => {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return `${hrs.toString().padStart(2, "0")}:${mins.toString().padStart(2, "0")}:${secs
      .toString()
      .padStart(2, "0")}`;
  };

  if (showTitleInput && !meeting) {
    return (
      <div className={`liquid-glass p-4 ${compact ? "w-[560px] max-w-[96vw]" : "w-full"}`}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-bold text-gray-800">🎤 Start Meeting</h2>
          <button onClick={onClose} className="rounded p-1 hover:bg-white/20">
            {compact ? (
              <span className="px-2 text-[10px] font-semibold text-gray-700">Back</span>
            ) : (
              <X className="h-4 w-4 text-gray-600" />
            )}
          </button>
        </div>

        {error && (
          <div className="mb-3 rounded border border-red-500/40 bg-red-500/20 p-2 text-[10px] text-red-700">{error}</div>
        )}

        <input
          type="text"
          value={meetingTitle}
          onChange={(e) => setMeetingTitle(e.target.value)}
          placeholder="Meeting title..."
          className="mb-3 w-full rounded-lg border border-white/40 bg-white/25 px-3 py-2 text-xs text-gray-800 placeholder-gray-500 backdrop-blur-md focus:outline-none focus:ring-1 focus:ring-gray-400/60"
          onKeyDown={(e) => e.key === "Enter" && startRecording()}
          autoFocus
        />

        <div className="mb-3 rounded-lg border border-white/30 bg-white/20 p-2">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-gray-700">
            Performance Controls
          </div>
          <div className="grid grid-cols-2 gap-2 text-[10px]">
            <label className="flex flex-col gap-1">
              <span className="text-gray-700">CPU Mode</span>
              <select
                value={cpuMode}
                onChange={(event) => setCpuMode(event.target.value as CpuMode)}
                className="rounded border border-white/40 bg-white/70 px-2 py-1 text-[10px] text-gray-800"
              >
                <option value="low">Low CPU</option>
                <option value="balanced">Balanced</option>
                <option value="high">High accuracy</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-gray-700">Chunk Rate (ms)</span>
              <input
                type="number"
                min={600}
                max={6000}
                value={chunkRateMs}
                onChange={(event) => setChunkRateMs(Math.max(600, Math.min(6000, Number(event.target.value) || 1800)))}
                className="rounded border border-white/40 bg-white/70 px-2 py-1 text-[10px] text-gray-800"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-gray-700">Model Throttle (ms)</span>
              <input
                type="number"
                min={0}
                max={10000}
                value={modelThrottleMs}
                onChange={(event) => setModelThrottleMs(Math.max(0, Math.min(10000, Number(event.target.value) || 0)))}
                className="rounded border border-white/40 bg-white/70 px-2 py-1 text-[10px] text-gray-800"
              />
            </label>
            <label className="flex items-center gap-2 rounded border border-white/30 bg-white/40 px-2 py-1.5 text-[10px] text-gray-700">
              <input
                type="checkbox"
                checked={cloudOffload}
                onChange={(event) => setCloudOffload(event.target.checked)}
              />
              Cloud offload answers
            </label>
          </div>
        </div>

        <button
          onClick={startRecording}
          disabled={!meetingTitle.trim()}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-red-500/80 px-3 py-2 text-xs text-white shadow-lg hover:bg-red-600/80 disabled:bg-gray-400/50"
        >
          <Mic className="h-3 w-3" />
          Start Recording
        </button>

        {logs.length > 0 && (
          <div className="mt-3 max-h-24 overflow-y-auto rounded bg-white/10 p-2 text-[9px]">
            {logs.slice(-3).map((log, i) => (
              <div key={i} className="mb-1 text-gray-700">
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
      className={`chat-container flex flex-col p-4 liquid-glass ${
        compact ? "w-[760px] max-w-[96vw]" : "w-[980px] max-w-[98vw]"
      }`}
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1">
          <div className="flex items-center gap-1 rounded bg-white/20 px-2 py-1 text-[9px] text-white">
            <Mic className="h-3 w-3 text-white" />
            <span className="font-semibold">{meeting?.title}</span>
          </div>
          {meeting?.isRecording && (
            <div className="flex items-center gap-1 rounded bg-white/20 px-2 py-1 text-[9px] text-white">
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
                className="flex items-center gap-1 rounded bg-yellow-500/80 px-2 py-1 text-[9px] text-white hover:bg-yellow-600/80"
              >
                {meeting.isPaused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
                {meeting.isPaused ? "Resume" : "Pause"}
              </button>
              <button
                onClick={stopRecording}
                className="flex items-center gap-1 rounded bg-gray-600/80 px-2 py-1 text-[9px] text-white hover:bg-gray-700/80"
              >
                <MicOff className="h-3 w-3" />
                Stop
              </button>
            </>
          )}
          <button
            onClick={() => setShowDebug(!showDebug)}
            className={`flex items-center gap-1 rounded px-2 py-1 text-[9px] text-white ${
              showDebug ? "bg-blue-500/80" : "bg-white/20"
            }`}
          >
            <Terminal className="h-3 w-3" />
            Debug
          </button>
          <button
            onClick={compact ? handleEndMeeting : onClose}
            disabled={compact && isEndingMeeting}
            className={`rounded px-2 py-1 text-[9px] text-white ${
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
        <div className="mb-3 rounded-lg border border-blue-500/40 bg-gradient-to-r from-blue-500/20 to-green-500/20 p-3">
          <div className="mb-1 flex items-center gap-1">
            <div className="h-2 w-2 animate-pulse rounded-full bg-blue-500" />
            <span className="text-[9px] font-bold text-white">LIVE</span>
          </div>
          {liveTranscript && (
            <p className="mb-1 text-xs font-medium text-white">
              <span className="font-semibold text-white">{formatSourceLabel(liveTranscript.source)}:</span>{" "}
              {liveTranscript.text}
            </p>
          )}
          {partialTranscript && (
            <p className="text-xs italic text-white/90">
              <span className="font-semibold text-white">{formatSourceLabel(partialTranscript.source)}:</span>{" "}
              {partialTranscript.text}
            </p>
          )}
        </div>
      )}

      {sttStatus && (
        <div className="mb-3 rounded-lg border border-white/25 bg-white/20 p-2 text-[10px] text-white">
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

      <div className="mb-3 grid min-h-[340px] flex-1 grid-cols-1 gap-3 md:grid-cols-2">
        <div
          ref={transcriptScrollRef}
          className="glass-content max-h-[52vh] overflow-y-auto rounded-lg border border-white/20 bg-white/10 p-3 shadow-lg"
        >
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-[11px] font-bold text-gray-800">Conversation</h3>
            <span className="text-[9px] text-gray-500">{meeting?.transcripts.length || 0} lines</span>
          </div>

          {(!meeting || meeting.transcripts.length === 0) && !partialTranscript && !liveTranscript && (
            <div className="py-8 text-center text-[10px] text-gray-500">
              <Mic className="mx-auto mb-2 h-8 w-8 opacity-30" />
              <p>Waiting for transcript...</p>
            </div>
          )}

          <div className="space-y-2">
            {meeting?.transcripts.map((item, i) => (
              <div key={`${item.timestamp}-${i}`} className="rounded border border-gray-200 bg-white/85 p-2">
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-[9px] font-semibold text-blue-700">
                    {formatSourceLabel(item.source === "interviewer" ? "interviewer" : "user")}
                  </span>
                  <span className="font-mono text-[8px] text-gray-500">
                    {new Date(item.timestamp).toLocaleTimeString()}
                  </span>
                </div>
                <p className="text-[10px] text-gray-800">{item.text}</p>
              </div>
            ))}

            {partialTranscript && (
              <div className="rounded border border-blue-300/50 bg-blue-50/70 p-2">
                <div className="mb-1 flex items-center gap-1">
                  <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500" />
                  <span className="text-[9px] font-semibold text-blue-700">
                    {formatSourceLabel(partialTranscript.source)} (live)
                  </span>
                </div>
                <p className="text-[10px] italic text-blue-900">{partialTranscript.text}</p>
              </div>
            )}
          </div>
        </div>

        <div className="glass-content max-h-[52vh] overflow-y-auto rounded-lg border border-white/20 bg-white/10 p-3 shadow-lg">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-[11px] font-bold text-gray-800">AI Answers</h3>
            <span className="text-[9px] text-gray-500">{answers.length} items</span>
          </div>

          {answers.length === 0 ? (
            <div className="py-8 text-center text-[10px] text-gray-500">
              <MessageSquare className="mx-auto mb-2 h-8 w-8 opacity-30" />
              <p>No answers yet</p>
              <p className="mt-1 text-[9px] text-gray-400">
                Answers appear when a likely interview question is detected.
              </p>
              {!hasInterviewerAudioRef.current && (
                <p className="mt-1 text-[9px] text-gray-400">Mic-only mode is active; question detection uses mic transcript.</p>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              {answers.map((item) => (
                <div key={item.id} className="rounded border border-gray-200 bg-white/85 p-2">
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-[9px] font-semibold text-blue-700">Question</span>
                    <span className="font-mono text-[8px] text-gray-500">
                      {new Date(item.createdAt).toLocaleTimeString()}
                    </span>
                  </div>
                  <p className="mb-2 text-[10px] text-gray-800">{item.question}</p>

                  {typeof item.confidence === "number" && (
                    <div className="mb-2 inline-flex items-center rounded bg-blue-50 px-2 py-0.5 text-[9px] font-semibold text-blue-700">
                      {item.confidence}% confidence
                    </div>
                  )}

                  {typeof item.qualityOverall === "number" && (
                    <div className="mb-2 ml-1 inline-flex items-center rounded bg-emerald-50 px-2 py-0.5 text-[9px] font-semibold text-emerald-700">
                      {Math.round(item.qualityOverall * 100)}% quality
                    </div>
                  )}

                  {item.status === "pending" && <div className="text-[9px] text-gray-500">Generating answer...</div>}
                  {item.status === "error" && (
                    <div className="text-[9px] text-red-600">{item.error || "Failed to generate answer."}</div>
                  )}
                  {item.status === "ready" && item.response && (
                    <div className="space-y-2">
                      <div className="whitespace-pre-wrap text-[10px] text-gray-800">{item.response}</div>
                      {item.followUps && item.followUps.length > 0 && (
                        <div className="rounded bg-slate-50 px-2 py-1 text-[9px] text-slate-700">
                          <div className="mb-1 font-semibold">Optional follow-ups</div>
                          {item.followUps.map((followUp, index) => (
                            <div key={`${item.id}-followup-${index}`}>• {followUp}</div>
                          ))}
                        </div>
                      )}
                      {item.understanding && (
                        <div className="rounded bg-indigo-50 px-2 py-1 text-[9px] text-indigo-700">
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
                        <div className="text-[8px] text-gray-500">
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
          <div className="space-y-0.5 font-mono text-[8px]">
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
