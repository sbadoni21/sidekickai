import { StoredUser } from "./authStore"

export interface MeetingNote {
  timestamp: number
  speaker: string
  type: string
  content: string
  tags: string[]
}

export interface MeetingTranscript {
  timestamp: number
  text: string
  source?: "user" | "interviewer"
}

export interface TranscriptSegmentAnalytics {
  id: string
  timestamp: number
  text: string
  source: "user" | "interviewer"
  provider: string
  latencyMs?: number
  dropped?: boolean
}

export interface CodingQuestionUnderstanding {
  problemStatement: string
  constraints: string[]
  edgeCases: string[]
}

export interface DetectedQuestionAnalytics {
  id: string
  question: string
  source: "user" | "interviewer"
  confidence: number
  detectedAt: number
  contextWindow: string
  understanding: CodingQuestionUnderstanding
}

export interface AnswerQualityAnalytics {
  clarity: number
  correctness: number
  concision: number
  relevance: number
  overall: number
}

export interface AnswerAnalytics {
  id: string
  questionId?: string
  question: string
  answer: string
  followUps: string[]
  provider: string
  model: string
  createdAt: number
  latencyMs: number
  quality: AnswerQualityAnalytics
}

export type CpuMode = "low" | "balanced" | "high"

export interface MeetingPerformanceControls {
  cpuMode: CpuMode
  chunkRateMs: number
  maxChunkQueue: number
  answerThrottleMs: number
  modelThrottleMs: number
  cloudOffload: boolean
}

export interface MeetingPerformanceSnapshot {
  droppedAudioChunks: number
  queueHighWaterMark: number
  reconnectCount: number
  fallbackCount: number
  avgSttLatencyMs: number
}

export interface MeetingAnalytics {
  transcriptSegments: TranscriptSegmentAnalytics[]
  detectedQuestions: DetectedQuestionAnalytics[]
  answers: AnswerAnalytics[]
  controls: MeetingPerformanceControls
  performance: MeetingPerformanceSnapshot
}

export interface MeetingSummary {
  keyPoints: string[]
  decisions: string[]
  actionItems: string[]
  participants: string[]
  nextSteps: string[]
}

export interface MindMapNode {
  id: string
  label: string
  children?: MindMapNode[]
}

export interface RuntimeMeeting {
  id: string
  title: string
  startTime: number
  endTime?: number
  isRecording: boolean
  isPaused: boolean
  notes: MeetingNote[]
  transcripts: MeetingTranscript[]
  analytics?: MeetingAnalytics
  summary?: MeetingSummary
  mindMap?: MindMapNode
}

export interface MeetingRecord {
  id: string
  userId: string
  remoteMeetingId: string
  title: string
  startTime: number
  endTime?: number
  durationSeconds: number
  noteCount: number
  transcriptCount: number
  summary?: MeetingSummary
  mindMap?: MindMapNode
  notes: MeetingNote[]
  transcripts: MeetingTranscript[]
  analytics?: MeetingAnalytics
  createdAt: number
  updatedAt: number
}

export interface MeetingStats {
  totalMeetings: number
  totalDurationSeconds: number
  totalNotes: number
  totalTranscripts: number
  totalDetectedQuestions: number
  avgAnswerQuality: number
  lastMeetingAt?: number
}

interface SupabaseMeetingRow {
  id: string
  user_id: string
  remote_meeting_id: string
  title: string
  started_at: string
  ended_at: string | null
  duration_seconds: number
  note_count: number
  transcript_count: number
  summary: MeetingSummary | null
  mind_map: MindMapNode | null
  notes: MeetingNote[] | null
  transcripts: MeetingTranscript[] | null
  transcript_segments: TranscriptSegmentAnalytics[] | null
  detected_questions: DetectedQuestionAnalytics[] | null
  answer_analytics: AnswerAnalytics[] | null
  performance_metrics: MeetingPerformanceSnapshot | null
  session_memory: MeetingPerformanceControls | null
  created_at: string
  updated_at: string
}

const normalizeTranscriptSource = (
  source: unknown
): "user" | "interviewer" => {
  return source === "interviewer" ? "interviewer" : "user"
}

