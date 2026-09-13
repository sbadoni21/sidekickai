import type { CodingQuestionUnderstanding } from "../meetingsStore"
import type {
  ModelQuestionClassification,
  QuestionCandidate,
  MeetingAudioSource,
  MeetingRole
} from "./types"
import { inferFrameworkFromText, inferLanguageFromText, inferMeetingIntent } from "./problemMemory"

const clamp01 = (value: number): number => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0))

const DEFAULT_EDGE_CASES = [
  "empty input",
  "single element",
  "duplicates",
  "maximum constraint boundary"
]

const DEFAULT_PM_EDGE_CASES = [
  "user adoption risk",
  "stakeholder alignment",
  "technical dependency",
  "measurement ambiguity"
]

const stopWords = new Set([
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
  "had"
])

const questionStarterRegex =
  /^(what|why|how|when|where|who|which|can you|could you|would you|will you|tell me|walk me through|describe|explain|give me|do you|are you|have you|did you)\b/i
const questionCueAnywhereRegex =
  /\b(what|why|how|when|where|who|which|can you|could you|would you|will you|tell me|walk me through|describe|explain|give me|do you|are you|have you|did you)\b/i
const questionSignalRegex =
  /\b(explain|describe|walk me through|tell me|give me|compare|difference|trade-?off|approach|design|implement|optimi[sz]e|debug|why|how|what)\b/i
const technicalSignalRegex =
  /\b(array|string|graph|tree|heap|stack|queue|hash|map|set|dp|dynamic programming|greedy|binary search|two pointer|sliding window|sort|time complexity|space complexity|big o|edge case|constraints?|algorithm|data structure|api|database|schema|query|endpoint|auth|token|latency|throughput|memory|cpu|index|pipeline)\b/i
const productSignalRegex =
  /\b(product|roadmap|prioriti[sz]e|prioritization|metric|kpi|north star|retention|activation|engagement|conversion|funnel|churn|launch|mvp|go to market|gtm|user|customer|persona|segment|experiment|a\/b|stakeholder|adoption|pricing|feature|backlog|strategy|trade-?off)\b/i
const transformSignalRegex =
  /\b(convert|conversion|transform|map|parse|serialize|deserialize|normalize|format|cast|truncate|migrate)\b/i
const identifierSignalRegex = /\b(id|identifier|uuid|primary key|foreign key)\b/i
const numericTransformSignalRegex =
  /\b(from|to|into|between|vs|versus)\b.*\b\d+\b|\b\d+\b.*\b(from|to|into|between|vs|versus)\b/i
const problemStatementRegex =
  /\b(you are given|given an? (integer|array|string|graph|tree)|group size|return (true|false)|consecutive|divide the array|can be divided|output|find|determine)\b/i
const productProblemStatementRegex =
  /\b(design a product|how would you improve|what would you build|how would you prioriti[sz]e|which feature|what metric|how do you measure|why did adoption|should we launch|target user|customer problem|go to market)\b/i
const followUpRegex = /^(and|also|then|what about|how about|plus|one more|another)\b/i
const nonQuestionFillerRegex = /^(ok|okay|right|sure|thanks|great|cool|nice|yep|yeah|hmm|uh|um)\b/i
const confirmationTailRegex = /\b(right|all right|ok|okay|correct)\?*$/i
const constraintSignalRegex =
  /\b(at most|at least|exactly|less than|greater than|no more than|must|cannot|without|in place|in-place|o\([^)]+\)|time complexity|space complexity|n\s*[<>=]{1,2}\s*\d+|k\s*[<>=]{1,2}\s*\d+)\b/gi
const edgeCaseSignalRegex =
  /\b(empty|null|undefined|single|one element|duplicate|negative|zero|overflow|underflow|sorted|reverse sorted|all same|all equal|large input)\b/gi

const sanitizeJsonPayload = (raw: string): string => {
  return raw
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim()
}

const tokenize = (text: string): string[] =>
  (text.toLowerCase().match(/[a-z0-9]+/g) || []).filter(
    token => token.length > 2 && !stopWords.has(token)
  )

export const normalizeQuestionSignature = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()

export const buildQuestionUnderstanding = (
  question: string,
  contextWindow: string,
  role: MeetingRole = "developer"
): CodingQuestionUnderstanding => {
  const normalizedQuestion = question.replace(/\s+/g, " ").trim()
  const sourceText = `${contextWindow}\n${normalizedQuestion}`.toLowerCase()

  const constraints = Array.from(
    new Set((sourceText.match(constraintSignalRegex) || []).map(item => item.trim()))
  ).slice(0, 6)

  const edgeCases = Array.from(
    new Set((sourceText.match(edgeCaseSignalRegex) || []).map(item => item.trim()))
  ).slice(0, 6)

  const problemStatement = normalizedQuestion
    .replace(/^(can you|could you|would you|please|hey|ok|okay)\s+/i, "")
    .replace(/\?+$/, "")
    .trim()

  return {
    problemStatement: problemStatement || normalizedQuestion,
    constraints,
    edgeCases: edgeCases.length > 0 ? edgeCases : role === "product_manager" ? DEFAULT_PM_EDGE_CASES : DEFAULT_EDGE_CASES
  }
}

