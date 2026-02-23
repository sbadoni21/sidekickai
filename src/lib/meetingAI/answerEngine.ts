import type { AnswerQualityAnalytics, CodingQuestionUnderstanding } from "../meetingsStore"
import { cleanLLMResponse } from "../../utils/lmResponseParser"
import type {
  ParsedAnswerEnvelope,
  QualityJudgeResult,
  QuestionCandidate
} from "./types"

interface FastDraftArgs {
  candidate: QuestionCandidate
  candidateName: string
  selectedFolderLabels: string[]
  resourceContext: string
  invokeLlm: (prompt: string) => Promise<string>
}

interface RefineAnswerArgs {
  candidate: QuestionCandidate
  draftAnswer: string
  suggestion: string
  resourceContext: string
  invokeLlm: (prompt: string) => Promise<string>
}

interface JudgeAnswerArgs {
  candidate: QuestionCandidate
  answer: string
  invokeLlm: (prompt: string) => Promise<string>
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0))

const sanitizeJsonPayload = (raw: string): string =>
  raw
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim()

const fallbackUnderstanding = (
  incoming: Partial<CodingQuestionUnderstanding> | null | undefined,
  fallback: CodingQuestionUnderstanding
): CodingQuestionUnderstanding => {
  const constraints = Array.isArray(incoming?.constraints)
    ? incoming!.constraints
        .filter(item => typeof item === "string")
        .map(item => item.trim())
        .filter(Boolean)
        .slice(0, 8)
    : fallback.constraints

  const edgeCases = Array.isArray(incoming?.edgeCases)
    ? incoming!.edgeCases
        .filter(item => typeof item === "string")
        .map(item => item.trim())
        .filter(Boolean)
        .slice(0, 8)
    : fallback.edgeCases

  const problemStatement =
    typeof incoming?.problemStatement === "string" && incoming.problemStatement.trim()
      ? incoming.problemStatement.trim()
      : fallback.problemStatement

  return {
    problemStatement,
    constraints,
    edgeCases: edgeCases.length > 0 ? edgeCases : fallback.edgeCases
  }
}