const normalizeMeetingTranscripts = (
  transcripts: MeetingTranscript[] | null | undefined
): MeetingTranscript[] => {
  if (!Array.isArray(transcripts)) return []
  return transcripts
    .map(item => ({
      timestamp:
        typeof item?.timestamp === "number" && Number.isFinite(item.timestamp)
          ? item.timestamp
          : Date.now(),
      text: typeof item?.text === "string" ? item.text.trim() : "",
      source: normalizeTranscriptSource(item?.source)
    }))
    .filter(item => item.text.length > 0)
}

const normalizeNumber = (
  value: unknown,
  fallback: number,
  min?: number,
  max?: number
): number => {
  const numeric = typeof value === "number" && Number.isFinite(value) ? value : fallback
  const withMin = typeof min === "number" ? Math.max(min, numeric) : numeric
  return typeof max === "number" ? Math.min(max, withMin) : withMin
}

const normalizeQuestionUnderstanding = (
  value: CodingQuestionUnderstanding | null | undefined
): CodingQuestionUnderstanding => {
  return {
    problemStatement:
      typeof value?.problemStatement === "string" ? value.problemStatement.trim() : "",
    constraints: Array.isArray(value?.constraints)
      ? value!.constraints.filter(item => typeof item === "string").map(item => item.trim()).filter(Boolean)
      : [],
    edgeCases: Array.isArray(value?.edgeCases)
      ? value!.edgeCases.filter(item => typeof item === "string").map(item => item.trim()).filter(Boolean)
      : []
  }
}

const normalizeTranscriptSegments = (
  segments: TranscriptSegmentAnalytics[] | null | undefined
): TranscriptSegmentAnalytics[] => {
  if (!Array.isArray(segments)) return []
  return segments
    .map((segment, index) => ({
      id: typeof segment?.id === "string" && segment.id.trim() ? segment.id : `segment-${Date.now()}-${index}`,
      timestamp: normalizeNumber(segment?.timestamp, Date.now(), 0),
      text: typeof segment?.text === "string" ? segment.text.trim() : "",
      source: normalizeTranscriptSource(segment?.source),
      provider: typeof segment?.provider === "string" && segment.provider.trim() ? segment.provider.trim() : "unknown",
      latencyMs:
        typeof segment?.latencyMs === "number" && Number.isFinite(segment.latencyMs)
          ? Math.max(0, segment.latencyMs)
          : undefined,
      dropped: Boolean(segment?.dropped)
    }))
    .filter(segment => segment.text.length > 0)
}

const normalizeDetectedQuestions = (
  questions: DetectedQuestionAnalytics[] | null | undefined
): DetectedQuestionAnalytics[] => {
  if (!Array.isArray(questions)) return []
  return questions
    .map((question, index) => ({
      id: typeof question?.id === "string" && question.id.trim() ? question.id : `question-${Date.now()}-${index}`,
      question: typeof question?.question === "string" ? question.question.trim() : "",
      source: normalizeTranscriptSource(question?.source),
      confidence: normalizeNumber(question?.confidence, 0, 0, 1),
      detectedAt: normalizeNumber(question?.detectedAt, Date.now(), 0),
      contextWindow:
        typeof question?.contextWindow === "string" ? question.contextWindow.trim() : "",
      understanding: normalizeQuestionUnderstanding(question?.understanding)
    }))
    .filter(question => question.question.length > 0)
}

const normalizeAnswerQuality = (
  quality: AnswerQualityAnalytics | null | undefined
): AnswerQualityAnalytics => {
  const clarity = normalizeNumber(quality?.clarity, 0, 0, 1)
  const correctness = normalizeNumber(quality?.correctness, 0, 0, 1)
  const concision = normalizeNumber(quality?.concision, 0, 0, 1)
  const relevance = normalizeNumber(quality?.relevance, 0, 0, 1)
  const normalizedOverall = normalizeNumber(quality?.overall, (clarity + correctness + concision + relevance) / 4, 0, 1)
  return {
    clarity,
    correctness,
    concision,
    relevance,
    overall: normalizedOverall
  }
}

