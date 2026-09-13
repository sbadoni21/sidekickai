import type { AnswerQualityAnalytics, CodingQuestionUnderstanding } from "../meetingsStore"
import { cleanLLMResponse, parseLLMResponse } from "../../utils/lmResponseParser"
import {
  buildProblemMemoryContext,
  inferDefaultLanguageForFramework,
  inferFrameworkFromText,
  inferLanguageFromText,
  inferMeetingIntent,
  isCodeHeavyIntent,
  normalizeFrameworkLabel,
  normalizeLanguageLabel
} from "./problemMemory"
import type {
  AnswerResponseMetadata,
  CodingIntent,
  MeetingRole,
  ParsedAnswerEnvelope,
  ProblemMemory,
  QualityJudgeResult,
  QuestionCandidate
} from "./types"

interface FastDraftArgs {
  candidate: QuestionCandidate
  candidateName: string
  selectedFolderLabels: string[]
  resourceContext: string
  problemMemory?: ProblemMemory | null
  invokeLlm: (prompt: string) => Promise<string>
}

interface RefineAnswerArgs {
  candidate: QuestionCandidate
  draftAnswer: string
  suggestion: string
  resourceContext: string
  problemMemory?: ProblemMemory | null
  invokeLlm: (prompt: string) => Promise<string>
}

