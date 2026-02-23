import type { AnswerQualityAnalytics, CodingQuestionUnderstanding } from "../meetingsStore"

export type MeetingAudioSource = "user" | "interviewer"

export interface QuestionCandidate {
  id: string
  question: string
  source: MeetingAudioSource
  confidence: number
  contextWindow: string
  detectedAt: number
  understanding: CodingQuestionUnderstanding
}

export interface ModelQuestionClassification {
  isQuestion: boolean
  confidence: number
  normalizedQuestion: string
  questionType: string
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
}

export interface QualityJudgeResult {
  quality: AnswerQualityAnalytics
  notes?: string
}