const normalizeAnswerAnalytics = (
  answers: AnswerAnalytics[] | null | undefined
): AnswerAnalytics[] => {
  if (!Array.isArray(answers)) return []
  return answers
    .map((answer, index) => ({
      id: typeof answer?.id === "string" && answer.id.trim() ? answer.id : `answer-${Date.now()}-${index}`,
      questionId:
        typeof answer?.questionId === "string" && answer.questionId.trim() ? answer.questionId : undefined,
      question: typeof answer?.question === "string" ? answer.question.trim() : "",
      answer: typeof answer?.answer === "string" ? answer.answer.trim() : "",
      followUps: Array.isArray(answer?.followUps)
        ? answer!.followUps.filter(item => typeof item === "string").map(item => item.trim()).filter(Boolean)
        : [],
      provider: typeof answer?.provider === "string" && answer.provider.trim() ? answer.provider.trim() : "unknown",
      model: typeof answer?.model === "string" && answer.model.trim() ? answer.model.trim() : "unknown",
      createdAt: normalizeNumber(answer?.createdAt, Date.now(), 0),
      latencyMs: normalizeNumber(answer?.latencyMs, 0, 0),
      quality: normalizeAnswerQuality(answer?.quality)
    }))
    .filter(answer => answer.question.length > 0 || answer.answer.length > 0)
}

const normalizePerformanceControls = (
  controls: MeetingPerformanceControls | null | undefined
): MeetingPerformanceControls => {
  const cpuMode = controls?.cpuMode
  return {
    cpuMode: cpuMode === "low" || cpuMode === "high" ? cpuMode : "balanced",
    chunkRateMs: normalizeNumber(controls?.chunkRateMs, 1800, 600, 6000),
    maxChunkQueue: normalizeNumber(controls?.maxChunkQueue, 8, 1, 64),
    answerThrottleMs: normalizeNumber(controls?.answerThrottleMs, 1200, 0, 60000),
    modelThrottleMs: normalizeNumber(controls?.modelThrottleMs, 800, 0, 60000),
    cloudOffload: Boolean(controls?.cloudOffload)
  }
}

const normalizePerformanceMetrics = (
  metrics: MeetingPerformanceSnapshot | null | undefined
): MeetingPerformanceSnapshot => {
  return {
    droppedAudioChunks: normalizeNumber(metrics?.droppedAudioChunks, 0, 0),
    queueHighWaterMark: normalizeNumber(metrics?.queueHighWaterMark, 0, 0),
    reconnectCount: normalizeNumber(metrics?.reconnectCount, 0, 0),
    fallbackCount: normalizeNumber(metrics?.fallbackCount, 0, 0),
    avgSttLatencyMs: normalizeNumber(metrics?.avgSttLatencyMs, 0, 0)
  }
}

const normalizeMeetingAnalytics = (
  analytics: MeetingAnalytics | null | undefined
): MeetingAnalytics => {
  return {
    transcriptSegments: normalizeTranscriptSegments(analytics?.transcriptSegments),
    detectedQuestions: normalizeDetectedQuestions(analytics?.detectedQuestions),
    answers: normalizeAnswerAnalytics(analytics?.answers),
    controls: normalizePerformanceControls(analytics?.controls),
    performance: normalizePerformanceMetrics(analytics?.performance)
  }
}

const LOCAL_MEETINGS_PREFIX = "cluely_meetings_v1_"

const readEnv = (key: string): string => {
  const value = (import.meta.env[key] as string | undefined) || ""
  return value.trim()
}

const toTimestamp = (value: string | null | undefined): number | undefined => {
  if (!value) return undefined
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

const deriveSupabaseUrlFromDbUrl = (dbUrl: string): string => {
  try {
    const parsed = new URL(dbUrl)
    const hostParts = parsed.hostname.split(".")
    if (hostParts.length >= 4 && hostParts[0] === "db") {
      return `https://${hostParts[1]}.supabase.co`
    }
  } catch {
    // Ignore malformed URLs and return empty string.
  }
  return ""
}

const resolveSupabaseUrl = (): string => {
  const configuredUrl = readEnv("VITE_SUPABASE_URL")
  if (configuredUrl) return configuredUrl
  const dbUrl = readEnv("VITE_SUPABASE_DB_URL")
  return dbUrl ? deriveSupabaseUrlFromDbUrl(dbUrl) : ""
}

const SUPABASE_URL = resolveSupabaseUrl()
const SUPABASE_ANON_KEY = readEnv("VITE_SUPABASE_ANON_KEY")
let supabaseDisabledForSession = false
let supabaseDisableReason: string | null = null

const isSupabaseConfigured = (): boolean => {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY)
}

const isSupabaseEnabled = (): boolean => {
  return isSupabaseConfigured() && !supabaseDisabledForSession
}