interface JudgeAnswerArgs {
  candidate: QuestionCandidate
  answer: string
  problemMemory?: ProblemMemory | null
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

const normalizeIntent = (value: unknown, fallback: CodingIntent): CodingIntent => {
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

  return fallback
}

const heuristicQuality = (answer: string): AnswerQualityAnalytics => {
  const normalized = answer.trim()
  const words = normalized.split(/\s+/).filter(Boolean)
  const hasComplexity = /\b(o\(|time complexity|space complexity|linear|log n|quadratic)\b/i.test(normalized)
  const hasEdgeCase = /\b(edge case|empty|null|duplicate|overflow|boundary)\b/i.test(normalized)
  const hasActionVerb = /\b(use|choose|build|iterate|track|validate|return|handle)\b/i.test(normalized)

  const clarity = clamp01(words.length >= 12 ? 0.72 : 0.5)
  const correctness = clamp01((hasComplexity ? 0.2 : 0) + (hasEdgeCase ? 0.2 : 0) + 0.45)
  const concision = clamp01(words.length <= 160 ? 0.86 : 0.58)
  const relevance = clamp01((hasActionVerb ? 0.22 : 0.1) + (words.length >= 8 ? 0.58 : 0.4))
  const overall = clamp01((clarity + correctness + concision + relevance) / 4)
  return { clarity, correctness, concision, relevance, overall }
}

const containsConcreteCode = (answer: string): boolean =>
  /```[\s\S]+```/.test(answer) ||
  /(?:^|\n)\s*(const|let|var|function|class|def|public static|for\s*\(|while\s*\(|if\s*\()/m.test(answer)

const mentionsComplexity = (answer: string): boolean =>
  /\b(o\([^)]+\)|time complexity|space complexity|big o)\b/i.test(answer)

const looksLikeDryRun = (answer: string): boolean =>
  /\b(step\s*\d+|step-by-step|iterate|pointer|window|index|after this|then)\b/i.test(answer)

const listsTestCases = (answer: string): boolean =>
  /\b(test case|case 1|input|output|empty|single element|duplicates?)\b/i.test(answer)

const resolveRole = (candidate: QuestionCandidate): MeetingRole => candidate.role || "developer"

const resolveIntent = (candidate: QuestionCandidate): CodingIntent =>
  candidate.intent || inferMeetingIntent(candidate.question, candidate.contextWindow, resolveRole(candidate))

const resolveFramework = (
  candidate: QuestionCandidate,
  problemMemory?: ProblemMemory | null
): string | undefined => {
  if (resolveRole(candidate) === "product_manager") return undefined

  return normalizeFrameworkLabel(
    candidate.frameworkHint ||
      problemMemory?.preferredFramework ||
      inferFrameworkFromText(
        `${candidate.question}\n${candidate.contextWindow}\n${buildProblemMemoryContext(problemMemory || null)}`
      )
  )
}

const resolveLanguage = (
  candidate: QuestionCandidate,
  problemMemory?: ProblemMemory | null
): string | undefined => {
  if (resolveRole(candidate) === "product_manager") return undefined

  return normalizeLanguageLabel(
    candidate.languageHint ||
      problemMemory?.preferredLanguage ||
      inferLanguageFromText(
        `${candidate.question}\n${candidate.contextWindow}\n${buildProblemMemoryContext(problemMemory || null)}`
      ) ||
      inferDefaultLanguageForFramework(resolveFramework(candidate, problemMemory))
  )
}

const isJsxFramework = (framework: string | undefined): boolean => {
  const normalized = normalizeFrameworkLabel(framework)
  return (
    normalized === "React" ||
    normalized === "Next.js" ||
    normalized === "Remix" ||
    normalized === "SolidJS" ||
    normalized === "Preact" ||
    normalized === "React Native" ||
    normalized === "Expo"
  )
}

const resolveCodeFenceLanguage = (preferredLanguage?: string, preferredFramework?: string): string => {
  const language = normalizeLanguageLabel(preferredLanguage)
  const framework = normalizeFrameworkLabel(preferredFramework)

  if (framework && isJsxFramework(framework)) {
    if (language === "TypeScript") return "tsx"
    return "jsx"
  }

  if (framework === "Vue" || framework === "Nuxt" || framework === "Svelte" || framework === "SvelteKit") {
    return "html"
  }

  if (framework === "Astro") {
    return "astro"
  }

  if (language === "TypeScript") return "typescript"
  if (language === "JavaScript") return "javascript"
  if (language === "C++") return "cpp"
  if (language === "C#") return "csharp"
  if (language === "SQL") return "sql"

  return String(language || "javascript").trim().toLowerCase()
}

const buildStackLabel = (preferredLanguage?: string, preferredFramework?: string): string => {
  const framework = normalizeFrameworkLabel(preferredFramework)
  const language = normalizeLanguageLabel(preferredLanguage)
  if (framework && language) return `${framework} ${language}`
  return framework || language || "relevant"
}

const detectAnswerLanguage = (answer: string): string | undefined => {
  const parsed = parseLLMResponse(answer)
  if (parsed.type === "code" || parsed.type === "structured") {
    return normalizeLanguageLabel(parsed.language || inferLanguageFromText(parsed.content))
  }

  const explicitMention = normalizeLanguageLabel(inferLanguageFromText(answer))
  if (explicitMention) return explicitMention

  if (
    /^\s*def\s+\w+\s*\(/m.test(answer) ||
    /^\s*class\s+\w+\s*:/m.test(answer) ||
    /\bprint\s*\(/.test(answer) ||
    /\[\s*::-?1\s*\]/.test(answer)
  ) {
    return "Python"
  }

  if (
    /^\s*function\s+\w+\s*\(/m.test(answer) ||
    /^\s*(const|let|var)\s+\w+/m.test(answer) ||
    /=>/.test(answer) ||
    /\.split\(/.test(answer)
  ) {
    return "JavaScript"
  }

  return inferDefaultLanguageForFramework(detectAnswerFramework(answer))
}

const detectAnswerFramework = (answer: string): string | undefined => {
  const parsed = parseLLMResponse(answer)
  const content = parsed.type === "code" || parsed.type === "structured" ? parsed.content : answer
  const explicitFramework = normalizeFrameworkLabel(inferFrameworkFromText(`${answer}\n${content}`))
  if (explicitFramework) return explicitFramework

  if (/from\s+["']react-native["']|StyleSheet\.create|TextInput|TouchableOpacity/.test(content)) {
    return "React Native"
  }

  if (/from\s+["']expo["']|expo-status-bar|expo-router/.test(content)) {
    return "Expo"
  }

  if (/["']use client["']|next\/link|next\/navigation|getServerSideProps|getStaticProps|export default function Page/.test(content)) {
    return "Next.js"
  }

  if (/useLoaderData|useActionData|@remix-run\/react|\bloader\s*\(|\baction\s*\(/.test(content)) {
    return "Remix"
  }

  if (/defineNuxt|useAsyncData|NuxtLink|#imports/.test(content)) {
    return "Nuxt"
  }

  if (/@Component\b|\[\(ngModel\)\]|formControlName|\*ngIf|\*ngFor/.test(content)) {
    return "Angular"
  }

  if (/<template>[\s\S]*<\/template>|<script setup>|defineComponent\(|v-model|v-for=/.test(content)) {
    return "Vue"
  }

  if (/<script>[\s\S]*<\/script>|bind:value|on:click|\$:\s*/.test(content)) {
    return "Svelte"
  }

  if (/createSignal|createEffect|from\s+["']solid-js["']/.test(content)) {
    return "SolidJS"
  }

  if (/from\s+["']preact["']|from\s+["']preact\/hooks["']/.test(content)) {
    return "Preact"
  }

  if (/^---[\s\S]+---/m.test(content) || /Astro\.props|from\s+["']astro/.test(content)) {
    return "Astro"
  }

  if (/from\s+["']react["']|React\.|useState|useEffect|return\s*\(\s*<\w+/m.test(content)) {
    return "React"
  }

  if (/express\(\)|app\.(get|post|put|delete|use|listen)\(|Router\(\)/.test(content)) {
    return "Express"
  }

  if (/@Controller|@Get|@Post|NestFactory|@Injectable/.test(content)) {
    return "NestJS"
  }

  if (/fastify\(\)|FastifyInstance|reply\.send/.test(content)) {
    return "Fastify"
  }

  if (/new\s+Koa\(|\bctx\./.test(content)) {
    return "Koa"
  }

  if (/server\.route\(|@hapi\/hapi/.test(content)) {
    return "Hapi"
  }

  if (/from\s+django|urlpatterns|models\.Model|render\(request/.test(content)) {
    return "Django"
  }

  if (/Flask\(__name__\)|@app\.route/.test(content)) {
    return "Flask"
  }

  if (/FastAPI\(\)|@app\.(get|post|put|delete)\(|BaseModel/.test(content)) {
    return "FastAPI"
  }

  if (/@SpringBootApplication|@RestController|SpringApplication\.run/.test(content)) {
    return "Spring Boot"
  }

  if (/Route::(get|post|put|delete)|extends\s+Controller|Illuminate\\/.test(content)) {
    return "Laravel"
  }

  if (/<\s*ApplicationController|resources\s+:|render\s+json:/.test(content)) {
    return "Ruby on Rails"
  }

  if (/\[ApiController\]|\[Http(Get|Post|Put|Delete)\]|ControllerBase/.test(content)) {
    return "ASP.NET Core"
  }

  if (/StatelessWidget|StatefulWidget|MaterialApp|Scaffold/.test(content)) {
    return "Flutter"
  }

  if (/BrowserWindow|ipcMain|app\.whenReady/.test(content)) {
    return "Electron"
  }

  if (/tauri::|@tauri-apps/.test(content)) {
    return "Tauri"
  }

  return undefined
}

const isAnswerLanguageMismatch = (
  answer: string,
  preferredLanguage: string | undefined,
  intent: CodingIntent
): boolean => {
  const requiredLanguage = normalizeLanguageLabel(preferredLanguage)
  if (!requiredLanguage || !isCodeHeavyIntent(intent)) return false

  const detectedLanguage = detectAnswerLanguage(answer)
  return Boolean(detectedLanguage && detectedLanguage !== requiredLanguage)
}

const isAnswerFrameworkMismatch = (
  answer: string,
  preferredFramework: string | undefined,
  intent: CodingIntent
): boolean => {
  const requiredFramework = normalizeFrameworkLabel(preferredFramework)
  if (!requiredFramework || !isCodeHeavyIntent(intent)) return false

  const detectedFramework = detectAnswerFramework(answer)
  return Boolean(detectedFramework && detectedFramework !== requiredFramework)
}

const buildResponseContract = (
  role: MeetingRole,
  intent: CodingIntent,
  preferredLanguage?: string,
  preferredFramework?: string
): string => {
  if (role === "product_manager") {
    if (intent === "behavioral") {
      return "Return a concise first-person STAR answer under 140 words. Include the action you took and the measurable outcome."
    }

    if (intent === "system_design") {
      return [
        "Return a concise PM interview answer under 150 words.",
        "Structure it as 3 short bullets:",
        "- target user and problem",
        "- recommendation or prioritization logic",
        "- success metric and key risk"
      ].join("\n")
    }

    return "Return a concise PM interview-ready answer under 130 words. Mention the user goal, your recommendation, and one tradeoff or metric when helpful."
  }

  const stackLabel = buildStackLabel(preferredLanguage, preferredFramework)
  const codeFenceLanguage = resolveCodeFenceLanguage(preferredLanguage, preferredFramework)

  if (intent === "write_code") {
    return [
      `Return a compact ${stackLabel} solution in a fenced ${codeFenceLanguage} code block.`,
      preferredFramework ? `Use ${preferredFramework} conventions and APIs, not a different framework.` : "",
      "After the code, add at most 3 short lines:",
      "- approach summary",
      "- time / space complexity",
      "- one key edge case"
    ]
      .filter(Boolean)
      .join("\n")
  }

  if (intent === "debug_code") {
    return [
      `Return the corrected ${stackLabel} code in a fenced ${codeFenceLanguage} code block if code is involved.`,
      preferredFramework ? `Keep the fix inside ${preferredFramework} instead of switching frameworks.` : "",
      "Then add at most 3 short lines:",
      "- root cause",
      "- what changed",
      "- failing edge case"
    ]
      .filter(Boolean)
      .join("\n")
  }

  if (intent === "optimize") {
    return [
      `Return the improved ${stackLabel} solution in a fenced ${codeFenceLanguage} code block when code helps.`,
      preferredFramework ? `Stay within ${preferredFramework}.` : "",
      "Then add at most 4 short lines:",
      "- what was improved",
      "- old complexity",
      "- new complexity",
      "- one tradeoff or caveat"
    ]
      .filter(Boolean)
      .join("\n")
  }

  if (intent === "complexity") {
    return "Return a direct complexity answer with time complexity, space complexity, and one sentence of reasoning."
  }

  if (intent === "dry_run") {
    return "Return a numbered dry run on one concrete example. Keep it concise and step-by-step."
  }

  if (intent === "test_cases") {
    return "Return 4-6 targeted test cases with short input/output expectations."
  }

  if (intent === "behavioral" || intent === "system_design") {
    return "Return a concise interview-ready spoken answer under 140 words."
  }

  return "Return a concise interview-ready answer under 120 words."
}

const buildIntentRules = (
  role: MeetingRole,
  intent: CodingIntent,
  preferredLanguage?: string,
  preferredFramework?: string
): string[] => {
  if (role === "product_manager") {
    if (intent === "behavioral") {
      return [
        "Answer in first person using a clear situation, action, and result.",
        "Keep the story concrete and outcome-oriented.",
        "Mention collaboration, judgment, and measurable impact."
      ]
    }

    if (intent === "system_design") {
      return [
        "Lead with the target user and the core problem.",
        "State your prioritization or recommendation clearly.",
        "Include one tradeoff, one risk, and one metric you would watch."
      ]
    }

    return [
      "Answer like a strong Product Manager in a live interview.",
      "Prioritize user impact, business reasoning, and measurable outcomes.",
      "Do not write code unless the question explicitly asks for a technical example."
    ]
  }

  if (intent === "write_code") {
    return [
      "The user explicitly wants code. Do not answer with theory only.",
      preferredLanguage
        ? `Use only ${preferredLanguage}. Any other programming language is incorrect.`
        : "Prefer the language implied by context.",
      preferredFramework
        ? `Use only ${preferredFramework}. Any other framework is incorrect for this answer.`
        : "Use the framework implied by context if one is requested.",
      "Keep explanation secondary to the code.",
      "Include actual runnable or interview-usable code."
    ]
  }

  if (intent === "debug_code") {
    return [
      "Focus on the bug and the minimal correct fix.",
      preferredLanguage
        ? `Use only ${preferredLanguage} if code is shown or requested. Any other language is incorrect.`
        : "Use the language implied by context if code is shown or requested.",
      preferredFramework
        ? `Keep the solution in ${preferredFramework}. Do not switch frameworks.`
        : "Keep the same framework if one is already implied.",
      "Do not drift into generic theory."
    ]
  }

  if (intent === "optimize") {
    return [
      "Show the better approach and make the complexity improvement explicit.",
      preferredLanguage
        ? `Use only ${preferredLanguage} for code if code is included. Any other language is incorrect.`
        : "Use the language implied by context for code if code is included.",
      preferredFramework
        ? `Keep the optimized code in ${preferredFramework}.`
        : "If a framework is implied, keep using it.",
      "Keep it practical for live interview delivery."
    ]
  }

  if (intent === "complexity") {
    return [
      "Answer the complexity question directly first.",
      "Mention time and space complexity explicitly."
    ]
  }

  if (intent === "dry_run") {
    return [
      "Use a concrete example or sample input.",
      "Keep each step short and easy to follow."
    ]
  }

  if (intent === "test_cases") {
    return [
      "Include normal, edge, and failure-oriented cases.",
      "Prefer interview-relevant cases over exhaustive lists."
    ]
  }

  return [
    "Be concise and practical.",
    "If technical, include one caveat and one edge case."
  ]
}

const buildJudgeRules = (intent: CodingIntent): string[] => {
  return buildJudgeRulesForRole("developer", intent)
}

const buildJudgeRulesForRole = (role: MeetingRole, intent: CodingIntent): string[] => {
  if (role === "product_manager") {
    if (intent === "behavioral") {
      return [
        "Reward concrete actions and measurable outcomes.",
        "Relevance is low if the answer stays generic and never reaches the result."
      ]
    }

    if (intent === "system_design") {
      return [
        "Reward clear prioritization, tradeoffs, and success metrics.",
        "Relevance is low if the answer ignores the user problem or business impact."
      ]
    }

    return [
      "Reward answers that include a recommendation plus at least one tradeoff or metric."
    ]
  }

  if (intent === "write_code" || intent === "debug_code") {
    return [
      "Relevance is low if the answer lacks concrete code.",
      "Heavily penalize theory-only answers."
    ]
  }

  if (intent === "optimize") {
    return [
      "Relevance is low if the answer does not compare or improve complexity.",
      "Reward explicit old vs new tradeoffs."
    ]
  }

  if (intent === "complexity") {
    return [
      "Relevance is low if time and space complexity are not explicit."
    ]
  }

  if (intent === "dry_run") {
    return [
      "Relevance is low if the answer does not walk through concrete steps."
    ]
  }

  if (intent === "test_cases") {
    return [
      "Relevance is low if the answer does not provide concrete cases."
    ]
  }

  return []
}

const buildLanguageCorrectionPrompt = (args: {
  candidate: QuestionCandidate
  answer: string
  intent: CodingIntent
  preferredLanguage?: string
  preferredFramework?: string
  resourceContext?: string
  problemMemory?: ProblemMemory | null
  jsonMode: boolean
  suggestion?: string
}): string => {
  const {
    candidate,
    answer,
    intent,
    preferredLanguage,
    preferredFramework,
    resourceContext,
    problemMemory,
    jsonMode,
    suggestion
  } = args
  const detectedLanguage = detectAnswerLanguage(answer) || "another language"
  const detectedFramework = detectAnswerFramework(answer) || "another framework"
  const stackLabel = buildStackLabel(preferredLanguage, preferredFramework)
  const codeFenceLanguage = resolveCodeFenceLanguage(preferredLanguage, preferredFramework)

  if (jsonMode) {
    return `You are correcting a language mismatch in a coding interview answer.

Original question:
${candidate.question}

Detected intent:
${intent}

Requested language:
${preferredLanguage || "none"}

Previous answer language:
${detectedLanguage}

Requested framework:
${preferredFramework || "none"}

Previous answer framework:
${detectedFramework}

Previous answer:
${answer}

Conversation context:
${candidate.contextWindow || "No recent context."}

Active problem memory:
${buildProblemMemoryContext(problemMemory || null) || "None"}

Knowledge context:
${resourceContext || "No external resources."}

Return STRICT JSON only:
{
  "answer": "${buildResponseContract("developer", intent, preferredLanguage, preferredFramework)}",
  "follow_ups": ["optional follow-up 1", "optional follow-up 2"],
  "question_understanding": {
    "problemStatement": "normalized coding prompt",
    "constraints": ["constraint 1"],
    "edgeCases": ["edge case 1"]
  },
  "response_metadata": {
    "intent": "${intent}",
    "language": "${preferredLanguage}",
    "framework": "${preferredFramework || "None"}",
    "approach": "brief approach summary",
    "time_complexity": "O(...) if relevant",
    "space_complexity": "O(...) if relevant",
    "edge_cases": ["edge case 1"],
    "examples": ["optional example 1"]
  }
}

Rules:
- Rewrite the answer strictly in ${stackLabel}.
- Do not include syntax, keywords, or examples from ${detectedLanguage}.
- ${preferredFramework ? `Do not switch away from ${preferredFramework} or use ${detectedFramework}.` : "Do not switch frameworks if one is implied."}
- If code is requested, the answer must include a fenced ${codeFenceLanguage} code block.
- Keep the answer concise and immediately usable in an interview.
- No markdown or explanation outside the JSON object.`
  }

  return `You are correcting a language mismatch in a coding interview answer.

Original question:
${candidate.question}

Detected intent:
${intent}

Requested language:
${preferredLanguage || "none"}

Previous answer language:
${detectedLanguage}

Requested framework:
${preferredFramework || "none"}

Previous answer framework:
${detectedFramework}

Previous answer:
${answer}

Refinement goal:
${suggestion || "Keep the answer concise and interview-ready."}

Conversation context:
${candidate.contextWindow || "No recent context."}

Active problem memory:
${buildProblemMemoryContext(problemMemory || null) || "None"}

Knowledge context:
${resourceContext || "No external resources."}

Return plain text only.
${buildResponseContract("developer", intent, preferredLanguage, preferredFramework)}

Rules:
- Rewrite the answer strictly in ${stackLabel}.
- Do not include syntax, keywords, or examples from ${detectedLanguage}.
- ${preferredFramework ? `Do not switch away from ${preferredFramework} or use ${detectedFramework}.` : "Do not switch frameworks if one is implied."}
- If code is requested, include a fenced ${codeFenceLanguage} code block.
- Keep the answer concise and immediately usable in an interview.`
}

const applyIntentFallbackPenalty = (
  fallback: AnswerQualityAnalytics,
  intent: CodingIntent,
  answer: string,
  preferredLanguage?: string,
  preferredFramework?: string
): AnswerQualityAnalytics => {
  if ((intent === "write_code" || intent === "debug_code") && !containsConcreteCode(answer)) {
    return {
      ...fallback,
      correctness: clamp01(Math.min(fallback.correctness, 0.42)),
      relevance: clamp01(Math.min(fallback.relevance, 0.28)),
      overall: clamp01(Math.min(fallback.overall, 0.38))
    }
  }

  if (intent === "optimize" && !mentionsComplexity(answer)) {
    return {
      ...fallback,
      relevance: clamp01(Math.min(fallback.relevance, 0.34)),
      overall: clamp01(Math.min(fallback.overall, 0.46))
    }
  }

  if (intent === "complexity" && !mentionsComplexity(answer)) {
    return {
      ...fallback,
      correctness: clamp01(Math.min(fallback.correctness, 0.36)),
      relevance: clamp01(Math.min(fallback.relevance, 0.32)),
      overall: clamp01(Math.min(fallback.overall, 0.4))
    }
  }

  if (intent === "dry_run" && !looksLikeDryRun(answer)) {
    return {
      ...fallback,
      clarity: clamp01(Math.min(fallback.clarity, 0.46)),
      relevance: clamp01(Math.min(fallback.relevance, 0.34)),
      overall: clamp01(Math.min(fallback.overall, 0.42))
    }
  }

  if (intent === "test_cases" && !listsTestCases(answer)) {
    return {
      ...fallback,
      relevance: clamp01(Math.min(fallback.relevance, 0.34)),
      overall: clamp01(Math.min(fallback.overall, 0.42))
    }
  }

  if (isAnswerLanguageMismatch(answer, preferredLanguage, intent)) {
    return {
      ...fallback,
      correctness: clamp01(Math.min(fallback.correctness, 0.28)),
      relevance: clamp01(Math.min(fallback.relevance, 0.12)),
      overall: clamp01(Math.min(fallback.overall, 0.18))
    }
  }

  if (isAnswerFrameworkMismatch(answer, preferredFramework, intent)) {
    return {
      ...fallback,
      correctness: clamp01(Math.min(fallback.correctness, 0.34)),
      relevance: clamp01(Math.min(fallback.relevance, 0.16)),
      overall: clamp01(Math.min(fallback.overall, 0.24))
    }
  }

  return fallback
}

const parseMetadata = (
  rawMetadata: unknown,
  fallbackIntent: CodingIntent,
  fallbackLanguage?: string,
  fallbackFramework?: string
): AnswerResponseMetadata | undefined => {
  if (!rawMetadata || typeof rawMetadata !== "object") {
    return {
      intent: fallbackIntent,
      language: fallbackLanguage,
      framework: fallbackFramework
    }
  }

  const value = rawMetadata as Record<string, unknown>
  return {
    intent: normalizeIntent(value.intent, fallbackIntent),
    language: normalizeLanguageLabel(
      typeof value.language === "string" ? value.language : fallbackLanguage
    ),
    framework: normalizeFrameworkLabel(
      typeof value.framework === "string" ? value.framework : fallbackFramework
    ),
    approach: typeof value.approach === "string" && value.approach.trim() ? value.approach.trim() : undefined,
    timeComplexity:
      typeof value.time_complexity === "string" && value.time_complexity.trim()
        ? value.time_complexity.trim()
        : undefined,
    spaceComplexity:
      typeof value.space_complexity === "string" && value.space_complexity.trim()
        ? value.space_complexity.trim()
        : undefined,
    edgeCases: Array.isArray(value.edge_cases)
      ? value.edge_cases
          .filter(item => typeof item === "string")
          .map(item => item.trim())
          .filter(Boolean)
          .slice(0, 8)
      : undefined,
    examples: Array.isArray(value.examples)
      ? value.examples
          .filter(item => typeof item === "string")
          .map(item => item.trim())
          .filter(Boolean)
          .slice(0, 6)
      : undefined
  }
}

export const parseAnswerEnvelope = (
  raw: string,
  fallbackCandidate: QuestionCandidate,
  problemMemory?: ProblemMemory | null
): ParsedAnswerEnvelope => {
  const fallbackIntent = resolveIntent(fallbackCandidate)
  const fallbackLanguage = resolveLanguage(fallbackCandidate, problemMemory)
  const fallbackFramework = resolveFramework(fallbackCandidate, problemMemory)
  const fallback: ParsedAnswerEnvelope = {
    answer: cleanLLMResponse(raw),
    followUps: [],
    understanding: fallbackCandidate.understanding,
    metadata: {
      intent: fallbackIntent,
      language: fallbackLanguage,
      framework: fallbackFramework
    }
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
          .slice(0, 6)
      : []

    const understandingRaw =
      parsed?.question_understanding && typeof parsed.question_understanding === "object"
        ? (parsed.question_understanding as Partial<CodingQuestionUnderstanding>)
        : null

    const metadata = parseMetadata(parsed?.response_metadata, fallbackIntent, fallbackLanguage, fallbackFramework)
    const detectedLanguage = detectAnswerLanguage(answer)
    const detectedFramework = detectAnswerFramework(answer)

    return {
      answer: cleanLLMResponse(answer),
      followUps,
      understanding: fallbackUnderstanding(understandingRaw, fallbackCandidate.understanding),
      metadata: metadata
        ? {
            ...metadata,
            language: detectedLanguage || metadata.language,
            framework: detectedFramework || metadata.framework
          }
        : metadata
    }
  } catch {
    return fallback
  }
}

export const generateFastDraftAnswer = async (args: FastDraftArgs): Promise<ParsedAnswerEnvelope> => {
  const { candidate, candidateName, selectedFolderLabels, resourceContext, problemMemory, invokeLlm } = args
  const role = resolveRole(candidate)
  const intent = resolveIntent(candidate)
  const preferredFramework = resolveFramework(candidate, problemMemory)
  const preferredLanguage = resolveLanguage(candidate, problemMemory)
  const prompt = `You are an interview copilot for ${
    role === "product_manager" ? "Product Manager interviews" : "coding interviews"
  }.

Candidate: ${candidateName || "Candidate"}
Question source: ${candidate.source === "interviewer" ? "Interviewer" : "User"}
Role mode: ${role === "product_manager" ? "Product Manager" : "Developer"}
Detected question: "${candidate.question}"
Detected intent: ${intent}
Detection confidence: ${Math.round(candidate.confidence * 100)}%
Selected folders: ${selectedFolderLabels.join(", ") || "None"}

Conversation context:
${candidate.contextWindow || "No recent context."}

Active problem memory:
${buildProblemMemoryContext(problemMemory || null) || "None"}

Knowledge context:
${resourceContext || "No external resources."}

${role === "product_manager"
  ? `PM answer style:
- Answer like a product manager, not an engineer.
- Lead with the user problem, your recommendation, the tradeoff, and what you would measure.
- Avoid code, APIs, and implementation details unless the question explicitly asks for them.`
  : ""}

Extracted understanding:
- Problem statement: ${candidate.understanding.problemStatement}
- Constraints: ${candidate.understanding.constraints.join("; ") || "none"}
- Edge cases: ${candidate.understanding.edgeCases.join("; ") || "none"}
${role === "product_manager" ? "" : `- Preferred framework: ${preferredFramework || "unspecified"}`}
${role === "product_manager" ? "" : `- Preferred language: ${preferredLanguage || "unspecified"}`}

Return STRICT JSON only:
{
  "answer": "${buildResponseContract(role, intent, preferredLanguage, preferredFramework)}",
  "follow_ups": ["optional follow-up 1", "optional follow-up 2"],
  "question_understanding": {
    "problemStatement": "${role === "product_manager" ? "normalized product question" : "normalized coding prompt"}",
    "constraints": ["constraint 1"],
    "edgeCases": ["edge case 1"]
  },
  "response_metadata": {
    "intent": "${intent}",
    "language": "${role === "product_manager" ? "None" : preferredLanguage || "None"}",
    "framework": "${role === "product_manager" ? "None" : preferredFramework || "None"}",
    "approach": "brief approach summary",
    "time_complexity": "${role === "product_manager" ? "None" : "O(...) if relevant"}",
    "space_complexity": "${role === "product_manager" ? "None" : "O(...) if relevant"}",
    "edge_cases": ["edge case 1"],
    "examples": ["optional example 1"]
  }
}

Rules:
${buildIntentRules(role, intent, preferredLanguage, preferredFramework)
  .map(rule => `- ${rule}`)
  .join("\n")}
- Directly answer the request instead of describing what you would do.
- No markdown or explanation outside the JSON object.`

  const raw = await invokeLlm(prompt)
  let parsed = parseAnswerEnvelope(raw, candidate, problemMemory)

  if (
    (preferredLanguage && isAnswerLanguageMismatch(parsed.answer, preferredLanguage, intent)) ||
    (preferredFramework && isAnswerFrameworkMismatch(parsed.answer, preferredFramework, intent))
  ) {
    if (role === "developer") {
      const correctedRaw = await invokeLlm(
        buildLanguageCorrectionPrompt({
          candidate,
          answer: parsed.answer,
          intent,
          preferredLanguage,
          preferredFramework,
          resourceContext,
          problemMemory,
          jsonMode: true
        })
      )
      parsed = parseAnswerEnvelope(correctedRaw, candidate, problemMemory)
    }
  }

  return parsed
}

export const generateRefinedAnswer = async (args: RefineAnswerArgs): Promise<string> => {
  const { candidate, draftAnswer, suggestion, resourceContext, problemMemory, invokeLlm } = args
  const role = resolveRole(candidate)
  const intent = resolveIntent(candidate)
  const preferredFramework = resolveFramework(candidate, problemMemory)
  const preferredLanguage = resolveLanguage(candidate, problemMemory)
  const prompt = `You are an interview copilot for ${
    role === "product_manager" ? "Product Manager interviews" : "coding interviews"
  }.

Original question:
${candidate.question}

Detected intent:
${intent}

Draft answer:
${draftAnswer}

Refinement goal:
${suggestion}

Recent conversation context:
${candidate.contextWindow || "No context"}

Active problem memory:
${buildProblemMemoryContext(problemMemory || null) || "None"}

Knowledge context:
${resourceContext || "No external resources."}

${role === "product_manager"
  ? `PM answer style:
- Sound like a strong product manager.
- Keep the answer user-centered, strategic, and metric-aware.
- Avoid code or engineering implementation details unless explicitly requested.`
  : ""}

Return plain text only.
${buildResponseContract(role, intent, preferredLanguage, preferredFramework)}

Rules:
${buildIntentRules(role, intent, preferredLanguage, preferredFramework)
  .map(rule => `- ${rule}`)
  .join("\n")}
- Improve the draft without making it longer than needed.
- Keep the answer ready for immediate interview use.`

  const raw = await invokeLlm(prompt)
  let refined = cleanLLMResponse(raw)

  if (
    (preferredLanguage && isAnswerLanguageMismatch(refined, preferredLanguage, intent)) ||
    (preferredFramework && isAnswerFrameworkMismatch(refined, preferredFramework, intent))
  ) {
    if (role === "developer") {
      const correctedRaw = await invokeLlm(
        buildLanguageCorrectionPrompt({
          candidate,
          answer: refined,
          intent,
          preferredLanguage,
          preferredFramework,
          resourceContext,
          problemMemory,
          jsonMode: false,
          suggestion
        })
      )
      refined = cleanLLMResponse(correctedRaw)
    }
  }

  return refined
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
  const { candidate, answer, problemMemory, invokeLlm } = args
  const role = resolveRole(candidate)
  const intent = resolveIntent(candidate)
  const preferredFramework = resolveFramework(candidate, problemMemory)
  const preferredLanguage = resolveLanguage(candidate, problemMemory)
  const fallback = applyIntentFallbackPenalty(
    heuristicQuality(answer),
    intent,
    answer,
    preferredLanguage,
    preferredFramework
  )
  const prompt = `You are an independent answer quality judge for ${
    role === "product_manager" ? "Product Manager interview answers" : "coding interview answers"
  }.
Return STRICT JSON only.

Question:
${candidate.question}

Detected intent:
${intent}

Active problem memory:
${buildProblemMemoryContext(problemMemory || null) || "None"}

Requested framework:
${preferredFramework || "unspecified"}

Requested language:
${preferredLanguage || "unspecified"}

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
- relevance: directly satisfies the user's request
- If a specific programming language was requested, using a different language is a major relevance failure.
- If a specific framework was requested, using a different framework is a major relevance failure.
${buildJudgeRulesForRole(role, intent)
  .map(rule => `- ${rule}`)
  .join("\n")}`

  try {
    const raw = await invokeLlm(prompt)
    return parseQuality(raw, fallback)
  } catch {
    return { quality: fallback }
  }
}

export const estimateAnswerQuality = (
  candidate: QuestionCandidate,
  answer: string,
  problemMemory?: ProblemMemory | null
): AnswerQualityAnalytics => {
  const intent = resolveIntent(candidate)
  const preferredFramework = resolveFramework(candidate, problemMemory)
  const preferredLanguage = resolveLanguage(candidate, problemMemory)
  return applyIntentFallbackPenalty(
    heuristicQuality(answer),
    intent,
    answer,
    preferredLanguage,
    preferredFramework
  )
}
