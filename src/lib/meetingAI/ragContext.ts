import {
  DEFAULT_KNOWLEDGE_FOLDER_ID,
  RESOURCE_FOLDER_TYPE_LABELS,
  type ResourceItem,
  type ResourceFolderType,
  type UserResources
} from "../resourcesStore"
import { queryWorkspaceVectors } from "../upstashVectorStore"
import type { ResourceContextBundle } from "./types"
import { getQuestionTokens } from "./questionDetection"

type WorkspaceFolder = "resume" | "jd" | "resource"

interface HybridChunk {
  id: string
  folder: WorkspaceFolder
  resourceId: string
  title: string
  text: string
  url?: string
  resourceFolderId?: string
  resourceFolderName?: string
  resourceFolderType?: ResourceFolderType
  vectorScore: number
  lexicalScore: number
  fusedScore: number
}

interface BuildHybridResourceContextArgs {
  userId: string
  question: string
  resources: UserResources
  includeResume: boolean
  includeJd: boolean
  includeResources: boolean
  selectedJdIds: Set<string>
  selectedResourceFolderIds: Set<string>
  maxContextLength?: number
  vectorTopK?: number
  finalTopK?: number
  onWarning?: (message: string) => void
}

const normalizeText = (text: string): string => text.replace(/\s+/g, " ").trim()

