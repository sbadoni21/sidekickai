import type { AnswerQualityAnalytics, CodingQuestionUnderstanding } from "../meetingsStore"

export type MeetingAudioSource = "user" | "interviewer"

export type CodingIntent =
  | "theory"
  | "write_code"
  | "debug_code"
  | "optimize"
  | "complexity"
  | "dry_run"
  | "test_cases"
  | "clarify"
  | "behavioral"
  | "system_design"
  | "screen_analysis"
  | "other"

export interface ProblemMemory {
  problemStatement: string
  constraints: string[]
  edgeCases: string[]
  examples: string[]
  preferredLanguage?: string
  preferredFramework?: string
  currentCode?: string
  currentApproach?: string
  timeComplexity?: string
  spaceComplexity?: string
  lastQuestion?: string
  lastInterviewerAsk?: string
  lastIntent?: CodingIntent
  screenSummary?: string
  source?: "conversation" | "screen"
  updatedAt: number
}

export interface ScreenProblemAnalysis {
  activeRequest: string
  intent: CodingIntent
  problemStatement: string
  preferredLanguage?: string
  preferredFramework?: string
  constraints: string[]
  edgeCases: string[]
  examples: string[]
  visibleCode?: string
  currentApproach?: string
  timeComplexity?: string
  spaceComplexity?: string
}

export interface AnswerResponseMetadata {
  intent: CodingIntent
  language?: string
  framework?: string
  approach?: string
  timeComplexity?: string
  spaceComplexity?: string
  edgeCases?: string[]
  examples?: string[]
}

export interface QuestionCandidate {
  id: string
  question: string
  source: MeetingAudioSource
  confidence: number
  contextWindow: string
  detectedAt: number
  understanding: CodingQuestionUnderstanding
  intent?: CodingIntent
  languageHint?: string
  frameworkHint?: string
}

export interface ModelQuestionClassification {
  isQuestion: boolean
  confidence: number
  normalizedQuestion: string
  questionType: string
  intent: CodingIntent
  languageHint?: string
  frameworkHint?: string
  rationale?: string
  understanding: CodingQuestionUnderstanding
}

export interface ResourceContextBundle {
  context: string
  sources: string[]
  retrievalStats?: {
    vectorMatches: number
    lexicalMatches: number
    fusedMatches: number
  }
}

export interface ParsedAnswerEnvelope {
  answer: string
  followUps: string[]
  understanding: CodingQuestionUnderstanding
  metadata?: AnswerResponseMetadata
}

export interface QualityJudgeResult {
  quality: AnswerQualityAnalytics
  notes?: string
}
