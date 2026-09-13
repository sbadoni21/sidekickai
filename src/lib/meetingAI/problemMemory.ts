import type { CodingQuestionUnderstanding } from "../meetingsStore"
import type {
  CodingIntent,
  MeetingRole,
  ProblemMemory,
  QuestionCandidate,
  ScreenProblemAnalysis
} from "./types"

interface LanguagePattern {
  pattern: RegExp
  label: string
}

interface FrameworkPattern {
  pattern: RegExp
  label: string
}

const LANGUAGE_PATTERNS: LanguagePattern[] = [
  { pattern: /\btypescript\b|\bts\b/i, label: "TypeScript" },
  { pattern: /\bjavascript\b|\bjs\b|\bnode(?:\.js)?\b/i, label: "JavaScript" },
  { pattern: /\bpython\b|\bpy\b/i, label: "Python" },
  { pattern: /\bkotlin\b|\bkt\b/i, label: "Kotlin" },
  { pattern: /\bswift\b/i, label: "Swift" },
  { pattern: /\bphp\b/i, label: "PHP" },
  { pattern: /\bruby\b|\brb\b/i, label: "Ruby" },
  { pattern: /\bscala\b/i, label: "Scala" },
  { pattern: /\bdart\b|\bflutter\b/i, label: "Dart" },
  { pattern: /\bsql\b|\bmysql\b|\bpostgres(?:ql)?\b|\bsqlite\b/i, label: "SQL" },
  { pattern: /\bjava\b/i, label: "Java" },
  { pattern: /\bc\+\+\b|\bcpp\b/i, label: "C++" },
  { pattern: /\bc#\b|\bcsharp\b/i, label: "C#" },
  { pattern: /\bgolang\b|\bgo\b/i, label: "Go" },
  { pattern: /\brust\b/i, label: "Rust" }
]

const FRAMEWORK_PATTERNS: FrameworkPattern[] = [
  { pattern: /\bnext(?:\.js|js)?\b/i, label: "Next.js" },
  { pattern: /\breact native\b/i, label: "React Native" },
  { pattern: /\breact(?:\.js|js)?\b/i, label: "React" },
  { pattern: /\bangular\b/i, label: "Angular" },
  { pattern: /\bvue(?:\.js|js)?\b/i, label: "Vue" },
  { pattern: /\bnuxt(?:\.js|js)?\b/i, label: "Nuxt" },
  { pattern: /\bsveltekit\b/i, label: "SvelteKit" },
  { pattern: /\bsvelte\b/i, label: "Svelte" },
  { pattern: /\bremix\b/i, label: "Remix" },
  { pattern: /\bsolid(?:\.js|js)?\b/i, label: "SolidJS" },
  { pattern: /\bpreact\b/i, label: "Preact" },
  { pattern: /\bastro\b/i, label: "Astro" },
  { pattern: /\bexpress(?:\.js|js)?\b/i, label: "Express" },
  { pattern: /\bnest(?:\.js|js)?\b/i, label: "NestJS" },
  { pattern: /\bfastify\b/i, label: "Fastify" },
  { pattern: /\bkoa\b/i, label: "Koa" },
  { pattern: /\bhapi\b/i, label: "Hapi" },
  { pattern: /\bdjango\b/i, label: "Django" },
  { pattern: /\bflask\b/i, label: "Flask" },
  { pattern: /\bfastapi\b/i, label: "FastAPI" },
  { pattern: /\bspring boot\b/i, label: "Spring Boot" },
  { pattern: /\blaravel\b/i, label: "Laravel" },
  { pattern: /\bruby on rails\b|\brails\b/i, label: "Ruby on Rails" },
  { pattern: /\basp\.?net core\b|\.net core\b/i, label: "ASP.NET Core" },
  { pattern: /\bflutter\b/i, label: "Flutter" },
  { pattern: /\bexpo\b/i, label: "Expo" },
  { pattern: /\belectron\b/i, label: "Electron" },
  { pattern: /\btauri\b/i, label: "Tauri" }
]

const uniqueStrings = (values: Array<string | undefined | null>, limit = 8): string[] =>
  Array.from(
    new Set(
      values
        .filter((value): value is string => typeof value === "string")
        .map(value => value.trim())
        .filter(Boolean)
    )
  ).slice(0, limit)

const normalizeIntent = (value: unknown): CodingIntent => {
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

export const normalizeLanguageLabel = (value: string | undefined | null): string | undefined => {
  if (!value) return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  if (/^(none|unspecified|null|undefined)$/i.test(trimmed)) return undefined

  for (const entry of LANGUAGE_PATTERNS) {
    if (entry.pattern.test(trimmed)) {
      return entry.label
    }
  }

  return trimmed
}

export const normalizeFrameworkLabel = (value: string | undefined | null): string | undefined => {
  if (!value) return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  if (/^(none|unspecified|null|undefined)$/i.test(trimmed)) return undefined

  for (const entry of FRAMEWORK_PATTERNS) {
    if (entry.pattern.test(trimmed)) {
      return entry.label
    }
  }

  return trimmed
}

export const inferFrameworkFromText = (text: string): string | undefined => {
  for (const entry of FRAMEWORK_PATTERNS) {
    if (entry.pattern.test(text)) {
      return entry.label
    }
  }
  return undefined
}

export const inferDefaultLanguageForFramework = (framework: string | undefined | null): string | undefined => {
  const normalized = normalizeFrameworkLabel(framework)
  if (!normalized) return undefined

  if (
    normalized === "React" ||
    normalized === "Vue" ||
    normalized === "Svelte" ||
    normalized === "SvelteKit" ||
    normalized === "Nuxt" ||
    normalized === "Express" ||
    normalized === "Fastify" ||
    normalized === "Koa" ||
    normalized === "Hapi" ||
    normalized === "Electron" ||
    normalized === "Tauri" ||
    normalized === "Astro" ||
    normalized === "Preact"
  ) {
    return "JavaScript"
  }

  if (
    normalized === "Angular" ||
    normalized === "Next.js" ||
    normalized === "Remix" ||
    normalized === "SolidJS" ||
    normalized === "NestJS" ||
    normalized === "React Native" ||
    normalized === "Expo"
  ) {
    return "TypeScript"
  }

  if (normalized === "Flutter") return "Dart"
  if (normalized === "Django" || normalized === "Flask" || normalized === "FastAPI") return "Python"
  if (normalized === "Spring Boot") return "Java"
  if (normalized === "Laravel") return "PHP"
  if (normalized === "Ruby on Rails") return "Ruby"
  if (normalized === "ASP.NET Core") return "C#"

  return undefined
}

export const inferLanguageFromText = (text: string): string | undefined => {
  for (const entry of LANGUAGE_PATTERNS) {
    if (entry.pattern.test(text)) {
      return entry.label
    }
  }
  return inferDefaultLanguageForFramework(inferFrameworkFromText(text))
}

export const inferCodingIntent = (question: string, contextWindow = ""): CodingIntent => {
  const haystack = `${question}\n${contextWindow}`.toLowerCase()

  if (/\b(tell me about a time|describe a challenge|leadership|conflict|behavioral)\b/i.test(haystack)) {
    return "behavioral"
  }

  if (/\b(system design|design a|scalable|throughput|latency|cache|load balancer|database design)\b/i.test(haystack)) {
    return "system_design"
  }

  if (/\b(debug|fix|bug|broken|failing|not working|error|issue|why (?:is|does|did).*(?:fail|break)|what is wrong)\b/i.test(haystack)) {
    return "debug_code"
  }

  if (/\b(optimi[sz]e|more efficient|improve (?:it|this|that)|reduce (?:time|space)|better approach|faster)\b/i.test(haystack)) {
    return "optimize"
  }

  if (/\b(time complexity|space complexity|big o|complexity)\b/i.test(haystack)) {
    return "complexity"
  }

  if (/\b(dry run|walk through|trace|step by step|simulate|run through example)\b/i.test(haystack)) {
    return "dry_run"
  }

  if (/\b(test case|testcase|test cases|edge cases?|input output|inputs and outputs)\b/i.test(haystack)) {
    return "test_cases"
  }

  if (
    /\b(can you do (?:it|this|that) with|do (?:it|this|that) in|same in|rewrite (?:it|this|that) in|convert (?:it|this|that) to)\b[\s\S]{0,48}\b(javascript|typescript|python|kotlin|swift|php|ruby|scala|dart|sql|java|c\+\+|c#|go|rust|react|angular|vue|next(?:\.js|js)?|nuxt|svelte(?:kit)?|remix|solid(?:\.js|js)?|preact|astro|express|nest(?:\.js|js)?|fastify|koa|hapi|django|flask|fastapi|spring boot|laravel|rails|asp\.?net core|flutter|expo|electron|tauri)\b/i.test(
      haystack
    )
  ) {
    return "write_code"
  }

  if (
    /\b(make|build|create|implement)\b[\s\S]{0,64}\b(form|component|page|screen|widget|api|endpoint|service|controller|app)\b/i.test(
      haystack
    ) &&
    inferFrameworkFromText(haystack)
  ) {
    return "write_code"
  }

  if (/\b(write|show|give|provide|share|create|build|implement)\b[\s\S]{0,48}\b(code|snippet|solution|example|sample|implementation)\b/i.test(haystack)) {
    return "write_code"
  }

  if (/\b(implement|write code|code it|solve it in|show me code|give code|example code)\b/i.test(haystack)) {
    return "write_code"
  }

  if (/\b(explain|difference|what is|how does|why does|clarify|what are)\b/i.test(haystack)) {
    return "clarify"
  }

  if (/\b(call|apply|bind|prototype|closure|promise|event loop|hoisting)\b/i.test(haystack)) {
    return "theory"
  }

  return "other"
}

const inferProductManagerIntent = (question: string, contextWindow = ""): CodingIntent => {
  const haystack = `${question}\n${contextWindow}`.toLowerCase()

  if (
    /\b(tell me about a time|describe a time|walk me through a time|conflict|influence|stakeholder management|cross-functional|leadership|disagreement|ambiguity|ownership|alignment)\b/i.test(
      haystack
    )
  ) {
    return "behavioral"
  }

  if (
    /\b(prioriti[sz]e|prioritization|roadmap|north star|metric|kpi|retention|activation|engagement|conversion|funnel|churn|launch|mvp|go to market|gtm|experiments?|a\/b|user segment|persona|customer pain|pricing|feature|backlog|product strategy|product sense|what would you build|how would you improve|success metric)\b/i.test(
      haystack
    )
  ) {
    return "system_design"
  }

  if (/\b(explain|difference|what is|how would you measure|how do you measure|why|clarify|compare)\b/i.test(haystack)) {
    return "clarify"
  }

  return "other"
}

export const inferMeetingIntent = (
  question: string,
  contextWindow = "",
  role: MeetingRole = "developer"
): CodingIntent => {
  if (role === "product_manager") {
    return inferProductManagerIntent(question, contextWindow)
  }

  return inferCodingIntent(question, contextWindow)
}

export const isCodeHeavyIntent = (intent: CodingIntent): boolean =>
  intent === "write_code" || intent === "debug_code" || intent === "optimize"

export const buildProblemMemoryPatchFromCandidate = (
  candidate: QuestionCandidate,
  source: ProblemMemory["source"] = "conversation"
): Partial<ProblemMemory> => ({
  problemStatement: candidate.understanding.problemStatement,
  constraints: candidate.understanding.constraints,
  edgeCases: candidate.understanding.edgeCases,
  preferredLanguage: normalizeLanguageLabel(candidate.languageHint),
  preferredFramework: normalizeFrameworkLabel(candidate.frameworkHint),
  lastQuestion: candidate.question,
  lastInterviewerAsk: candidate.source === "interviewer" ? candidate.question : undefined,
  lastIntent: candidate.intent,
  source,
  updatedAt: Date.now()
})

const mergePreferNonEmpty = (primary?: string, fallback?: string): string | undefined => {
  const normalizedPrimary = typeof primary === "string" ? primary.trim() : ""
  if (normalizedPrimary) return normalizedPrimary
  const normalizedFallback = typeof fallback === "string" ? fallback.trim() : ""
  return normalizedFallback || undefined
}

export const mergeProblemMemory = (
  current: ProblemMemory | null,
  patch: Partial<ProblemMemory> | null | undefined
): ProblemMemory | null => {
  if (!current && !patch) return null

  const next: ProblemMemory = {
    problemStatement: mergePreferNonEmpty(patch?.problemStatement, current?.problemStatement) || "",
    constraints: uniqueStrings([...(current?.constraints || []), ...(patch?.constraints || [])]),
    edgeCases: uniqueStrings([...(current?.edgeCases || []), ...(patch?.edgeCases || [])]),
    examples: uniqueStrings([...(current?.examples || []), ...(patch?.examples || [])], 6),
    preferredLanguage: normalizeLanguageLabel(
      mergePreferNonEmpty(patch?.preferredLanguage, current?.preferredLanguage)
    ),
    preferredFramework: normalizeFrameworkLabel(
      mergePreferNonEmpty(patch?.preferredFramework, current?.preferredFramework)
    ),
    currentCode: mergePreferNonEmpty(patch?.currentCode, current?.currentCode),
    currentApproach: mergePreferNonEmpty(patch?.currentApproach, current?.currentApproach),
    timeComplexity: mergePreferNonEmpty(patch?.timeComplexity, current?.timeComplexity),
    spaceComplexity: mergePreferNonEmpty(patch?.spaceComplexity, current?.spaceComplexity),
    lastQuestion: mergePreferNonEmpty(patch?.lastQuestion, current?.lastQuestion),
    lastInterviewerAsk: mergePreferNonEmpty(patch?.lastInterviewerAsk, current?.lastInterviewerAsk),
    lastIntent: patch?.lastIntent || current?.lastIntent,
    screenSummary: mergePreferNonEmpty(patch?.screenSummary, current?.screenSummary),
    source: patch?.source || current?.source,
    updatedAt: typeof patch?.updatedAt === "number" ? patch.updatedAt : current?.updatedAt || Date.now()
  }

  if (!next.problemStatement && next.lastQuestion) {
    next.problemStatement = next.lastQuestion
  }

  return next
}

export const buildProblemMemoryContext = (memory: ProblemMemory | null): string => {
  if (!memory) return ""

  const lines = [
    memory.problemStatement ? `Problem: ${memory.problemStatement}` : "",
    memory.preferredLanguage ? `Language lock: ${memory.preferredLanguage}` : "",
    memory.preferredFramework ? `Framework lock: ${memory.preferredFramework}` : "",
    memory.lastInterviewerAsk ? `Last interviewer question: ${memory.lastInterviewerAsk}` : "",
    memory.currentApproach ? `Current approach: ${memory.currentApproach}` : "",
    memory.timeComplexity ? `Time complexity: ${memory.timeComplexity}` : "",
    memory.spaceComplexity ? `Space complexity: ${memory.spaceComplexity}` : "",
    memory.lastQuestion ? `Last question: ${memory.lastQuestion}` : ""
  ].filter(Boolean)

  if (memory.constraints.length > 0) {
    lines.push(`Constraints: ${memory.constraints.join("; ")}`)
  }

  if (memory.edgeCases.length > 0) {
    lines.push(`Edge cases: ${memory.edgeCases.join("; ")}`)
  }

  if (memory.examples.length > 0) {
    lines.push(`Examples: ${memory.examples.slice(0, 3).join(" | ")}`)
  }

  if (memory.currentCode) {
    lines.push(`Current code:\n${memory.currentCode}`)
  }

  return lines.join("\n")
}

export const buildScreenProblemExtractionPrompt = (
  screenSummary: string,
  contextWindow: string,
  currentMemory: ProblemMemory | null
): string => `You are extracting coding interview state from a screen capture summary.
Return STRICT JSON only.

Screen summary:
${screenSummary}

Recent conversation context:
${contextWindow || "No recent context."}

Current problem memory:
${buildProblemMemoryContext(currentMemory) || "None"}

Return:
{
  "active_request": "what the user most likely needs right now",
  "intent": "write_code|debug_code|optimize|complexity|dry_run|test_cases|clarify|theory|other",
  "problem_statement": "normalized visible problem",
  "preferred_language": "JavaScript|TypeScript|Python|Kotlin|Swift|PHP|Ruby|Scala|Dart|SQL|Java|C++|C#|Go|Rust|none",
  "preferred_framework": "React|Angular|Vue|Next.js|Nuxt|Svelte|SvelteKit|Remix|SolidJS|Preact|Astro|Express|NestJS|Fastify|Koa|Hapi|Django|Flask|FastAPI|Spring Boot|Laravel|Ruby on Rails|ASP.NET Core|React Native|Expo|Flutter|Electron|Tauri|none",
  "constraints": ["constraint 1"],
  "edge_cases": ["edge case 1"],
  "examples": ["example 1"],
  "visible_code": "only the visible code if clearly identifiable, else empty string",
  "current_approach": "brief summary",
  "time_complexity": "O(...) if visible or implied",
  "space_complexity": "O(...) if visible or implied"
}

Rules:
- If the screen shows a coding prompt with no code, prefer "write_code".
- If the screen shows code, errors, or failing behavior, prefer "debug_code".
- If the screen shows an existing solution and asks for improvement, prefer "optimize".
- Use "theory" only for concept questions.
- Keep every field concise and factual.
- If asked to write a code then write the code for the problem.
- If language or framework is not visible, infer from the code or say "none".`

const normalizeUnderstanding = (
  value: Partial<CodingQuestionUnderstanding> | null | undefined
): CodingQuestionUnderstanding => ({
  problemStatement:
    typeof value?.problemStatement === "string" && value.problemStatement.trim()
      ? value.problemStatement.trim()
      : "",
  constraints: uniqueStrings(value?.constraints || [], 8),
  edgeCases: uniqueStrings(value?.edgeCases || [], 8)
})

const sanitizeJsonPayload = (raw: string): string =>
  raw
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim()

export const parseScreenProblemAnalysis = (
  raw: string,
  fallback?: Partial<ScreenProblemAnalysis>
): ScreenProblemAnalysis => {
  const fallbackValue: ScreenProblemAnalysis = {
    activeRequest: fallback?.activeRequest || "Help with the visible coding problem",
    intent: normalizeIntent(fallback?.intent),
    problemStatement: fallback?.problemStatement || "",
    preferredLanguage: normalizeLanguageLabel(fallback?.preferredLanguage),
    preferredFramework: normalizeFrameworkLabel(fallback?.preferredFramework),
    constraints: uniqueStrings(fallback?.constraints || []),
    edgeCases: uniqueStrings(fallback?.edgeCases || []),
    examples: uniqueStrings(fallback?.examples || [], 6),
    visibleCode: mergePreferNonEmpty(fallback?.visibleCode, undefined),
    currentApproach: mergePreferNonEmpty(fallback?.currentApproach, undefined),
    timeComplexity: mergePreferNonEmpty(fallback?.timeComplexity, undefined),
    spaceComplexity: mergePreferNonEmpty(fallback?.spaceComplexity, undefined)
  }

  try {
    const parsed = JSON.parse(sanitizeJsonPayload(raw)) as Record<string, unknown>
    const understanding = normalizeUnderstanding({
      problemStatement: typeof parsed.problem_statement === "string" ? parsed.problem_statement : fallbackValue.problemStatement,
      constraints: Array.isArray(parsed.constraints) ? parsed.constraints : fallbackValue.constraints,
      edgeCases: Array.isArray(parsed.edge_cases) ? parsed.edge_cases : fallbackValue.edgeCases
    })

    return {
      activeRequest:
        typeof parsed.active_request === "string" && parsed.active_request.trim()
          ? parsed.active_request.trim()
          : fallbackValue.activeRequest,
      intent: normalizeIntent(parsed.intent || fallbackValue.intent),
      problemStatement: understanding.problemStatement || fallbackValue.problemStatement,
      preferredLanguage: normalizeLanguageLabel(
        typeof parsed.preferred_language === "string" ? parsed.preferred_language : fallbackValue.preferredLanguage
      ),
      preferredFramework: normalizeFrameworkLabel(
        typeof parsed.preferred_framework === "string" ? parsed.preferred_framework : fallbackValue.preferredFramework
      ),
      constraints: understanding.constraints,
      edgeCases: understanding.edgeCases,
      examples: uniqueStrings(Array.isArray(parsed.examples) ? parsed.examples : fallbackValue.examples, 6),
      visibleCode: mergePreferNonEmpty(
        typeof parsed.visible_code === "string" ? parsed.visible_code : undefined,
        fallbackValue.visibleCode
      ),
      currentApproach: mergePreferNonEmpty(
        typeof parsed.current_approach === "string" ? parsed.current_approach : undefined,
        fallbackValue.currentApproach
      ),
      timeComplexity: mergePreferNonEmpty(
        typeof parsed.time_complexity === "string" ? parsed.time_complexity : undefined,
        fallbackValue.timeComplexity
      ),
      spaceComplexity: mergePreferNonEmpty(
        typeof parsed.space_complexity === "string" ? parsed.space_complexity : undefined,
        fallbackValue.spaceComplexity
      )
    }
  } catch {
    return fallbackValue
  }
}
