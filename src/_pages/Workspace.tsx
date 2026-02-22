import React, { useEffect, useMemo, useState } from "react"
import { ArrowLeft, Database, FileText, Folder, FolderKanban, Link2, RefreshCw, UserSquare2 } from "lucide-react"
import { getCurrentUser } from "../lib/authStore"
import {
  createResourceItem,
  createKnowledgeFolder,
  DEFAULT_KNOWLEDGE_FOLDER_ID,
  DEFAULT_KNOWLEDGE_FOLDER_NAME,
  KnowledgeFolder,
  loadResources,
  RESOURCE_FOLDER_TYPE_LABELS,
  ResourceFolderType,
  ResourceItem,
  saveResources,
  UserResources
} from "../lib/resourcesStore"
import {
  getUpstashVectorConfigStatus,
  syncWorkspaceVectors
} from "../lib/upstashVectorStore"

interface WorkspaceProps {
  onBackToDashboard: () => void
}

type ResourceListKey = "documents" | "knowledge"
type FolderView = "resume" | "jd" | "resources"

interface DraftItem {
  title: string
  content: string
  url: string
}

interface UrlImportEntry {
  section: string
  url: string
}

const emptyResources: UserResources = {
  resume: "",
  documents: [],
  knowledge: [],
  knowledgeFolders: [
    {
      id: DEFAULT_KNOWLEDGE_FOLDER_ID,
      name: DEFAULT_KNOWLEDGE_FOLDER_NAME,
      type: "other",
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
  ]
}

const emptyDraft: DraftItem = {
  title: "",
  content: "",
  url: ""
}

const URL_LINE_REGEX = /^https?:\/\/\S+/i

const parseUrlImportEntries = (raw: string): UrlImportEntry[] => {
  const lines = raw
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)

  const entries: UrlImportEntry[] = []
  let currentSection = "General"

  lines.forEach(line => {
    if (URL_LINE_REGEX.test(line)) {
      entries.push({
        section: currentSection,
        url: line
      })
      return
    }

    const normalized = line.replace(/[:\-]+$/g, "").trim()
    if (normalized) {
      currentSection = normalized
    }
  })

  const deduped = new Set<string>()
  return entries.filter(entry => {
    const key = entry.url.toLowerCase()
    if (deduped.has(key)) return false
    deduped.add(key)
    return true
  })
}

const deriveTitleFromUrl = (url: string): string => {
  try {
    const parsed = new URL(url)
    const segment = parsed.pathname.split("/").filter(Boolean).pop() || parsed.hostname
    const normalized = decodeURIComponent(segment)
      .replace(/\.[a-z0-9]+$/i, "")
      .replace(/[-_]+/g, " ")
      .trim()
    return normalized || parsed.hostname
  } catch {
    return "Imported URL"
  }
}

const RESOURCE_FOLDER_TYPE_OPTIONS: ResourceFolderType[] = [
  "qa",
  "code_reference",
  "architecture",
  "cheatsheet",
  "notes",
  "other"
]

const TEXT_UPLOAD_EXTENSIONS = new Set(["txt", "md", "json", "csv"])
const ENHANCED_UPLOAD_EXTENSIONS = new Set([
  "docx",
  "pdf",
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "bmp",
  "tif",
  "tiff",
  "heic",
  "heif"
])
const SUPPORTED_UPLOAD_EXTENSIONS = new Set([
  ...Array.from(TEXT_UPLOAD_EXTENSIONS),
  ...Array.from(ENHANCED_UPLOAD_EXTENSIONS)
])

const getKnowledgeFolderById = (resources: UserResources, folderId: string): KnowledgeFolder | null =>
  resources.knowledgeFolders.find(folder => folder.id === folderId) || null