const truncate = (text: string, limit: number): string => {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}...`
}

const tokenizeContent = (text: string): Set<string> => new Set(getQuestionTokens(text))

const lexicalOverlapScore = (questionTokens: string[], title: string, content: string): number => {
  if (questionTokens.length === 0) return 0
  const titleTokens = tokenizeContent(title)
  const contentTokens = tokenizeContent(content)

  let score = 0
  questionTokens.forEach(token => {
    if (titleTokens.has(token)) score += 2.4
    else if (contentTokens.has(token)) score += 1
  })

  return score / Math.max(1, questionTokens.length)
}

const labelForChunk = (chunk: HybridChunk): string => {
  if (chunk.folder === "resume") return "RESUME"
  if (chunk.folder === "jd") return "INTERVIEW JD"
  if (chunk.resourceFolderName) {
    const typeLabel = chunk.resourceFolderType
      ? RESOURCE_FOLDER_TYPE_LABELS[chunk.resourceFolderType]
      : "Other"
    return `RESOURCE (${chunk.resourceFolderName} - ${typeLabel})`
  }
  return "RESOURCE"
}

const toLocalChunks = (
  resources: UserResources,
  includeResume: boolean,
  includeJd: boolean,
  includeResources: boolean,
  selectedJdIds: Set<string>,
  selectedResourceFolderIds: Set<string>
): HybridChunk[] => {
  const chunks: HybridChunk[] = []

  if (includeResume && resources.resume.trim()) {
    chunks.push({
      id: "resume-local",
      folder: "resume",
      resourceId: "resume",
      title: "Candidate Resume",
      text: resources.resume.trim(),
      vectorScore: 0,
      lexicalScore: 0,
      fusedScore: 0
    })
  }

  if (includeJd) {
    resources.documents
      .filter(item => selectedJdIds.has(item.id))
      .forEach(item => {
        if (!item.content.trim()) return
        chunks.push({
          id: `jd-local-${item.id}`,
          folder: "jd",
          resourceId: item.id,
          title: item.title,
          text: item.content.trim(),
          url: item.url,
          vectorScore: 0,
          lexicalScore: 0,
          fusedScore: 0
        })
      })
  }

  if (includeResources) {
    resources.knowledge
      .filter(item =>
        selectedResourceFolderIds.has(item.folderId || DEFAULT_KNOWLEDGE_FOLDER_ID)
      )
      .forEach(item => {
        if (!item.content.trim()) return
        const linkedFolder = resources.knowledgeFolders.find(
          folder => folder.id === (item.folderId || DEFAULT_KNOWLEDGE_FOLDER_ID)
        )
        chunks.push({
          id: `resource-local-${item.id}`,
          folder: "resource",
          resourceId: item.id,
          title: item.title,
          text: item.content.trim(),
          url: item.url,
          resourceFolderId: linkedFolder?.id,
          resourceFolderName: linkedFolder?.name,
          resourceFolderType: linkedFolder?.type,
          vectorScore: 0,
          lexicalScore: 0,
          fusedScore: 0
        })
      })
  }

  return chunks
}

const normalizeVectorRankScore = (index: number, total: number): number => {
  if (total <= 0) return 0
  return Math.max(0, 1 - index / Math.max(1, total))
}

export const buildHybridResourceContext = async (
  args: BuildHybridResourceContextArgs
): Promise<ResourceContextBundle> => {
  const {
    userId,
    question,
    resources,
    includeResume,
    includeJd,
    includeResources,
    selectedJdIds,
    selectedResourceFolderIds,
    maxContextLength = 4200,
    vectorTopK = 8,
    finalTopK = 7,
    onWarning
  } = args

  const questionTokens = getQuestionTokens(question)
  if (!includeResume && !includeJd && !includeResources) {
    return { context: "", sources: [] }
  }

  const localChunks = toLocalChunks(
    resources,
    includeResume,
    includeJd,
    includeResources,
    selectedJdIds,
    selectedResourceFolderIds
  )

  const lexicalByKey = new Map<string, HybridChunk>()
  localChunks.forEach(chunk => {
    const lexicalScore = lexicalOverlapScore(questionTokens, chunk.title, chunk.text)
    const normalizedLexical = Math.max(0, Math.min(1, lexicalScore / 3))
    lexicalByKey.set(`${chunk.folder}:${chunk.resourceId}`, {
      ...chunk,
      lexicalScore: normalizedLexical,
      fusedScore: normalizedLexical
    })
  })

  let vectorMatches: HybridChunk[] = []
  try {
    const rawMatches = await queryWorkspaceVectors(userId, question, vectorTopK)
    vectorMatches = rawMatches
      .filter(match => {
        if (match.metadata.folder === "resume") return includeResume
        if (match.metadata.folder === "jd") return includeJd && selectedJdIds.has(match.metadata.resourceId)
        if (match.metadata.folder === "resource") {
          if (!includeResources) return false
          if (match.metadata.resourceFolderId) {
            return selectedResourceFolderIds.has(match.metadata.resourceFolderId)
          }
          return includeResources
        }
        return false
      })
      .map((match, index, all) => {
        const key = `${match.metadata.folder}:${match.metadata.resourceId}`
        const lexicalSeed = lexicalByKey.get(key)
        const lexicalScore =
          lexicalSeed?.lexicalScore ??
          Math.max(0, Math.min(1, lexicalOverlapScore(questionTokens, match.metadata.title, match.data) / 3))
        const vectorScore = normalizeVectorRankScore(index, all.length)
        const titleBoost = questionTokens.some(token =>
          match.metadata.title.toLowerCase().includes(token)
        )
          ? 0.06
          : 0
        const fusedScore = Math.max(0, Math.min(1, vectorScore * 0.68 + lexicalScore * 0.32 + titleBoost))

        return {
          id: `vector-${match.id}`,
          folder: match.metadata.folder,
          resourceId: match.metadata.resourceId,
          title: match.metadata.title,
          text: match.data,
          url: match.metadata.url,
          resourceFolderId: match.metadata.resourceFolderId,
          resourceFolderName: match.metadata.resourceFolderName,
          resourceFolderType: match.metadata.resourceFolderType,
          vectorScore,
          lexicalScore,
          fusedScore
        } satisfies HybridChunk
      })
  } catch (error: any) {
    onWarning?.(`Vector lookup failed; using lexical retrieval only (${error?.message || "unknown"}).`)
  }

  const fusedByKey = new Map<string, HybridChunk>()
  vectorMatches.forEach(chunk => {
    const key = `${chunk.folder}:${chunk.resourceId}:${chunk.title}:${chunk.text.slice(0, 80)}`
    const existing = fusedByKey.get(key)
    if (!existing || chunk.fusedScore > existing.fusedScore) {
      fusedByKey.set(key, chunk)
    }
  })

  lexicalByKey.forEach(chunk => {
    const key = `${chunk.folder}:${chunk.resourceId}:${chunk.title}:${chunk.text.slice(0, 80)}`
    const existing = fusedByKey.get(key)
    if (!existing) {
      fusedByKey.set(key, {
        ...chunk,
        fusedScore: chunk.lexicalScore
      })
      return
    }

    const merged = {
      ...existing,
      lexicalScore: Math.max(existing.lexicalScore, chunk.lexicalScore),
      fusedScore: Math.max(
        existing.fusedScore,
        Math.max(existing.vectorScore, existing.lexicalScore) * 0.85 +
          Math.min(existing.vectorScore, existing.lexicalScore) * 0.15
      )
    }
    fusedByKey.set(key, merged)
  })

  const ranked = Array.from(fusedByKey.values())
    .sort((a, b) => b.fusedScore - a.fusedScore)
    .slice(0, Math.max(1, Math.min(finalTopK, 10)))

  const sections: string[] = []
  const sources: string[] = []
  ranked.forEach(chunk => {
    sections.push(`${labelForChunk(chunk)}: ${chunk.title}\n${truncate(normalizeText(chunk.text), 900)}`)
    if (chunk.title) sources.push(chunk.title)
  })

  const combined = sections.join("\n\n")
  return {
    context: combined.length > maxContextLength ? `${combined.slice(0, maxContextLength)}...` : combined,
    sources: Array.from(new Set(sources)).slice(0, 16),
    retrievalStats: {
      vectorMatches: vectorMatches.length,
      lexicalMatches: Array.from(lexicalByKey.values()).filter(item => item.lexicalScore > 0).length,
      fusedMatches: ranked.length
    }
  }
}