const splitTranscriptIntoCandidates = (text: string): string[] => {
  const normalized = text.replace(/\s+/g, " ").trim()
  if (!normalized) return []

  const sentences = normalized
    .split(/(?<=[?.!])\s+/)
    .map(item => item.trim())
    .filter(Boolean)

  const cueRegex = new RegExp(questionCueAnywhereRegex.source, "gi")
  const cueSegments = Array.from(normalized.matchAll(cueRegex))
    .map(match => {
      if (typeof match.index !== "number") return ""
      return normalized
        .slice(match.index)
        .replace(/^(so|then|and|also)\s+/i, "")
        .trim()
    })
    .filter(item => item.length >= 14)
    .slice(-4)

  const unique = Array.from(
    new Set([...sentences, ...cueSegments].map(item => normalizeQuestionSignature(item)))
  )
  return unique.length > 0 ? unique : [normalized]
}

const scoreQuestionConfidence = (text: string, role: MeetingRole = "developer"): number => {
  const normalized = text.replace(/\s+/g, " ").trim()
  if (!normalized) return 0

  const words = normalized.split(" ").filter(Boolean)
  const hasQuestionMark = normalized.endsWith("?")
  const hasStarter = questionStarterRegex.test(normalized)
  const hasEmbeddedCue = !hasStarter && questionCueAnywhereRegex.test(normalized)
  const hasQuestionSignal = questionSignalRegex.test(normalized)
  const hasTechnicalSignal = technicalSignalRegex.test(normalized)
  const hasProductSignal = productSignalRegex.test(normalized)
  const hasTransformSignal = transformSignalRegex.test(normalized)
  const hasIdentifierSignal = identifierSignalRegex.test(normalized)
  const hasNumericTransformSignal = numericTransformSignalRegex.test(normalized)
  const hasRoleSignal = role === "product_manager" ? hasProductSignal : hasTechnicalSignal
  const hasSignal =
    hasQuestionSignal ||
    hasRoleSignal ||
    hasTransformSignal ||
    (hasIdentifierSignal && hasNumericTransformSignal)
  const hasProblemStatement = problemStatementRegex.test(normalized)
  const hasProductProblemStatement = productProblemStatementRegex.test(normalized)
  const hasRoleProblemStatement = role === "product_manager" ? hasProductProblemStatement : hasProblemStatement
  const hasConfirmationTail = confirmationTailRegex.test(normalized)

  let score = 0
  if (hasQuestionMark) score += 0.45
  if (hasStarter) score += 0.32
  if (hasEmbeddedCue) score += 0.24
  if (hasQuestionSignal) score += 0.18
  if (hasTechnicalSignal) score += role === "product_manager" ? 0.05 : 0.15
  if (hasProductSignal) score += role === "product_manager" ? 0.18 : 0.05
  if (hasTransformSignal) score += 0.12
  if (hasIdentifierSignal) score += 0.08
  if (hasNumericTransformSignal) score += 0.1
  if (hasRoleProblemStatement) score += 0.32
  if (followUpRegex.test(normalized)) score += 0.12
  if (words.length >= 7 && words.length <= 30) score += 0.1
  if (words.length > 45) score -= 0.05
  if (words.length < 6) score -= 0.25
  if (nonQuestionFillerRegex.test(normalized) && words.length <= 5) score -= 0.4
  if (hasConfirmationTail) score -= 0.45
  if (!hasStarter && !hasSignal && !hasQuestionMark && !hasRoleProblemStatement) score -= 0.25
  return clamp01(score)
}

export const getQuestionDetectionThreshold = (
  question: string,
  role: MeetingRole = "developer"
): number => {
  const normalized = question.replace(/\s+/g, " ").trim()
  const hasStarter = questionStarterRegex.test(normalized)
  const hasProductSignal = productSignalRegex.test(normalized)
  const hasSignal =
    questionSignalRegex.test(normalized) ||
    (role === "product_manager" ? hasProductSignal : technicalSignalRegex.test(normalized)) ||
    transformSignalRegex.test(normalized) ||
    (identifierSignalRegex.test(normalized) && numericTransformSignalRegex.test(normalized))
  const hasQuestionMark = normalized.endsWith("?")
  const hasProblemStatement =
    role === "product_manager"
      ? productProblemStatementRegex.test(normalized)
      : problemStatementRegex.test(normalized)

  if (hasProblemStatement) return 0.42
  if (hasQuestionMark && (hasStarter || hasSignal)) return 0.46
  if (hasStarter && hasSignal) return 0.48
  if (hasStarter) return 0.5
  if (hasSignal) return 0.54
  return 0.62
}

