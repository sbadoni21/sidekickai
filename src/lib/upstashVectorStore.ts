import { DEFAULT_KNOWLEDGE_FOLDER_ID } from "./resourcesStore"
import type { ResourceFolderType, ResourceItem, UserResources } from "./resourcesStore"

type WorkspaceFolder = "resume" | "jd" | "resource"

interface VectorMetadata {
  userId: string
  folder: WorkspaceFolder
  resourceId: string
  title: string
  url?: string
  resourceFolderId?: string
  resourceFolderName?: string
  resourceFolderType?: ResourceFolderType
  chunkIndex: number
  updatedAt: number
}

interface UpstashVectorPayload {
  id: string
  data: string
  metadata: VectorMetadata
}

export interface UpstashQueryMatch {
  id: string
  score: number
  data: string
  metadata: VectorMetadata
}

export interface HybridQueryMatch extends UpstashQueryMatch {
  retrieval: "vector" | "lexical" | "hybrid"
  vectorScore: number
  lexicalScore: number
  fusedScore: number
}

export interface HybridQueryOptions {
  resources: UserResources
  includeFolders?: WorkspaceFolder[]
  selectedJdIds?: string[]
  selectedResourceFolderIds?: string[]
  topKVector?: number
  finalTopK?: number
}

export interface UpstashSyncResult {
  ok: boolean
  indexed: number
  deleted: number
  error?: string
}

const UPSTASH_VECTOR_URL = (import.meta.env.VITE_UPSTASH_VECTOR_REST_URL || "").trim().replace(/\/$/, "")
const UPSTASH_VECTOR_TOKEN = (import.meta.env.VITE_UPSTASH_VECTOR_REST_TOKEN || "").trim()
const MANIFEST_PREFIX = "cluely_vector_manifest_v1_"

const normalizeUserNamespace = (userId: string): string => {
  const normalized = userId.replace(/[^a-zA-Z0-9_-]/g, "_")
  return `workspace_${normalized.slice(0, 120)}`
}

const localManifestKey = (userId: string): string => `${MANIFEST_PREFIX}${userId}`