const Workspace: React.FC<WorkspaceProps> = ({ onBackToDashboard }) => {
  const currentUser = getCurrentUser()
  const vectorConfig = getUpstashVectorConfigStatus()

  const [resources, setResources] = useState<UserResources>(() => {
    if (!currentUser) return emptyResources
    return loadResources(currentUser.id)
  })
  const [activeFolder, setActiveFolder] = useState<FolderView>("jd")
  const [jdDraft, setJdDraft] = useState<DraftItem>(emptyDraft)
  const [resourceDraft, setResourceDraft] = useState<DraftItem>(emptyDraft)
  const [editingJdId, setEditingJdId] = useState<string | null>(null)
  const [editingResourceId, setEditingResourceId] = useState<string | null>(null)
  const [jdError, setJdError] = useState<string | null>(null)
  const [resourceError, setResourceError] = useState<string | null>(null)
  const [activeKnowledgeFolderId, setActiveKnowledgeFolderId] = useState<string>(() =>
    emptyResources.knowledgeFolders[0]?.id || DEFAULT_KNOWLEDGE_FOLDER_ID
  )
  const [newKnowledgeFolderName, setNewKnowledgeFolderName] = useState("")
  const [newKnowledgeFolderType, setNewKnowledgeFolderType] = useState<ResourceFolderType>("other")
  const [isCreateFolderModalOpen, setIsCreateFolderModalOpen] = useState(false)
  const [createFolderError, setCreateFolderError] = useState<string | null>(null)
  const [urlImportInput, setUrlImportInput] = useState("")
  const [isUrlImporting, setIsUrlImporting] = useState(false)
  const [urlImportStatus, setUrlImportStatus] = useState("")
  const [urlImportError, setUrlImportError] = useState<string | null>(null)
  const [isUrlFetchInProgress, setIsUrlFetchInProgress] = useState<ResourceListKey | null>(null)
  const [movingResourceId, setMovingResourceId] = useState<string | null>(null)
  const [moveTargetFolderId, setMoveTargetFolderId] = useState<string>("")
  const [moveResourceError, setMoveResourceError] = useState<string | null>(null)
  const [isMovingResource, setIsMovingResource] = useState(false)
  const [syncMessage, setSyncMessage] = useState<string>(
    vectorConfig.configured
      ? "Vector DB ready. Add resources and sync."
      : `Missing ${vectorConfig.missing.join(", ")} in .env`
  )
  const [isSyncing, setIsSyncing] = useState(false)

  const persistResources = (next: UserResources) => {
    setResources(next)
    if (currentUser) {
      saveResources(currentUser.id, next)
    }
  }

  const runVectorSync = async (next: UserResources) => {
    if (!currentUser) return
    if (!vectorConfig.configured) {
      setSyncMessage(`Cannot sync. Missing ${vectorConfig.missing.join(", ")}.`)
      return
    }
    setIsSyncing(true)
    setSyncMessage("Syncing workspace to Upstash Vector...")
    const result = await syncWorkspaceVectors(currentUser.id, next)
    if (result.ok) {
      setSyncMessage(
        `Synced ${result.indexed} chunks to vector DB${result.deleted > 0 ? `, removed ${result.deleted}` : ""}.`
      )
    } else {
      setSyncMessage(result.error || "Vector sync failed.")
    }
    setIsSyncing(false)
  }

  const updateResources = async (updater: (prev: UserResources) => UserResources, sync = true) => {
    const next = updater(resources)
    persistResources(next)
    if (sync) {
      await runVectorSync(next)
    }
  }

  const readFileAsBase64 = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => {
        const raw = String(reader.result || "")
        const splitIndex = raw.indexOf(",")
        resolve(splitIndex >= 0 ? raw.slice(splitIndex + 1) : raw)
      }
      reader.onerror = () => {
        reject(new Error("Failed to read selected file."))
      }
      reader.readAsDataURL(file)
    })

  const readFileAsText = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result || ""))
      reader.onerror = () => reject(new Error("Failed to read selected file."))
      reader.readAsText(file)
    })

  const invokeWorkspaceIpc = async (
    channel: "workspace:extract-document-text" | "workspace:extract-document-upload",
    payload: Record<string, unknown>
  ) => {
    const electronAPI = (window as Window & { electronAPI?: any }).electronAPI
    if (electronAPI && typeof electronAPI.invoke === "function") {
      return electronAPI.invoke(channel, payload)
    }

    const requireFn = (window as Window & { require?: (module: string) => any }).require
    if (typeof requireFn === "function") {
      try {
        const ipcRenderer = requireFn("electron")?.ipcRenderer
        if (ipcRenderer && typeof ipcRenderer.invoke === "function") {
          return ipcRenderer.invoke(channel, payload)
        }
      } catch {
        // Ignore and return friendly error below.
      }
    }

    return {
      success: false,
      error: "Desktop bridge is unavailable. Launch with `npm run app:dev` and retry."
    }
  }

  const extractTextFromUpload = async (file: File) => {
    const extension = file.name.split(".").pop()?.toLowerCase() || ""

    if (!SUPPORTED_UPLOAD_EXTENSIONS.has(extension)) {
      return {
        success: false,
        error:
          "Unsupported file type. Use txt, md, json, csv, docx, pdf, or image files."
      }
    }

    if (ENHANCED_UPLOAD_EXTENSIONS.has(extension)) {
      const electronAPI = (window as Window & { electronAPI?: any }).electronAPI

      const filePath = String((file as File & { path?: string }).path || "")
      if (filePath) {
        if (electronAPI && typeof electronAPI.extractDocumentText === "function") {
          return electronAPI.extractDocumentText(filePath, file.name)
        }
        return invokeWorkspaceIpc("workspace:extract-document-text", {
          filePath,
          fileName: file.name
        })
      }

      const base64 = await readFileAsBase64(file)
      if (electronAPI && typeof electronAPI.extractDocumentTextFromUpload === "function") {
        return electronAPI.extractDocumentTextFromUpload(file.name, base64)
      }
      return invokeWorkspaceIpc("workspace:extract-document-upload", {
        fileName: file.name,
        base64
      })
    }

    const content = await readFileAsText(file)
    return { success: true, content }
  }

  const handleResumeFile = async (file: File | null) => {
    if (!file) return
    const extracted = await extractTextFromUpload(file)
    if (!extracted.success || !extracted.content?.trim()) {
      setSyncMessage(extracted.error || "Could not extract readable text from the selected file.")
      return
    }

    const next = { ...resources, resume: extracted.content.trim() }
    persistResources(next)
    await runVectorSync(next)
  }

  const handleDraftFile = (
    file: File | null,
    setDraft: React.Dispatch<React.SetStateAction<DraftItem>>,
    setError: React.Dispatch<React.SetStateAction<string | null>>
  ) => {
    if (!file) return
    setError(null)
    extractTextFromUpload(file)
      .then(result => {
        if (!result.success || !result.content?.trim()) {
          setError(result.error || "Could not extract readable text from the selected file.")
          return
        }
        setDraft(prev => ({
          ...prev,
          title: prev.title || file.name.replace(/\.docx$/i, ""),
          content: result.content || ""
        }))
      })
      .catch((error: any) => {
        setError(error?.message || "File import failed.")
      })
  }

  const startEdit = (
    item: ResourceItem,
    setDraft: React.Dispatch<React.SetStateAction<DraftItem>>,
    setEditing: React.Dispatch<React.SetStateAction<string | null>>
  ) => {
    setDraft({
      title: item.title,
      content: item.content,
      url: item.url || ""
    })
    setEditing(item.id)
  }

  const saveDraft = async (
    list: ResourceListKey,
    draft: DraftItem,
    editingId: string | null,
    setDraft: React.Dispatch<React.SetStateAction<DraftItem>>,
    setEditing: React.Dispatch<React.SetStateAction<string | null>>,
    setError: React.Dispatch<React.SetStateAction<string | null>>
  ) => {
    setError(null)
    let resolvedTitle = draft.title.trim()
    let resolvedContent = draft.content.trim()
    let resolvedUrl = draft.url.trim()

    setIsUrlFetchInProgress(list)
    try {
      if (resolvedUrl && !resolvedContent) {
        const fetched = await window.electronAPI.fetchUrlContent(resolvedUrl)
        if (!fetched.success || !fetched.content?.trim()) {
          setError(fetched.error || "Could not fetch content from source URL.")
          return
        }
        resolvedContent = fetched.content.trim()
        if (!resolvedTitle) {
          resolvedTitle = (fetched.title || deriveTitleFromUrl(fetched.url || resolvedUrl)).trim()
        }
        if (fetched.url) {
          resolvedUrl = fetched.url
        }
      }

      if (!resolvedTitle && resolvedUrl) {
        resolvedTitle = deriveTitleFromUrl(resolvedUrl)
      }

      if (!resolvedTitle || !resolvedContent) {
        setError("Title and content are required. Leave content empty to auto-fetch from source URL.")
        return
      }

      await updateResources(prev => {
        if (editingId) {
          return {
            ...prev,
            [list]: prev[list].map(item =>
              item.id === editingId
                ? {
                    ...item,
                    title: resolvedTitle,
                    content: resolvedContent,
                    url: resolvedUrl || undefined,
                    folderId:
                      list === "knowledge"
                        ? activeKnowledgeFolder?.id || DEFAULT_KNOWLEDGE_FOLDER_ID
                        : item.folderId,
                    updatedAt: Date.now()
                  }
                : item
            )
          }
        }

        const newItem = createResourceItem({
          title: resolvedTitle,
          content: resolvedContent,
          url: resolvedUrl || undefined,
          folderId:
            list === "knowledge"
              ? activeKnowledgeFolder?.id || DEFAULT_KNOWLEDGE_FOLDER_ID
              : undefined
        })
        return { ...prev, [list]: [newItem, ...prev[list]] }
      })

      setDraft(emptyDraft)
      setEditing(null)
    } finally {
      setIsUrlFetchInProgress(null)
    }
  }

  const fetchContentIntoDraft = async (
    list: ResourceListKey,
    draft: DraftItem,
    setDraft: React.Dispatch<React.SetStateAction<DraftItem>>,
    setError: React.Dispatch<React.SetStateAction<string | null>>
  ) => {
    setError(null)
    const rawUrl = draft.url.trim()
    if (!rawUrl) {
      setError("Enter a source URL first.")
      return
    }

    setIsUrlFetchInProgress(list)
    try {
      const fetched = await window.electronAPI.fetchUrlContent(rawUrl)
      if (!fetched.success || !fetched.content?.trim()) {
        setError(fetched.error || "Could not fetch content from source URL.")
        return
      }

      const fetchedTitle = (fetched.title || deriveTitleFromUrl(fetched.url || rawUrl)).trim()
      setDraft(prev => ({
        ...prev,
        title: prev.title.trim() || fetchedTitle,
        content: fetched.content || prev.content,
        url: fetched.url || rawUrl
      }))
    } finally {
      setIsUrlFetchInProgress(null)
    }
  }

  const deleteItem = async (list: ResourceListKey, id: string) => {
    await updateResources(prev => ({
      ...prev,
      [list]: prev[list].filter(item => item.id !== id)
    }))
  }

  const openMoveResource = (item: ResourceItem) => {
    const currentFolderId = item.folderId || DEFAULT_KNOWLEDGE_FOLDER_ID
    const defaultTargetFolderId =
      resources.knowledgeFolders.find(folder => folder.id !== currentFolderId)?.id || ""
    setMovingResourceId(item.id)
    setMoveTargetFolderId(defaultTargetFolderId)
    setMoveResourceError(null)
  }

  const cancelMoveResource = () => {
    setMovingResourceId(null)
    setMoveTargetFolderId("")
    setMoveResourceError(null)
    setIsMovingResource(false)
  }

  const moveKnowledgeResource = async (item: ResourceItem) => {
    const currentFolderId = item.folderId || DEFAULT_KNOWLEDGE_FOLDER_ID
    const targetFolderId = moveTargetFolderId.trim()

    if (!targetFolderId) {
      setMoveResourceError("Select a target folder.")
      return
    }

    if (targetFolderId === currentFolderId) {
      setMoveResourceError("Choose a different folder.")
      return
    }

    setMoveResourceError(null)
    setIsMovingResource(true)
    try {
      await updateResources(prev => ({
        ...prev,
        knowledge: prev.knowledge.map(resourceItem =>
          resourceItem.id === item.id
            ? {
                ...resourceItem,
                folderId: targetFolderId,
                updatedAt: Date.now()
              }
            : resourceItem
        )
      }))
      cancelMoveResource()
    } catch (error: any) {
      setMoveResourceError(error?.message || "Failed to move file.")
      setIsMovingResource(false)
    }
  }

  const addKnowledgeFolder = async () => {
    const name = newKnowledgeFolderName.trim()
    if (!name) {
      setCreateFolderError("Folder name is required.")
      return
    }

    const duplicate = resources.knowledgeFolders.some(
      folder => folder.name.toLowerCase() === name.toLowerCase()
    )
    if (duplicate) {
      setCreateFolderError("A folder with this name already exists.")
      return
    }

    setCreateFolderError(null)
    const folder = createKnowledgeFolder({
      name,
      type: newKnowledgeFolderType
    })

    await updateResources(
      prev => ({
        ...prev,
        knowledgeFolders: [folder, ...prev.knowledgeFolders]
      }),
      false
    )

    setActiveKnowledgeFolderId(folder.id)
    setNewKnowledgeFolderName("")
    setNewKnowledgeFolderType("other")
    setIsCreateFolderModalOpen(false)
  }

  const importFilesToKnowledgeFolder = async (files: FileList | null) => {
    const selected = Array.from(files || [])
    if (selected.length === 0) return
    if (!activeKnowledgeFolder) {
      setUrlImportError("Select a folder first.")
      return
    }

    setUrlImportError(null)
    setIsUrlImporting(true)
    setUrlImportStatus(`Importing ${selected.length} file(s) to ${activeKnowledgeFolder.name}...`)

    const importedItems: ResourceItem[] = []
    const failedDetails: string[] = []

    for (let index = 0; index < selected.length; index += 1) {
      const file = selected[index]
      setUrlImportStatus(
        `Processing ${index + 1}/${selected.length}: ${file.name}`
      )
      try {
        const extracted = await extractTextFromUpload(file)
        if (!extracted.success || !extracted.content?.trim()) {
          failedDetails.push(
            `${file.name}${extracted.error ? ` (${extracted.error})` : ""}`
          )
          continue
        }

        const title = file.name.replace(/\.[^.]+$/, "").trim() || file.name
        importedItems.push(
          createResourceItem({
            title,
            content: extracted.content.trim(),
            folderId: activeKnowledgeFolder.id
          })
        )
      } catch (error: any) {
        const message =
          typeof error?.message === "string" && error.message.trim().length > 0
            ? error.message.trim()
            : "import failed"
        failedDetails.push(`${file.name} (${message})`)
      }
    }

    if (importedItems.length === 0) {
      setIsUrlImporting(false)
      setUrlImportStatus("")
      setUrlImportError(
        failedDetails.length > 0
          ? `Could not import selected files: ${failedDetails.slice(0, 2).join(" | ")}${
              failedDetails.length > 2 ? " ..." : ""
            }`
          : "No files imported."
      )
      return
    }

    const next = {
      ...resources,
      knowledge: [...importedItems, ...resources.knowledge]
    }
    persistResources(next)
    await runVectorSync(next)

    setIsUrlImporting(false)
    setUrlImportStatus(
      `Imported ${importedItems.length}/${selected.length} file(s) to ${activeKnowledgeFolder.name}.`
    )
    if (failedDetails.length > 0) {
      setUrlImportError(
        `Some files failed: ${failedDetails.slice(0, 2).join(" | ")}${
          failedDetails.length > 2 ? " ..." : ""
        }`
      )
    }
  }

  const folderCounts = useMemo(
    () => ({
      resume: resources.resume.trim().length > 0 ? 1 : 0,
      jd: resources.documents.length,
      resources: resources.knowledge.length
    }),
    [resources]
  )

  const activeKnowledgeFolder = useMemo(
    () =>
      getKnowledgeFolderById(resources, activeKnowledgeFolderId) ||
      resources.knowledgeFolders[0] ||
      null,
    [resources, activeKnowledgeFolderId]
  )

  const visibleKnowledgeItems = useMemo(() => {
    const folderId = activeKnowledgeFolder?.id || DEFAULT_KNOWLEDGE_FOLDER_ID
    return resources.knowledge.filter(
      item => (item.folderId || DEFAULT_KNOWLEDGE_FOLDER_ID) === folderId
    )
  }, [resources.knowledge, activeKnowledgeFolder?.id])

  const knowledgeFolderItemCount = useMemo(() => {
    const counts = new Map<string, number>()
    resources.knowledgeFolders.forEach(folder => counts.set(folder.id, 0))
    resources.knowledge.forEach(item => {
      const folderId = item.folderId || DEFAULT_KNOWLEDGE_FOLDER_ID
      counts.set(folderId, (counts.get(folderId) || 0) + 1)
    })
    return counts
  }, [resources.knowledge, resources.knowledgeFolders])

  useEffect(() => {
    if (!currentUser) return
    const local = loadResources(currentUser.id)
    setResources(local)
  }, [currentUser?.id])

  useEffect(() => {
    if (
      resources.knowledgeFolders.length > 0 &&
      resources.knowledgeFolders.every(folder => folder.id !== activeKnowledgeFolderId)
    ) {
      setActiveKnowledgeFolderId(resources.knowledgeFolders[0].id)
    }
  }, [resources.knowledgeFolders, activeKnowledgeFolderId])

  useEffect(() => {
    setEditingResourceId(null)
    setResourceDraft(emptyDraft)
    setResourceError(null)
    cancelMoveResource()
  }, [activeKnowledgeFolderId])

  const importUrlsFromList = async (targetOverride?: ResourceListKey) => {
    setUrlImportError(null)
    const parsed = parseUrlImportEntries(urlImportInput)
    if (parsed.length === 0) {
      setUrlImportError("Add at least one valid http/https URL.")
      return
    }

    const targetList = targetOverride || "knowledge"

    const MAX_URLS_PER_IMPORT = 35
    const entries = parsed.slice(0, MAX_URLS_PER_IMPORT)
    setIsUrlImporting(true)
    setUrlImportStatus(`Starting import for ${entries.length} URL(s)...`)

    const importedItems: ResourceItem[] = []
    const targetItems = [...resources[targetList]]
    const existingUrlIndex = new Map<string, number>()
    const seenImportedUrls = new Set<string>()
    targetItems.forEach((item, index) => {
      const normalized = (item.url || "").trim().toLowerCase()
      if (normalized) {
        existingUrlIndex.set(normalized, index)
      }
    })
    let refreshedCount = 0
    let failedCount = 0
    const failedDetails: string[] = []

    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]
      setUrlImportStatus(`Fetching ${index + 1}/${entries.length}: ${entry.url}`)

      try {
        const result = await window.electronAPI.fetchUrlContent(entry.url)
        if (!result.success || !result.content) {
          failedCount += 1
          failedDetails.push(`${entry.url}${result.error ? ` (${result.error})` : ""}`)
          continue
        }

        const baseTitle = (result.title || deriveTitleFromUrl(entry.url)).trim()
        const title =
          entry.section && entry.section !== "General"
            ? `${entry.section} - ${baseTitle}`
            : baseTitle

        const normalizedImportedUrl = (result.url || entry.url).trim().toLowerCase()
        if (normalizedImportedUrl && existingUrlIndex.has(normalizedImportedUrl)) {
          const existingIndex = existingUrlIndex.get(normalizedImportedUrl)
          if (existingIndex !== undefined) {
            const existing = targetItems[existingIndex]
            targetItems[existingIndex] = {
              ...existing,
              title,
              content: result.content,
              url: result.url || entry.url,
              folderId:
                targetList === "knowledge"
                  ? activeKnowledgeFolder?.id || DEFAULT_KNOWLEDGE_FOLDER_ID
                  : existing.folderId,
              updatedAt: Date.now()
            }
            refreshedCount += 1
            continue
          }
        }

        if (normalizedImportedUrl && seenImportedUrls.has(normalizedImportedUrl)) {
          continue
        }

        const created = createResourceItem({
          title,
          content: result.content,
          url: result.url || entry.url,
          folderId:
            targetList === "knowledge"
              ? activeKnowledgeFolder?.id || DEFAULT_KNOWLEDGE_FOLDER_ID
              : undefined
        })
        importedItems.push(created)
        if (normalizedImportedUrl) {
          seenImportedUrls.add(normalizedImportedUrl)
        }
      } catch (error: any) {
        failedCount += 1
        const message =
          typeof error?.message === "string" && error.message.trim().length > 0
            ? error.message.trim()
            : "request failed"
        failedDetails.push(`${entry.url} (${message})`)
      }
    }

    if (importedItems.length === 0 && refreshedCount === 0) {
      setIsUrlImporting(false)
      setUrlImportStatus("")
      const preview = failedDetails.slice(0, 3).join(" | ")
      setUrlImportError(
        `Import failed for all URLs. ${preview || "Check links and try again."}${
          failedDetails.length > 3 ? " ..." : ""
        }`
      )
      return
    }

    const next = {
      ...resources,
      [targetList]: [...importedItems, ...targetItems]
    }
    persistResources(next)
    await runVectorSync(next)

    setIsUrlImporting(false)
    setUrlImportInput("")
    setUrlImportStatus(
      `Imported ${importedItems.length}/${entries.length} URL(s)${
        refreshedCount > 0 ? `, refreshed ${refreshedCount}` : ""
      }${
        failedCount > 0 ? `, ${failedCount} failed` : ""
      }.`
    )
    if (failedCount > 0) {
      const preview = failedDetails.slice(0, 3).join(" | ")
      setUrlImportError(
        `Some URLs failed to import. Retry those links. ${preview}${failedDetails.length > 3 ? " ..." : ""}`
      )
    }
  }

  if (!currentUser) {
    return (
      <div className="min-h-[460px] w-full flex items-center justify-center p-3">
        <div className="w-full max-w-[760px] rounded-2xl border border-slate-200 bg-white p-6 text-center text-xs text-slate-700">
          Sign in first to use Workspace.
        </div>
      </div>
    )
  }

  const renderList = (
    title: string,
    list: ResourceListKey,
    draft: DraftItem,
    setDraft: React.Dispatch<React.SetStateAction<DraftItem>>,
    editingId: string | null,
    setEditing: React.Dispatch<React.SetStateAction<string | null>>,
    error: string | null,
    setError: React.Dispatch<React.SetStateAction<string | null>>,
    itemsOverride?: ResourceItem[]
  ) => {
    const listItems = itemsOverride || resources[list]
    const isFetching = isUrlFetchInProgress === list

    return (
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-xs font-semibold text-slate-900">{title}</h2>
            <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
              {listItems.length} item{listItems.length === 1 ? "" : "s"}
            </span>
          </div>

          {listItems.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-6 text-xs text-slate-600">
              No files yet. Add a file on the right to build this folder.
            </div>
          ) : (
            <div className="max-h-[470px] space-y-3 overflow-y-auto pr-1">
              {listItems.map(item => (
                <article key={item.id} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                  {(() => {
                    const itemFolderId = item.folderId || DEFAULT_KNOWLEDGE_FOLDER_ID
                    const moveOptions = resources.knowledgeFolders.filter(
                      folder => folder.id !== itemFolderId
                    )
                    const showMoveControls = list === "knowledge" && movingResourceId === item.id
                    return (
                      <>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <h3 className="truncate text-xs font-semibold text-slate-900">{item.title}</h3>
                      {list === "knowledge" && item.folderId && (
                        <div className="mt-1 text-xs text-emerald-700">
                          {getKnowledgeFolderById(resources, item.folderId)?.name || "General Resources"}
                        </div>
                      )}
                      <p className="mt-2 line-clamp-4 text-xs leading-5 text-slate-700">{item.content}</p>
                      {item.url && (
                        <div className="mt-2 flex items-center gap-1.5 truncate text-xs text-blue-700">
                          <Link2 className="h-3.5 w-3.5 shrink-0" />
                          <span className="truncate">{item.url}</span>
                        </div>
                      )}
                    </div>
                    <div className="flex shrink-0 flex-col gap-2">
                      {list === "knowledge" && moveOptions.length > 0 && !showMoveControls && (
                        <button
                          className="rounded-md bg-amber-500 px-3 py-1.5 text-xs font-medium text-white"
                          onClick={() => openMoveResource(item)}
                          type="button"
                        >
                          Move
                        </button>
                      )}
                      <button
                        className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white"
                        onClick={() => startEdit(item, setDraft, setEditing)}
                        type="button"
                      >
                        Edit
                      </button>
                      <button
                        className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white"
                        onClick={() => deleteItem(list, item.id)}
                        type="button"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                  {showMoveControls && (
                    <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-2">
                      <div className="grid grid-cols-1 gap-2 md:grid-cols-[minmax(0,1fr)_auto]">
                        <select
                          value={moveTargetFolderId}
                          onChange={event => setMoveTargetFolderId(event.target.value)}
                          className="w-full rounded-lg border border-amber-300 bg-white px-2 py-1.5 text-xs text-slate-800"
                        >
                          <option value="" disabled>
                            Select target folder
                          </option>
                          {moveOptions.map(folder => (
                            <option key={folder.id} value={folder.id}>
                              {folder.name}
                            </option>
                          ))}
                        </select>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            className="rounded-md bg-amber-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-60"
                            onClick={() => {
                              void moveKnowledgeResource(item)
                            }}
                            disabled={isMovingResource || !moveTargetFolderId}
                          >
                            {isMovingResource ? "Moving..." : "Move + Sync"}
                          </button>
                          <button
                            type="button"
                            className="rounded-md border border-amber-300 bg-white px-3 py-1.5 text-xs text-slate-700"
                            onClick={cancelMoveResource}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                      {moveResourceError && (
                        <div className="mt-2 text-xs text-red-700">{moveResourceError}</div>
                      )}
                    </div>
                  )}
                      </>
                    )
                  })()}
                </article>
              ))}
            </div>
          )}
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="mb-1 text-xs font-semibold text-slate-900">
            {editingId ? "Edit File" : "Add New File"}
          </h2>
          <p className="mb-4 text-xs text-slate-600">
            Upload a file, paste text, or use a source URL.
          </p>

          <div className="space-y-3">
            <input
              type="text"
              value={draft.title}
              onChange={event => setDraft(prev => ({ ...prev, title: event.target.value }))}
              placeholder="File name"
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900"
            />
            <textarea
              value={draft.content}
              onChange={event => setDraft(prev => ({ ...prev, content: event.target.value }))}
              placeholder="Paste interview JD or resource content here"
              className="min-h-[220px] w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900"
            />
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
              <input
                type="text"
                value={draft.url}
                onChange={event => setDraft(prev => ({ ...prev, url: event.target.value }))}
                placeholder="Optional source URL"
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900"
              />
              <button
                type="button"
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 disabled:opacity-60"
                onClick={() => fetchContentIntoDraft(list, draft, setDraft, setError)}
                disabled={isFetching}
              >
                {isFetching ? "Fetching..." : "Fetch from URL"}
              </button>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="cursor-pointer rounded-lg bg-slate-900 px-3 py-2 text-xs font-medium text-white">
                Upload file
                <input
                  type="file"
                  accept=".txt,.md,.json,.csv,.docx,.pdf,image/*"
                  className="hidden"
                  onChange={event =>
                    handleDraftFile(event.target.files?.[0] || null, setDraft, setError)
                  }
                />
              </label>
              <div className="flex flex-wrap items-center gap-2">
                {editingId && (
                  <button
                    type="button"
                    className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-slate-700"
                    onClick={() => {
                      setDraft(emptyDraft)
                      setEditing(null)
                      setError(null)
                    }}
                  >
                    Cancel
                  </button>
                )}
                <button
                  type="button"
                  className="rounded-lg bg-emerald-600 px-4 py-2 text-xs font-medium text-white disabled:opacity-60"
                  onClick={() => saveDraft(list, draft, editingId, setDraft, setEditing, setError)}
                  disabled={isFetching}
                >
                  {isFetching ? "Saving..." : editingId ? "Update + Sync" : "Add + Sync"}
                </button>
              </div>
            </div>
            <p className="text-xs text-slate-500">
              Tip: If you only have a URL, keep content empty and click "Fetch from URL".
            </p>
            {error && <div className="text-xs text-red-700">{error}</div>}
          </div>
        </section>
      </div>
    )
  }

  return (
    <div className="min-h-[680px] w-full bg-white p-0">
      <div className="mx-auto w-full max-w-[1460px] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_20px_55px_rgba(15,23,42,0.2)]">
        <div className="auth-drag-handle mx-5 mt-4 rounded-xl border border-slate-300/80 bg-slate-100/90 py-1.5">
          <span className="pointer-events-none select-none text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
            Drag top bar to move window
          </span>
        </div>

        <header className="border-b border-slate-200 px-5 py-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={onBackToDashboard}
                  className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50"
                >
                  <span className="inline-flex items-center gap-1.5">
                    <ArrowLeft className="h-3.5 w-3.5" />
                    Dashboard
                  </span>
                </button>
                <h1 className="text-sm font-semibold text-slate-900">Workspace</h1>
              </div>
              <p className="text-xs text-slate-600">
                Organize interview JD files and resource folders for faster AI answers.
              </p>
              <p className="mt-1 text-xs text-slate-500">{currentUser.email}</p>
            </div>

            <button
              type="button"
              onClick={() => runVectorSync(resources)}
              disabled={isSyncing}
              className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-60"
            >
              <span className="inline-flex items-center gap-2">
                <RefreshCw className={`h-3.5 w-3.5 ${isSyncing ? "animate-spin" : ""}`} />
                {isSyncing ? "Syncing..." : "Sync Vector DB"}
              </span>
            </button>
          </div>

          <div
            className={`mt-3 flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs ${
              vectorConfig.configured
                ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                : "border-amber-200 bg-amber-50 text-amber-800"
            }`}
          >
            <Database className="h-3.5 w-3.5" />
            <span>{syncMessage}</span>
          </div>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-[250px_minmax(0,1fr)]">
          <aside className="border-r border-slate-200 bg-slate-50 p-3">
            <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Folders
            </div>

            <div className="space-y-2">
              <button
                type="button"
                onClick={() => setActiveFolder("jd")}
                className={`flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-left text-xs font-medium ${
                  activeFolder === "jd"
                    ? "bg-blue-100 text-blue-800 ring-1 ring-blue-200"
                    : "bg-white text-slate-700 hover:bg-slate-100"
                }`}
              >
                <span className="inline-flex items-center gap-2">
                  <FolderKanban className="h-3.5 w-3.5" />
                  Interview JD
                </span>
                <span className="rounded-full bg-white px-2 py-0.5 text-xs text-slate-600">
                  {folderCounts.jd}
                </span>
              </button>

              <button
                type="button"
                onClick={() => setActiveFolder("resources")}
                className={`flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-left text-xs font-medium ${
                  activeFolder === "resources"
                    ? "bg-blue-100 text-blue-800 ring-1 ring-blue-200"
                    : "bg-white text-slate-700 hover:bg-slate-100"
                }`}
              >
                <span className="inline-flex items-center gap-2">
                  <FileText className="h-3.5 w-3.5" />
                  Resources
                </span>
                <span className="rounded-full bg-white px-2 py-0.5 text-xs text-slate-600">
                  {folderCounts.resources}
                </span>
              </button>

              <button
                type="button"
                onClick={() => setActiveFolder("resume")}
                className={`flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-left text-xs font-medium ${
                  activeFolder === "resume"
                    ? "bg-blue-100 text-blue-800 ring-1 ring-blue-200"
                    : "bg-white text-slate-700 hover:bg-slate-100"
                }`}
              >
                <span className="inline-flex items-center gap-2">
                  <UserSquare2 className="h-3.5 w-3.5" />
                  Resume
                </span>
                <span className="rounded-full bg-white px-2 py-0.5 text-xs text-slate-600">
                  {folderCounts.resume}
                </span>
              </button>
            </div>

            <div className="mt-5 rounded-xl border border-emerald-200 bg-emerald-50 p-3">
              <div className="text-xs font-semibold text-emerald-800">Best Practices (Faster AI)</div>
              <ol className="mt-2 list-decimal space-y-1 pl-4 text-xs leading-5 text-emerald-900">
                <li>Keep one JD/topic per file with a clear title.</li>
                <li>Put must-have skills in the first section.</li>
                <li>Remove boilerplate and repeated text blocks.</li>
                <li>Split very large docs into focused files.</li>
                <li>Click Sync Vector DB after any change.</li>
              </ol>
            </div>
          </aside>

          <main className="bg-slate-50/40 p-4">
            {activeFolder === "resume" ? (
              <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                <h2 className="mb-1 text-xs font-semibold text-slate-900">Resume</h2>
                <p className="mb-3 text-xs text-slate-600">
                  Used for personalization and response style during interview support.
                </p>

                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <label className="cursor-pointer rounded-lg bg-slate-900 px-3 py-2 text-xs font-medium text-white">
                    Upload file
                    <input
                      type="file"
                      accept=".txt,.md,.json,.docx"
                      className="hidden"
                      onChange={event => handleResumeFile(event.target.files?.[0] || null)}
                    />
                  </label>
                  <button
                    type="button"
                    className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-slate-700"
                    onClick={async () => {
                      const next = { ...resources, resume: "" }
                      persistResources(next)
                      await runVectorSync(next)
                    }}
                  >
                    Clear + Sync
                  </button>
                </div>

                <textarea
                  value={resources.resume}
                  onChange={event => setResources(prev => ({ ...prev, resume: event.target.value }))}
                  onBlur={async () => {
                    persistResources(resources)
                    await runVectorSync(resources)
                  }}
                  placeholder="Paste your resume text here..."
                  className="min-h-[420px] w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900"
                />
              </section>
            ) : activeFolder === "jd" ? (
              renderList(
                "Interview JD",
                "documents",
                jdDraft,
                setJdDraft,
                editingJdId,
                setEditingJdId,
                jdError,
                setJdError
              )
            ) : (
              <div className="space-y-4">
                <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                  <div className="mb-3 flex items-center justify-between gap-2">
                    <div>
                      <h2 className="text-xs font-semibold text-slate-900">Resource Folders</h2>
                      <div className="text-xs text-slate-600">
                        Finder-style view. Click a folder tile to open it.
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setCreateFolderError(null)
                        setIsCreateFolderModalOpen(true)
                      }}
                      className="rounded-lg bg-slate-900 px-3 py-2 text-xs font-medium text-white"
                    >
                      New Folder
                    </button>
                  </div>

                  <div className="mb-4 rounded-xl border border-slate-700 bg-[#1f2024] p-3">
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
                      {resources.knowledgeFolders.map(folder => {
                        const isActive = folder.id === activeKnowledgeFolderId
                        return (
                          <button
                            key={folder.id}
                            type="button"
                            onClick={() => setActiveKnowledgeFolderId(folder.id)}
                            className={`rounded-lg p-2 text-center transition-colors ${
                              isActive ? "bg-slate-700/60 ring-1 ring-sky-400/70" : "hover:bg-slate-700/40"
                            }`}
                          >
                            <Folder className="mx-auto h-10 w-10 text-sky-400" />
                            <div className="mt-1 line-clamp-2 text-xs font-medium text-slate-100">
                              {folder.name}
                            </div>
                            <div className="text-xs text-slate-400">
                              {knowledgeFolderItemCount.get(folder.id) || 0} files
                            </div>
                          </button>
                        )
                      })}
                    </div>
                  </div>

                  <div className="mb-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                    <span className="font-medium text-slate-700">
                      Open folder: {activeKnowledgeFolder?.name || "General Resources"}
                    </span>{" "}
                    ({RESOURCE_FOLDER_TYPE_LABELS[activeKnowledgeFolder?.type || "other"]}). Folder type helps AI retrieve better context.
                  </div>
                </section>

                <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                  <h3 className="mb-1 text-xs font-semibold text-slate-900">
                    Import Into: {activeKnowledgeFolder?.name || "General Resources"}
                  </h3>
                  <p className="mb-3 text-xs text-slate-600">
                    Bulk URL import and file uploads below are saved in the currently open folder.
                  </p>
                  <textarea
                    value={urlImportInput}
                    onChange={event => setUrlImportInput(event.target.value)}
                    placeholder={`APEX\nhttps://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/\n\nLWC\nhttps://developer.salesforce.com/docs/component-library/documentation/en/lwc`}
                    className="min-h-[120px] w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900"
                  />
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => importUrlsFromList("knowledge")}
                      disabled={isUrlImporting}
                      className="rounded-lg bg-indigo-600 px-4 py-2 text-xs font-medium text-white disabled:opacity-60"
                    >
                      {isUrlImporting ? "Importing..." : "Import URLs + Sync"}
                    </button>
                    <label className="cursor-pointer rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700">
                      Upload Docs/PDF/Images
                      <input
                        type="file"
                        accept=".txt,.md,.json,.csv,.docx,.pdf,image/*"
                        multiple
                        className="hidden"
                        onChange={event => {
                          const fileList = event.target.files
                          void importFilesToKnowledgeFolder(fileList)
                          event.currentTarget.value = ""
                        }}
                      />
                    </label>
                    <span className="text-xs text-slate-500">
                      Supported: txt, md, json, csv, docx, pdf, images
                    </span>
                  </div>
                  {urlImportStatus && <div className="mt-2 text-xs text-slate-700">{urlImportStatus}</div>}
                  {urlImportError && <div className="mt-1 text-xs text-red-700">{urlImportError}</div>}
                </section>

                {renderList(
                  activeKnowledgeFolder?.name || "Other Resources",
                  "knowledge",
                  resourceDraft,
                  setResourceDraft,
                  editingResourceId,
                  setEditingResourceId,
                  resourceError,
                  setResourceError,
                  visibleKnowledgeItems
                )}
              </div>
            )}
          </main>
        </div>
      </div>

      {isCreateFolderModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 p-4">
          <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-4 shadow-xl">
            <h3 className="text-xs font-semibold text-slate-900">Create Folder</h3>
            <p className="mt-1 text-xs text-slate-600">
              Add a folder to organize URLs, docs, PDFs, and images.
            </p>

            <div className="mt-4 space-y-3">
              <input
                type="text"
                value={newKnowledgeFolderName}
                onChange={event => setNewKnowledgeFolderName(event.target.value)}
                placeholder="Folder name (e.g. Salesforce Resources)"
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-slate-800"
                autoFocus
              />
              <select
                value={newKnowledgeFolderType}
                onChange={event => setNewKnowledgeFolderType(event.target.value as ResourceFolderType)}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-slate-700"
              >
                {RESOURCE_FOLDER_TYPE_OPTIONS.map(type => (
                  <option key={type} value={type}>
                    {RESOURCE_FOLDER_TYPE_LABELS[type]}
                  </option>
                ))}
              </select>
              {createFolderError && (
                <div className="text-xs text-red-700">{createFolderError}</div>
              )}
            </div>

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-slate-700"
                onClick={() => {
                  setIsCreateFolderModalOpen(false)
                  setCreateFolderError(null)
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-medium text-white"
                onClick={() => {
                  void addKnowledgeFolder()
                }}
              >
                Create Folder
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default Workspace