export const isLikelyInterviewQuestion = (
  question: string,
  confidence: number,
  role: MeetingRole = "developer"
): boolean => {
  const normalized = question.replace(/\s+/g, " ").trim()
  const words = normalized.split(" ").filter(Boolean)
  const hasStarter = questionStarterRegex.test(normalized)
  const hasProductSignal = productSignalRegex.test(normalized)
  const hasSignal =
    questionSignalRegex.test(normalized) ||
    (role === "product_manager" ? hasProductSignal : technicalSignalRegex.test(normalized)) ||
    transformSignalRegex.test(normalized) ||
    (identifierSignalRegex.test(normalized) && numericTransformSignalRegex.test(normalized))
  const hasQuestionMark = normalized.endsWith("?")
  const hasProblemStatement =
    role === "product_manager"
      ? productProblemStatementRegex.test(normalized)
      : problemStatementRegex.test(normalized)
  const confirmationOnly = confirmationTailRegex.test(normalized) && words.length <= 12

  if (confirmationOnly && !hasStarter) return false
  if (!hasStarter && !hasSignal && !hasQuestionMark && !hasProblemStatement) return false
  if (words.length < 5 && !hasStarter && !hasQuestionMark) return false
  if (confidence < getQuestionDetectionThreshold(normalized, role)) return false
  return true
}

