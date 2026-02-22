export interface ResourceItem {
  id: string
  title: string
  content: string
  url?: string
  createdAt: number
  updatedAt: number
}

export interface UserResources {
  resume: string
  documents: ResourceItem[]
  knowledge: ResourceItem[]
}

const RESOURCES_PREFIX = "cluely_resources_v1_"

const emptyResources: UserResources = {
  resume: "",
  documents: [],
  knowledge: []
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
  const stored = safeParse<UserResources>(raw, emptyResources)
  return {
    resume: stored.resume || "",
    documents: stored.documents || [],
    knowledge: stored.knowledge || []
  }
}

export const saveResources = (userId: string, resources: UserResources) => {
  localStorage.setItem(`${RESOURCES_PREFIX}${userId}`, JSON.stringify(resources))
}

export const createResourceItem = (params: {
  title: string
  content: string
  url?: string
}): ResourceItem => {
  const now = Date.now()
  return {
    id: `${now}-${Math.random().toString(16).slice(2)}`,
    title: params.title.trim(),
    content: params.content.trim(),
    url: params.url?.trim() || undefined,
    createdAt: now,
    updatedAt: now
  }
}