const heuristicQuality = (answer: string): AnswerQualityAnalytics => {
  const normalized = answer.trim()
  const words = normalized.split(/\s+/).filter(Boolean)
  const hasComplexity = /\b(o\(|time complexity|space complexity|linear|log n|quadratic)\b/i.test(normalized)
  const hasEdgeCase = /\b(edge case|empty|null|duplicate|overflow|boundary)\b/i.test(normalized)
  const hasActionVerb = /\b(use|choose|build|iterate|track|validate|return|handle)\b/i.test(normalized)

  const clarity = clamp01(words.length >= 12 ? 0.72 : 0.5)
  const correctness = clamp01((hasComplexity ? 0.2 : 0) + (hasEdgeCase ? 0.2 : 0) + 0.45)
  const concision = clamp01(words.length <= 120 ? 0.86 : 0.58)
  const relevance = clamp01((hasActionVerb ? 0.22 : 0.1) + (words.length >= 8 ? 0.58 : 0.4))
  const overall = clamp01((clarity + correctness + concision + relevance) / 4)
  return { clarity, correctness, concision, relevance, overall }
}

export const parseAnswerEnvelope = (
  raw: string,
  fallbackCandidate: QuestionCandidate
): ParsedAnswerEnvelope => {
  const fallback: ParsedAnswerEnvelope = {
    answer: cleanLLMResponse(raw),
    followUps: [],
    understanding: fallbackCandidate.understanding
  }

  try {
    const parsed = JSON.parse(sanitizeJsonPayload(raw)) as Record<string, unknown>
    const answer =
      typeof parsed?.answer === "string" && parsed.answer.trim()
        ? parsed.answer.trim()
        : fallback.answer
    const followUps = Array.isArray(parsed?.follow_ups)
      ? parsed.follow_ups
          .filter(item => typeof item === "string")
          .map(item => item.trim())
          .filter(Boolean)
          .slice(0, 4)
      : []

    const understandingRaw =
      parsed?.question_understanding && typeof parsed.question_understanding === "object"
        ? (parsed.question_understanding as Partial<CodingQuestionUnderstanding>)
        : null

    return {
      answer: cleanLLMResponse(answer),
      followUps,
      understanding: fallbackUnderstanding(understandingRaw, fallbackCandidate.understanding)
    }
  } catch {
    return fallback
  }
}

export const generateFastDraftAnswer = async (args: FastDraftArgs): Promise<ParsedAnswerEnvelope> => {
  const { candidate, candidateName, selectedFolderLabels, resourceContext, invokeLlm } = args
  const prompt = `You are an interview copilot for coding interviews.

Candidate: ${candidateName || "Candidate"}
Question source: ${candidate.source === "interviewer" ? "Interviewer" : "User"}
Detected question: "${candidate.question}"
Detection confidence: ${Math.round(candidate.confidence * 100)}%
Selected folders: ${selectedFolderLabels.join(", ") || "None"}

Conversation context:
${candidate.contextWindow || "No recent context."}

Knowledge context:
${resourceContext || "No external resources."}

Extracted intent:
- Problem statement: ${candidate.understanding.problemStatement}
- Constraints: ${candidate.understanding.constraints.join("; ") || "none"}
- Edge cases: ${candidate.understanding.edgeCases.join("; ") || "none"}

Return STRICT JSON only:
{
  "answer": "Speak-ready answer in <= 95 words",
  "follow_ups": ["optional follow-up 1", "optional follow-up 2"],
  "question_understanding": {
    "problemStatement": "normalized coding prompt",
    "constraints": ["constraint 1"],
    "edgeCases": ["edge case 1"]
  }
}

Rules:
- Be concise and practical.
- If coding, mention approach + data structure + complexity + one edge case.
- No markdown, no explanation outside JSON.`

  const raw = await invokeLlm(prompt)
  return parseAnswerEnvelope(raw, candidate)
}

export const generateRefinedAnswer = async (args: RefineAnswerArgs): Promise<string> => {
  const { candidate, draftAnswer, suggestion, resourceContext, invokeLlm } = args
  const prompt = `You are an interview copilot.

Original question:
${candidate.question}

Draft answer:
${draftAnswer}

Refinement goal:
${suggestion}

Context:
${candidate.contextWindow || "No context"}

Knowledge context:
${resourceContext || "No external resources."}

Return plain text only, <= 140 words, spoken-friendly.
Include one practical caveat and one edge case if technical.`

  const raw = await invokeLlm(prompt)
  return cleanLLMResponse(raw)
}

const parseQuality = (raw: string, fallback: AnswerQualityAnalytics): QualityJudgeResult => {
  try {
    const parsed = JSON.parse(sanitizeJsonPayload(raw)) as Record<string, unknown>
    const qualityRaw =
      parsed?.quality && typeof parsed.quality === "object"
        ? (parsed.quality as Record<string, unknown>)
        : parsed
    const quality: AnswerQualityAnalytics = {
      clarity: clamp01(Number(qualityRaw?.clarity ?? fallback.clarity)),
      correctness: clamp01(Number(qualityRaw?.correctness ?? fallback.correctness)),
      concision: clamp01(Number(qualityRaw?.concision ?? fallback.concision)),
      relevance: clamp01(Number(qualityRaw?.relevance ?? fallback.relevance)),
      overall: clamp01(Number(qualityRaw?.overall ?? fallback.overall))
    }
    const notes =
      typeof parsed?.notes === "string" && parsed.notes.trim()
        ? parsed.notes.trim()
        : undefined
    return { quality, notes }
  } catch {
    return { quality: fallback }
  }
}

export const judgeAnswerQuality = async (args: JudgeAnswerArgs): Promise<QualityJudgeResult> => {
  const { candidate, answer, invokeLlm } = args
  const fallback = heuristicQuality(answer)
  const prompt = `You are an independent answer quality judge.
Return STRICT JSON only.

Question:
${candidate.question}

Answer:
${answer}

Return:
{
  "quality": {
    "clarity": 0.0,
    "correctness": 0.0,
    "concision": 0.0,
    "relevance": 0.0,
    "overall": 0.0
  },
  "notes": "one short sentence"
}

Scoring guide:
- clarity: easy to speak and understand
- correctness: technically sound
- concision: avoids fluff
- relevance: directly answers the asked question`

  try {
    const raw = await invokeLlm(prompt)
    return parseQuality(raw, fallback)
  } catch {
    return { quality: fallback }
  }
}