const shouldDisableSupabaseForError = (payload: string): boolean => {
  return (
    payload.includes('"code":"PGRST205"') ||
    payload.includes("Could not find the table 'public.meetings'") ||
    payload.includes("relation \"public.meetings\" does not exist")
  )
}

const markSupabaseUnavailable = (reason: string) => {
  if (supabaseDisabledForSession) return
  supabaseDisabledForSession = true
  supabaseDisableReason = reason
  console.warn(
    `[meetingsStore] Supabase meetings disabled for this app session: ${reason}. ` +
      "Run supabase/meetings_schema.sql in your Supabase SQL Editor, then restart the app."
  )
}

export const getMeetingsStorageMode = (): "supabase" | "local" => {
  return isSupabaseEnabled() ? "supabase" : "local"
}

const localStorageKey = (userId: string): string => {
  return `${LOCAL_MEETINGS_PREFIX}${userId}`
}

const loadLocalMeetings = (userId: string): MeetingRecord[] => {
  const raw = localStorage.getItem(localStorageKey(userId))
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as MeetingRecord[]
    if (!Array.isArray(parsed)) return []
    return parsed.map(record => ({
      ...record,
      notes: Array.isArray(record.notes) ? record.notes : [],
      transcripts: normalizeMeetingTranscripts(record.transcripts),
      analytics: normalizeMeetingAnalytics(record.analytics)
    }))
  } catch {
    return []
  }
}

const saveLocalMeetings = (userId: string, meetings: MeetingRecord[]) => {
  localStorage.setItem(localStorageKey(userId), JSON.stringify(meetings))
}

const mapRowToMeetingRecord = (row: SupabaseMeetingRow): MeetingRecord => {
  const normalizedTranscripts = normalizeMeetingTranscripts(row.transcripts || [])
  const normalizedAnalytics = normalizeMeetingAnalytics({
    transcriptSegments: row.transcript_segments || [],
    detectedQuestions: row.detected_questions || [],
    answers: row.answer_analytics || [],
    controls: normalizePerformanceControls(row.session_memory || undefined),
    performance: normalizePerformanceMetrics(row.performance_metrics || undefined)
  })

  return {
    id: row.id,
    userId: row.user_id,
    remoteMeetingId: row.remote_meeting_id,
    title: row.title,
    startTime: toTimestamp(row.started_at) || Date.now(),
    endTime: toTimestamp(row.ended_at),
    durationSeconds: row.duration_seconds || 0,
    noteCount: row.note_count || 0,
    transcriptCount: row.transcript_count || normalizedTranscripts.length,
    summary: row.summary || undefined,
    mindMap: row.mind_map || undefined,
    notes: row.notes || [],
    transcripts: normalizedTranscripts,
    analytics: normalizedAnalytics,
    createdAt: toTimestamp(row.created_at) || Date.now(),
    updatedAt: toTimestamp(row.updated_at) || Date.now()
  }
}