export const buildHeuristicQuestionCandidate = (
  text: string,
  source: MeetingAudioSource,
  contextWindow: string,
  role: MeetingRole = "developer"
): QuestionCandidate | null => {
  const segments = splitTranscriptIntoCandidates(text)
  if (segments.length === 0) return null

  let bestQuestion = ""
  let bestScore = 0
  segments.forEach((segment, index) => {
    const positionBoost = ((index + 1) / Math.max(segments.length, 1)) * 0.03
    const score = clamp01(scoreQuestionConfidence(segment, role) + positionBoost)
    if (score > bestScore) {
      bestScore = score
      bestQuestion = segment
    }
  })

  if (!bestQuestion) return null
  if (!isLikelyInterviewQuestion(bestQuestion, bestScore, role)) return null

  return {
    id: `question-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    question: bestQuestion,
    source,
    role,
    confidence: bestScore,
    contextWindow,
    detectedAt: Date.now(),
    understanding: buildQuestionUnderstanding(bestQuestion, contextWindow, role)
  }
}

const normalizeUnderstanding = (
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

const normalizeIntentLabel = (value: unknown): ModelQuestionClassification["intent"] => {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()

  if (
    normalized === "theory" ||
    normalized === "write_code" ||
    normalized === "debug_code" ||
    normalized === "optimize" ||
    normalized === "complexity" ||
    normalized === "dry_run" ||
    normalized === "test_cases" ||
    normalized === "clarify" ||
    normalized === "behavioral" ||
    normalized === "system_design" ||
    normalized === "screen_analysis"
  ) {
    return normalized
  }

  return "other"
}

export const classifyQuestionIntentWithModel = async (
  candidate: QuestionCandidate,
  invokeLlm: (prompt: string) => Promise<string>,
  role: MeetingRole = candidate.role || "developer"
): Promise<ModelQuestionClassification> => {
  const prompt = role === "product_manager"
    ? `You are a strict intent classifier for live Product Manager interview transcripts.
Return STRICT JSON only.

Transcript source: ${candidate.source}
Candidate question text: """${candidate.question}"""
Recent context:
${candidate.contextWindow || "No context"}

Return:
{
  "is_question": true,
  "confidence": 0.0,
  "normalized_question": "single cleaned question",
  "question_type": "product-sense|product-strategy|execution|behavioral|clarification|other",
  "intent": "behavioral|system_design|clarify|other",
  "language_hint": "none",
  "framework_hint": "none",
  "rationale": "short reason",
  "question_understanding": {
    "problem_statement": "normalized product question",
    "constraints": ["..."],
    "edge_cases": ["..."]
  }
}

Rules:
- Treat product sense, prioritization, roadmap, metrics, execution, experimentation, GTM, and stakeholder-management prompts as valid PM interview questions.
- Use "system_design" for structured PM answers about product strategy, feature prioritization, product design, metrics, launches, or tradeoffs.
- Use "behavioral" for past-experience, leadership, conflict, ownership, or influence questions.
- Use "clarify" for short conceptual definitions or comparisons.
- If uncertain, lower confidence instead of hallucinating.
- confidence must be in [0,1].`
    : `You are a strict intent classifier for live interview transcripts.
Return STRICT JSON only.

Transcript source: ${candidate.source}
Candidate question text: """${candidate.question}"""
Recent context:
${candidate.contextWindow || "No context"}

Return:
{
  "is_question": true,
  "confidence": 0.0,
  "normalized_question": "single cleaned question",
  "question_type": "coding|system-design|behavioral|clarification|other",
  "intent": "theory|write_code|debug_code|optimize|complexity|dry_run|test_cases|clarify|behavioral|system_design|other",
  "language_hint": "JavaScript|TypeScript|Python|Kotlin|Swift|PHP|Ruby|Scala|Dart|SQL|Java|C++|C#|Go|Rust|none",
  "framework_hint": "React|Angular|Vue|Next.js|Nuxt|Svelte|SvelteKit|Remix|SolidJS|Preact|Astro|Express|NestJS|Fastify|Koa|Hapi|Django|Flask|FastAPI|Spring Boot|Laravel|Ruby on Rails|ASP.NET Core|React Native|Expo|Flutter|Electron|Tauri|none",
  "rationale": "short reason",
  "question_understanding": {
    "problem_statement": "normalized problem statement",
    "constraints": ["..."],
    "edge_cases": ["..."]
  }
}

Rules:
- Treat coding + system design + technical clarifications as valid interview questions.
- Use "write_code" for requests asking for implementation, code, snippet, sample, or example.
- Use "debug_code" for bug fixing or failure analysis.
- Use "optimize" for better complexity or more efficient approach.
- Use "complexity" for Big-O / time-space questions.
- Use "dry_run" for trace / walkthrough requests.
- Use "test_cases" for cases / edge-case enumeration requests.
- If uncertain, lower confidence instead of hallucinating.
- confidence must be in [0,1].`

  const fallbackUnderstanding = candidate.understanding
  try {
    const raw = await invokeLlm(prompt)
    const parsed = JSON.parse(sanitizeJsonPayload(raw)) as Record<string, unknown>
    const isQuestion = Boolean(parsed?.is_question)
    const confidence = clamp01(Number(parsed?.confidence ?? candidate.confidence))
    const normalizedQuestion =
      typeof parsed?.normalized_question === "string" && parsed.normalized_question.trim()
        ? parsed.normalized_question.trim()
        : candidate.question
    const questionType =
      typeof parsed?.question_type === "string" && parsed.question_type.trim()
        ? parsed.question_type.trim().toLowerCase()
        : "other"
    const intent =
      typeof parsed?.intent === "string" && parsed.intent.trim()
        ? normalizeIntentLabel(parsed.intent)
        : inferMeetingIntent(normalizedQuestion, candidate.contextWindow, role)
    const languageHint =
      typeof parsed?.language_hint === "string" && parsed.language_hint.trim()
        ? inferLanguageFromText(parsed.language_hint.trim())
        : inferLanguageFromText(`${normalizedQuestion}\n${candidate.contextWindow}`)
    const frameworkHint =
      typeof parsed?.framework_hint === "string" && parsed.framework_hint.trim()
        ? inferFrameworkFromText(parsed.framework_hint.trim()) || parsed.framework_hint.trim()
        : inferFrameworkFromText(`${normalizedQuestion}\n${candidate.contextWindow}`)
    const rationale =
      typeof parsed?.rationale === "string" ? parsed.rationale.trim() : undefined

    const understandingRaw =
      parsed?.question_understanding && typeof parsed.question_understanding === "object"
        ? (parsed.question_understanding as Partial<CodingQuestionUnderstanding>)
        : null

    return {
      isQuestion,
      confidence,
      normalizedQuestion,
      questionType,
      intent,
      languageHint,
      frameworkHint,
      rationale,
      understanding: normalizeUnderstanding(understandingRaw, fallbackUnderstanding)
    }
  } catch {
    return {
      isQuestion: isLikelyInterviewQuestion(candidate.question, candidate.confidence, role),
      confidence: candidate.confidence,
      normalizedQuestion: candidate.question,
      questionType: "other",
      intent: inferMeetingIntent(candidate.question, candidate.contextWindow, role),
      languageHint: inferLanguageFromText(`${candidate.question}\n${candidate.contextWindow}`),
      frameworkHint: inferFrameworkFromText(`${candidate.question}\n${candidate.contextWindow}`),
      understanding: fallbackUnderstanding
    }
  }
}

export const getQuestionTokens = (text: string): string[] => tokenize(text)