const safeParse = <T>(value: string | null, fallback: T): T => {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

const getStoredManifest = (userId: string): string[] => {
  const raw = localStorage.getItem(localManifestKey(userId))
  const parsed = safeParse<string[]>(raw, [])
  return Array.isArray(parsed) ? parsed : []
}

const saveStoredManifest = (userId: string, vectorIds: string[]) => {
  localStorage.setItem(localManifestKey(userId), JSON.stringify(vectorIds))
}

const isConfigured = (): boolean => Boolean(UPSTASH_VECTOR_URL && UPSTASH_VECTOR_TOKEN)

export const getUpstashVectorConfigStatus = (): {
  configured: boolean
  missing: string[]
  namespaceExample: string
} => {
  const missing: string[] = []
  if (!UPSTASH_VECTOR_URL) missing.push("VITE_UPSTASH_VECTOR_REST_URL")
  if (!UPSTASH_VECTOR_TOKEN) missing.push("VITE_UPSTASH_VECTOR_REST_TOKEN")
  return {
    configured: missing.length === 0,
    missing,
    namespaceExample: normalizeUserNamespace("example-user")
  }
}

export const isUpstashVectorConfigured = (): boolean => isConfigured()

const buildEndpoint = (
  operation: "upsert-data" | "delete" | "query-data",
  namespace: string
): string => {
  return `${UPSTASH_VECTOR_URL}/${operation}/${encodeURIComponent(namespace)}`
}

const vectorHeaders = (): Record<string, string> => ({
  Authorization: `Bearer ${UPSTASH_VECTOR_TOKEN}`,
  "Content-Type": "application/json"
})

const chunkText = (text: string, chunkSize = 850, overlap = 120): string[] => {
  const normalized = text.replace(/\r\n/g, "\n").trim()
  if (!normalized) return []
  if (normalized.length <= chunkSize) return [normalized]

  const chunks: string[] = []
  let start = 0
  while (start < normalized.length) {
    const end = Math.min(normalized.length, start + chunkSize)
    const chunk = normalized.slice(start, end).trim()
    if (chunk) chunks.push(chunk)
    if (end >= normalized.length) break
    start = Math.max(0, end - overlap)
  }
  return chunks
}

const tokenize = (text: string): string[] =>
  (text.toLowerCase().match(/[a-z0-9]+/g) || []).filter(token => token.length > 2)

const lexicalOverlapScore = (queryTokens: string[], title: string, content: string): number => {
  if (queryTokens.length === 0) return 0
  const titleText = title.toLowerCase()
  const contentText = content.toLowerCase()
  let score = 0
  queryTokens.forEach(token => {
    if (titleText.includes(token)) score += 2.2
    else if (contentText.includes(token)) score += 1
  })
  return score / Math.max(1, queryTokens.length)
}

const toVectorId = (
  userId: string,
  folder: WorkspaceFolder,
  resourceId: string,
  chunkIndex: number
): string => {
  const raw = `${userId}|${folder}|${resourceId}|${chunkIndex}`
  return raw.replace(/\s+/g, "_").slice(0, 220)
}

const toVectorPayloads = (userId: string, resources: UserResources): UpstashVectorPayload[] => {
  const vectors: UpstashVectorPayload[] = []
  const folderMetaById = new Map(
    (resources.knowledgeFolders || []).map(folder => [
      folder.id,
      { id: folder.id, name: folder.name, type: folder.type } as const
    ])
  )

  if (resources.resume.trim()) {
    const resumeChunks = chunkText(resources.resume)
    resumeChunks.forEach((chunk, index) => {
      vectors.push({
        id: toVectorId(userId, "resume", "resume", index),
        data: chunk,
        metadata: {
          userId,
          folder: "resume",
          resourceId: "resume",
          title: "Candidate Resume",
          chunkIndex: index,
          updatedAt: Date.now()
        }
      })
    })
  }

  const pushItemChunks = (items: ResourceItem[], folder: WorkspaceFolder) => {
    items.forEach((item) => {
      const chunks = chunkText(item.content)
      const linkedFolder =
        folder === "resource" && item.folderId
          ? folderMetaById.get(item.folderId)
          : undefined
      chunks.forEach((chunk, index) => {
        vectors.push({
          id: toVectorId(userId, folder, item.id, index),
          data: chunk,
          metadata: {
            userId,
            folder,
            resourceId: item.id,
            title: item.title,
            url: item.url,
            resourceFolderId: linkedFolder?.id,
            resourceFolderName: linkedFolder?.name,
            resourceFolderType: linkedFolder?.type,
            chunkIndex: index,
            updatedAt: item.updatedAt
          }
        })
      })
    })
  }

  pushItemChunks(resources.documents, "jd")
  pushItemChunks(resources.knowledge, "resource")
  return vectors
}

const requestJson = async (
  url: string,
  method: "POST" | "DELETE",
  body?: unknown
) => {
  const response = await fetch(url, {
    method,
    headers: vectorHeaders(),
    body: body ? JSON.stringify(body) : undefined
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Upstash ${response.status}: ${errorText}`)
  }

  if (response.status === 204) return null
  return response.json()
}

const parseQueryMatches = (payload: any): UpstashQueryMatch[] => {
  const rawMatches = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.result)
    ? payload.result
    : Array.isArray(payload?.matches)
    ? payload.matches
    : []

  return rawMatches
    .map((entry: any) => ({
      id: typeof entry?.id === "string" ? entry.id : "",
      score: typeof entry?.score === "number" ? entry.score : 0,
      data: typeof entry?.data === "string" ? entry.data : "",
      metadata: {
        userId: typeof entry?.metadata?.userId === "string" ? entry.metadata.userId : "",
        folder:
          entry?.metadata?.folder === "resume" || entry?.metadata?.folder === "jd"
            ? entry.metadata.folder
            : "resource",
        resourceId: typeof entry?.metadata?.resourceId === "string" ? entry.metadata.resourceId : "",
        title: typeof entry?.metadata?.title === "string" ? entry.metadata.title : "Untitled",
        url: typeof entry?.metadata?.url === "string" ? entry.metadata.url : undefined,
        resourceFolderId:
          typeof entry?.metadata?.resourceFolderId === "string"
            ? entry.metadata.resourceFolderId
            : undefined,
        resourceFolderName:
          typeof entry?.metadata?.resourceFolderName === "string"
            ? entry.metadata.resourceFolderName
            : undefined,
        resourceFolderType:
          entry?.metadata?.resourceFolderType === "qa" ||
          entry?.metadata?.resourceFolderType === "code_reference" ||
          entry?.metadata?.resourceFolderType === "architecture" ||
          entry?.metadata?.resourceFolderType === "cheatsheet" ||
          entry?.metadata?.resourceFolderType === "notes"
            ? entry.metadata.resourceFolderType
            : "other",
        chunkIndex: typeof entry?.metadata?.chunkIndex === "number" ? entry.metadata.chunkIndex : 0,
        updatedAt: typeof entry?.metadata?.updatedAt === "number" ? entry.metadata.updatedAt : 0
      }
    }))
    .filter((entry: UpstashQueryMatch) => entry.id && entry.data)
}

export const syncWorkspaceVectors = async (
  userId: string,
  resources: UserResources
): Promise<UpstashSyncResult> => {
  if (!isConfigured()) {
    return { ok: false, indexed: 0, deleted: 0, error: "Upstash Vector is not configured." }
  }

  const namespace = normalizeUserNamespace(userId)
  const vectors = toVectorPayloads(userId, resources)
  const nextIds = vectors.map((item) => item.id)
  const previousIds = getStoredManifest(userId)
  const nextIdSet = new Set(nextIds)
  const idsToDelete = previousIds.filter((id) => !nextIdSet.has(id))

  try {
    if (idsToDelete.length > 0) {
      await requestJson(buildEndpoint("delete", namespace), "DELETE", { ids: idsToDelete })
    }
    if (vectors.length > 0) {
      await requestJson(buildEndpoint("upsert-data", namespace), "POST", vectors)
    }
    saveStoredManifest(userId, nextIds)
    return {
      ok: true,
      indexed: vectors.length,
      deleted: idsToDelete.length
    }
  } catch (error: any) {
    return {
      ok: false,
      indexed: 0,
      deleted: 0,
      error: error?.message || "Vector sync failed."
    }
  }
}

export const queryWorkspaceVectors = async (
  userId: string,
  query: string,
  topK = 6
): Promise<UpstashQueryMatch[]> => {
  if (!isConfigured()) return []
  if (!query.trim()) return []

  const namespace = normalizeUserNamespace(userId)
  const payload = await requestJson(buildEndpoint("query-data", namespace), "POST", {
    data: query,
    topK: Math.max(1, Math.min(12, Math.floor(topK))),
    includeMetadata: true,
    includeData: true
  })
  return parseQueryMatches(payload)
}

export const queryWorkspaceHybrid = async (
  userId: string,
  query: string,
  options: HybridQueryOptions
): Promise<HybridQueryMatch[]> => {
  if (!query.trim()) return []

  const includeFolders = new Set<WorkspaceFolder>(options.includeFolders || ["resume", "jd", "resource"])
  const selectedJdIds = new Set(options.selectedJdIds || [])
  const selectedResourceFolderIds = new Set(options.selectedResourceFolderIds || [])
  const queryTokens = tokenize(query)

  const vectorTopK = Math.max(1, Math.min(12, Math.floor(options.topKVector || 8)))
  const finalTopK = Math.max(1, Math.min(12, Math.floor(options.finalTopK || 7)))

  let vectorMatches: UpstashQueryMatch[] = []
  try {
    vectorMatches = await queryWorkspaceVectors(userId, query, vectorTopK)
  } catch {
    vectorMatches = []
  }

  const filteredVectorMatches = vectorMatches.filter(match => {
    const folder = match.metadata.folder
    if (!includeFolders.has(folder)) return false
    if (folder === "jd" && selectedJdIds.size > 0) {
      return selectedJdIds.has(match.metadata.resourceId)
    }
    if (folder === "resource" && selectedResourceFolderIds.size > 0) {
      return selectedResourceFolderIds.has(match.metadata.resourceFolderId || DEFAULT_KNOWLEDGE_FOLDER_ID)
    }
    return true
  })

  const lexicalCandidates: Array<{
    id: string
    data: string
    metadata: VectorMetadata
    lexicalScore: number
  }> = []

  const now = Date.now()
  if (includeFolders.has("resume") && options.resources.resume.trim()) {
    lexicalCandidates.push({
      id: `${userId}-resume-lexical`,
      data: options.resources.resume.trim(),
      lexicalScore: lexicalOverlapScore(queryTokens, "Candidate Resume", options.resources.resume),
      metadata: {
        userId,
        folder: "resume",
        resourceId: "resume",
        title: "Candidate Resume",
        chunkIndex: 0,
        updatedAt: now
      }
    })
  }

  if (includeFolders.has("jd")) {
    options.resources.documents.forEach(item => {
      if (selectedJdIds.size > 0 && !selectedJdIds.has(item.id)) return
      if (!item.content.trim()) return
      lexicalCandidates.push({
        id: `${userId}-jd-${item.id}-lexical`,
        data: item.content.trim(),
        lexicalScore: lexicalOverlapScore(queryTokens, item.title, item.content),
        metadata: {
          userId,
          folder: "jd",
          resourceId: item.id,
          title: item.title,
          url: item.url,
          chunkIndex: 0,
          updatedAt: item.updatedAt
        }
      })
    })
  }

  if (includeFolders.has("resource")) {
    const folderById = new Map(options.resources.knowledgeFolders.map(folder => [folder.id, folder] as const))
    options.resources.knowledge.forEach(item => {
      const folderId = item.folderId || DEFAULT_KNOWLEDGE_FOLDER_ID
      if (selectedResourceFolderIds.size > 0 && !selectedResourceFolderIds.has(folderId)) return
      if (!item.content.trim()) return
      const linkedFolder = folderById.get(folderId)
      lexicalCandidates.push({
        id: `${userId}-resource-${item.id}-lexical`,
        data: item.content.trim(),
        lexicalScore: lexicalOverlapScore(queryTokens, item.title, item.content),
        metadata: {
          userId,
          folder: "resource",
          resourceId: item.id,
          title: item.title,
          url: item.url,
          resourceFolderId: linkedFolder?.id || folderId,
          resourceFolderName: linkedFolder?.name,
          resourceFolderType: linkedFolder?.type,
          chunkIndex: 0,
          updatedAt: item.updatedAt
        }
      })
    })
  }

  const fusionByKey = new Map<string, HybridQueryMatch>()

  filteredVectorMatches.forEach((match, index, all) => {
    const vectorScore = Math.max(0, 1 - index / Math.max(1, all.length))
    const lexicalScore = Math.max(
      0,
      Math.min(1, lexicalOverlapScore(queryTokens, match.metadata.title, match.data) / 3)
    )
    const fusedScore = Math.max(0, Math.min(1, vectorScore * 0.68 + lexicalScore * 0.32))
    const key = `${match.metadata.folder}:${match.metadata.resourceId}:${match.metadata.chunkIndex}`
    fusionByKey.set(key, {
      ...match,
      retrieval: lexicalScore > 0 ? "hybrid" : "vector",
      vectorScore,
      lexicalScore,
      fusedScore
    })
  })

  lexicalCandidates
    .filter(item => item.lexicalScore > 0)
    .forEach(item => {
      const key = `${item.metadata.folder}:${item.metadata.resourceId}:lexical`
      const lexicalScore = Math.max(0, Math.min(1, item.lexicalScore / 3))
      const existing = fusionByKey.get(key)
      if (existing) {
        existing.lexicalScore = Math.max(existing.lexicalScore, lexicalScore)
        existing.fusedScore = Math.max(existing.fusedScore, existing.vectorScore * 0.7 + existing.lexicalScore * 0.3)
        if (existing.vectorScore > 0) {
          existing.retrieval = "hybrid"
        }
        return
      }

      fusionByKey.set(key, {
        id: item.id,
        score: lexicalScore,
        data: item.data.slice(0, 1200),
        metadata: item.metadata,
        retrieval: "lexical",
        vectorScore: 0,
        lexicalScore,
        fusedScore: lexicalScore
      })
    })

  return Array.from(fusionByKey.values())
    .sort((a, b) => b.fusedScore - a.fusedScore)
    .slice(0, finalTopK)
}