const createMeetingRecord = (
  user: StoredUser,
  meeting: RuntimeMeeting
): MeetingRecord => {
  const endTime = meeting.endTime || Date.now()
  const durationSeconds = Math.max(
    0,
    Math.floor((endTime - meeting.startTime) / 1000)
  )

  const normalizedTranscripts = normalizeMeetingTranscripts(meeting.transcripts)
  const normalizedAnalytics = normalizeMeetingAnalytics(meeting.analytics)

  return {
    id: `${meeting.id}-${user.id}`,
    userId: user.id,
    remoteMeetingId: meeting.id,
    title: meeting.title,
    startTime: meeting.startTime,
    endTime: meeting.endTime,
    durationSeconds,
    noteCount: meeting.notes.length,
    transcriptCount: normalizedTranscripts.length,
    summary: meeting.summary,
    mindMap: meeting.mindMap,
    notes: meeting.notes,
    transcripts: normalizedTranscripts,
    analytics: normalizedAnalytics,
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
}

const upsertLocalMeeting = (userId: string, record: MeetingRecord) => {
  const existing = loadLocalMeetings(userId)
  const next = [record, ...existing.filter(item => item.remoteMeetingId !== record.remoteMeetingId)]
  next.sort((a, b) => b.startTime - a.startTime)
  saveLocalMeetings(userId, next)
}

const getSupabaseHeaders = (): Record<string, string> => {
  return {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    "Content-Type": "application/json"
  }
}

export const saveMeetingRecord = async (
  user: StoredUser,
  meeting: RuntimeMeeting
): Promise<MeetingRecord> => {
  const localRecord = createMeetingRecord(user, meeting)

  if (isSupabaseEnabled()) {
    try {
      const response = await fetch(
        `${SUPABASE_URL}/rest/v1/meetings?on_conflict=user_id,remote_meeting_id`,
        {
          method: "POST",
          headers: {
            ...getSupabaseHeaders(),
            Prefer: "resolution=merge-duplicates,return=representation"
          },
          body: JSON.stringify({
            user_id: user.id,
            remote_meeting_id: meeting.id,
            title: meeting.title,
            started_at: new Date(meeting.startTime).toISOString(),
            ended_at: meeting.endTime ? new Date(meeting.endTime).toISOString() : null,
            duration_seconds: localRecord.durationSeconds,
            note_count: localRecord.noteCount,
            transcript_count: localRecord.transcriptCount,
            summary: meeting.summary || null,
            mind_map: meeting.mindMap || null,
            notes: meeting.notes,
            transcripts: meeting.transcripts,
            transcript_segments: localRecord.analytics?.transcriptSegments || [],
            detected_questions: localRecord.analytics?.detectedQuestions || [],
            answer_analytics: localRecord.analytics?.answers || [],
            performance_metrics: localRecord.analytics?.performance || {},
            session_memory: localRecord.analytics?.controls || {}
          })
        }
      )

      if (!response.ok) {
        const errorText = await response.text()
        if (shouldDisableSupabaseForError(errorText)) {
          markSupabaseUnavailable(errorText)
        }
        throw new Error(`Supabase save failed: ${response.status} ${errorText}`)
      }

      const rows = (await response.json()) as SupabaseMeetingRow[]
      if (Array.isArray(rows) && rows.length > 0) {
        return mapRowToMeetingRecord(rows[0])
      }
    } catch (error) {
      const message = String(error)
      if (shouldDisableSupabaseForError(message)) {
        markSupabaseUnavailable(message)
      }
      console.error("Failed saving meeting to Supabase. Falling back to local storage.", error)
    }
  }

  upsertLocalMeeting(user.id, localRecord)
  return localRecord
}

export const loadMeetingRecords = async (userId: string): Promise<MeetingRecord[]> => {
  if (isSupabaseEnabled()) {
    try {
      const encodedUserId = encodeURIComponent(userId)
      const response = await fetch(
        `${SUPABASE_URL}/rest/v1/meetings?user_id=eq.${encodedUserId}&order=started_at.desc&limit=100`,
        {
          headers: getSupabaseHeaders()
        }
      )

      if (!response.ok) {
        const errorText = await response.text()
        if (shouldDisableSupabaseForError(errorText)) {
          markSupabaseUnavailable(errorText)
        }
        throw new Error(`Supabase load failed: ${response.status} ${errorText}`)
      }

      const rows = (await response.json()) as SupabaseMeetingRow[]
      return rows.map(mapRowToMeetingRecord)
    } catch (error) {
      const message = String(error)
      if (shouldDisableSupabaseForError(message)) {
        markSupabaseUnavailable(message)
      }
      console.error("Failed loading meetings from Supabase. Using local storage fallback.", error)
    }
  }

  if (supabaseDisableReason) {
    console.info(`[meetingsStore] Using local history fallback. Reason: ${supabaseDisableReason}`)
  }

  return loadLocalMeetings(userId)
}

export const computeMeetingStats = (meetings: MeetingRecord[]): MeetingStats => {
  const qualitySamples = meetings
    .flatMap(meeting => meeting.analytics?.answers || [])
    .map(answer => normalizeAnswerQuality(answer.quality).overall)

  return {
    totalMeetings: meetings.length,
    totalDurationSeconds: meetings.reduce((total, meeting) => total + meeting.durationSeconds, 0),
    totalNotes: meetings.reduce((total, meeting) => total + meeting.noteCount, 0),
    totalTranscripts: meetings.reduce((total, meeting) => total + meeting.transcriptCount, 0),
    totalDetectedQuestions: meetings.reduce(
      (total, meeting) => total + (meeting.analytics?.detectedQuestions?.length || 0),
      0
    ),
    avgAnswerQuality:
      qualitySamples.length > 0
        ? qualitySamples.reduce((total, sample) => total + sample, 0) / qualitySamples.length
        : 0,
    lastMeetingAt: meetings[0]?.startTime
  }
}
