export interface ResourceItem {
  id: string
  title: string
  content: string
  url?: string
  folderId?: string
  folder?: string
  createdAt: number
  updatedAt: number
}

export type ResourceFolderType =
  | "qa"
  | "code_reference"
  | "architecture"
  | "cheatsheet"
  | "notes"
  | "other"

export interface KnowledgeFolder {
  id: string
  name: string
  type: ResourceFolderType
  createdAt: number
  updatedAt: number
}

export interface UserResources {
  resume: string
  documents: ResourceItem[]
  knowledge: ResourceItem[]
  knowledgeFolders: KnowledgeFolder[]
}

const RESOURCES_PREFIX = "cluely_resources_v1_"
export const DEFAULT_KNOWLEDGE_FOLDER_ID = "knowledge-general"
export const DEFAULT_KNOWLEDGE_FOLDER_NAME = "General Resources"

export const RESOURCE_FOLDER_TYPE_LABELS: Record<ResourceFolderType, string> = {
  qa: "Questions & Answers",
  code_reference: "Code References",
  architecture: "System Design",
  cheatsheet: "Cheat Sheets",
  notes: "Concept Notes",
  other: "Other"
}

const emptyResources: UserResources = {
  resume: "",
  documents: [],
  knowledge: [],
  knowledgeFolders: []
}

const safeParse = <T>(value: string | null, fallback: T): T => {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

export const loadResources = (userId: string): UserResources => {
  const raw = localStorage.getItem(`${RESOURCES_PREFIX}${userId}`)
  const stored = safeParse<Partial<UserResources>>(raw, emptyResources)

  const now = Date.now()
  const folderFromName = new Map<string, KnowledgeFolder>()
  const rawFolders = Array.isArray(stored.knowledgeFolders) ? stored.knowledgeFolders : []
  const normalizedFolders: KnowledgeFolder[] = rawFolders
    .map((folder: any) => {
      const name = typeof folder?.name === "string" ? folder.name.trim() : ""
      if (!name) return null
      const id = typeof folder?.id === "string" && folder.id.trim().length > 0
        ? folder.id.trim()
        : `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Math.random().toString(16).slice(2, 8)}`
      const type: ResourceFolderType =
        folder?.type === "qa" ||
        folder?.type === "code_reference" ||
        folder?.type === "architecture" ||
        folder?.type === "cheatsheet" ||
        folder?.type === "notes"
          ? folder.type
          : "other"
      return {
        id,
        name,
        type,
        createdAt: typeof folder?.createdAt === "number" ? folder.createdAt : now,
        updatedAt: typeof folder?.updatedAt === "number" ? folder.updatedAt : now
      } satisfies KnowledgeFolder
    })
    .filter((folder): folder is KnowledgeFolder => Boolean(folder))

  normalizedFolders.forEach(folder => {
    folderFromName.set(folder.name.toLowerCase(), folder)
  })

  const getOrCreateFolderByName = (folderName: string, folderType: ResourceFolderType = "other"): KnowledgeFolder => {
    const normalizedName = folderName.trim() || DEFAULT_KNOWLEDGE_FOLDER_NAME
    const key = normalizedName.toLowerCase()
    const existing = folderFromName.get(key)
    if (existing) return existing
    const created = createKnowledgeFolder({
      name: normalizedName,
      type: folderType
    })
    normalizedFolders.push(created)
    folderFromName.set(key, created)
    return created
  }

  const defaultFolder =
    normalizedFolders.find(folder => folder.id === DEFAULT_KNOWLEDGE_FOLDER_ID) ||
    getOrCreateFolderByName(DEFAULT_KNOWLEDGE_FOLDER_NAME, "other")

  if (defaultFolder.id !== DEFAULT_KNOWLEDGE_FOLDER_ID && defaultFolder.name === DEFAULT_KNOWLEDGE_FOLDER_NAME) {
    defaultFolder.id = DEFAULT_KNOWLEDGE_FOLDER_ID
  }

  const knowledgeItems = (stored.knowledge || []).map((item: any) => {
    const legacyFolderName = typeof item?.folder === "string" ? item.folder.trim() : ""
    const preferredFolderId = typeof item?.folderId === "string" ? item.folderId.trim() : ""
    const hasPreferredFolder = preferredFolderId && normalizedFolders.some(folder => folder.id === preferredFolderId)
    const resolvedFolder = hasPreferredFolder
      ? normalizedFolders.find(folder => folder.id === preferredFolderId)!
      : legacyFolderName
      ? getOrCreateFolderByName(legacyFolderName, "other")
      : defaultFolder

    return {
      id: String(item?.id || `${now}-${Math.random().toString(16).slice(2)}`),
      title: String(item?.title || "Untitled").trim(),
      content: String(item?.content || "").trim(),
      url: typeof item?.url === "string" && item.url.trim() ? item.url.trim() : undefined,
      folderId: resolvedFolder.id,
      folder: undefined,
      createdAt: typeof item?.createdAt === "number" ? item.createdAt : now,
      updatedAt: typeof item?.updatedAt === "number" ? item.updatedAt : now
    } satisfies ResourceItem
  })

  if (normalizedFolders.length === 0) {
    normalizedFolders.push({
      id: DEFAULT_KNOWLEDGE_FOLDER_ID,
      name: DEFAULT_KNOWLEDGE_FOLDER_NAME,
      type: "other",
      createdAt: now,
      updatedAt: now
    })
  }

  return {
    resume: stored.resume || "",
    documents: stored.documents || [],
    knowledge: knowledgeItems,
    knowledgeFolders: normalizedFolders
  }
}

export const saveResources = (userId: string, resources: UserResources) => {
  localStorage.setItem(`${RESOURCES_PREFIX}${userId}`, JSON.stringify(resources))
}

export const createResourceItem = (params: {
  title: string
  content: string
  url?: string
  folderId?: string
}): ResourceItem => {
  const now = Date.now()
  return {
    id: `${now}-${Math.random().toString(16).slice(2)}`,
    title: params.title.trim(),
    content: params.content.trim(),
    url: params.url?.trim() || undefined,
    folderId: params.folderId?.trim() || undefined,
    createdAt: now,
    updatedAt: now
  }
}

export const createKnowledgeFolder = (params: {
  name: string
  type: ResourceFolderType
}): KnowledgeFolder => {
  const now = Date.now()
  return {
    id: `${now}-${Math.random().toString(16).slice(2, 8)}`,
    name: params.name.trim(),
    type: params.type,
    createdAt: now,
    updatedAt: now
  }
}

export const getKnowledgeFolderLabel = (type: ResourceFolderType): string =>
  RESOURCE_FOLDER_TYPE_LABELS[type] || RESOURCE_FOLDER_TYPE_LABELS.other
