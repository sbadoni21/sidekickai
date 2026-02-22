import React, { useEffect, useMemo, useState } from "react"
import {
  createResourceItem,
  DEFAULT_KNOWLEDGE_FOLDER_ID,
  DEFAULT_KNOWLEDGE_FOLDER_NAME,
  loadResources,
  ResourceItem,
  saveResources,
  UserResources
} from "../lib/resourcesStore"
import { getCurrentUser } from "../lib/authStore"
import { X } from "lucide-react"

interface ResourcesProps {
  onClose: () => void
}

interface DraftItem {
  title: string
  content: string
  url: string
}

const emptyDraft: DraftItem = {
  title: "",
  content: "",
  url: ""
}

const Resources: React.FC<ResourcesProps> = ({ onClose }) => {
  const currentUser = getCurrentUser()
  const [resources, setResources] = useState<UserResources>(() => {
    if (!currentUser) {
      return {
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
    }
    return loadResources(currentUser.id)
  })

  const [docDraft, setDocDraft] = useState<DraftItem>(emptyDraft)
  const [knowledgeDraft, setKnowledgeDraft] = useState<DraftItem>(emptyDraft)
  const [editingDocId, setEditingDocId] = useState<string | null>(null)
  const [editingKnowledgeId, setEditingKnowledgeId] = useState<string | null>(null)
  const [docError, setDocError] = useState<string | null>(null)
  const [knowledgeError, setKnowledgeError] = useState<string | null>(null)

  useEffect(() => {
    if (!currentUser) return
    saveResources(currentUser.id, resources)
  }, [currentUser, resources])

  const resumeCount = useMemo(() => resources.resume.length, [resources.resume])

  const updateResources = (updater: (prev: UserResources) => UserResources) => {
    setResources(prev => updater(prev))
  }

  const handleResumeFile = (file: File | null) => {
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const text = (reader.result as string) || ""
      updateResources(prev => ({ ...prev, resume: text }))
    }
    reader.readAsText(file)
  }

  const handleDraftFile = (
    file: File | null,
    setDraft: React.Dispatch<React.SetStateAction<DraftItem>>
  ) => {
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const text = (reader.result as string) || ""
      setDraft(prev => ({
        ...prev,
        title: prev.title || file.name,
        content: text
      }))
    }
    reader.readAsText(file)
  }

  const saveDocument = () => {
    setDocError(null)
    if (!docDraft.title.trim() || !docDraft.content.trim()) {
      setDocError("Title and content are required.")
      return
    }

    updateResources(prev => {
      if (editingDocId) {
        return {
          ...prev,
          documents: prev.documents.map(item =>
            item.id === editingDocId
              ? {
                  ...item,
                  title: docDraft.title.trim(),
                  content: docDraft.content.trim(),
                  url: docDraft.url.trim() || undefined,
                  updatedAt: Date.now()
                }
              : item
          )
        }
      }

      const newItem = createResourceItem({
        title: docDraft.title,
        content: docDraft.content,
        url: docDraft.url
      })
      return { ...prev, documents: [newItem, ...prev.documents] }
    })

    setDocDraft(emptyDraft)
    setEditingDocId(null)
  }

  const saveKnowledge = () => {
    setKnowledgeError(null)
    if (!knowledgeDraft.title.trim() || !knowledgeDraft.content.trim()) {
      setKnowledgeError("Title and content are required.")
      return
    }

    updateResources(prev => {
      if (editingKnowledgeId) {
        return {
          ...prev,
          knowledge: prev.knowledge.map(item =>
            item.id === editingKnowledgeId
              ? {
                  ...item,
                  title: knowledgeDraft.title.trim(),
                  content: knowledgeDraft.content.trim(),
                  url: knowledgeDraft.url.trim() || undefined,
                  folderId: item.folderId || DEFAULT_KNOWLEDGE_FOLDER_ID,
                  updatedAt: Date.now()
                }
              : item
          )
        }
      }

      const newItem = createResourceItem({
        title: knowledgeDraft.title,
        content: knowledgeDraft.content,
        url: knowledgeDraft.url,
        folderId: DEFAULT_KNOWLEDGE_FOLDER_ID
      })
      return { ...prev, knowledge: [newItem, ...prev.knowledge] }
    })

    setKnowledgeDraft(emptyDraft)
    setEditingKnowledgeId(null)
  }

  const startEdit = (
    item: ResourceItem,
    setDraft: React.Dispatch<React.SetStateAction<DraftItem>>,
    setEditingId: React.Dispatch<React.SetStateAction<string | null>>
  ) => {
    setDraft({
      title: item.title,
      content: item.content,
      url: item.url || ""
    })
    setEditingId(item.id)
  }

  const deleteItem = (id: string, list: "documents" | "knowledge") => {
    updateResources(prev => ({
      ...prev,
      [list]: prev[list].filter(item => item.id !== id)
    }))
  }

  if (!currentUser) {
    return (
      <div className="w-[600px] liquid-glass chat-container p-6 text-center">
        <div className="text-sm text-gray-800">Please sign in to manage resources.</div>
      </div>
    )
  }

  return (
    <div className="w-[920px] liquid-glass chat-container p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-sm font-semibold text-gray-900">Resources Library</h2>
          <p className="text-[10px] text-gray-600">
            These resources power the interview answers during meetings.
          </p>
        </div>
        <button
          onClick={onClose}
          className="p-1 rounded hover:bg-white/40 transition"
          title="Close"
        >
          <X className="w-4 h-4 text-gray-600" />
        </button>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="col-span-2">
          <div className="p-3 rounded-xl bg-white/60 border border-white/70">
            <div className="flex items-center justify-between mb-2">
              <div>
                <div className="text-xs font-semibold text-gray-800">Resume</div>
                <div className="text-[10px] text-gray-500">Paste your resume or import a text file.</div>
              </div>
              <div className="flex items-center gap-2">
                <label className="text-[10px] px-2 py-1 rounded-md bg-gray-900/80 text-white cursor-pointer">
                  Import
                  <input
                    type="file"
                    accept=".txt,.md,.csv,.json"
                    className="hidden"
                    onChange={event => handleResumeFile(event.target.files?.[0] || null)}
                  />
                </label>
                <button
                  type="button"
                  onClick={() => updateResources(prev => ({ ...prev, resume: "" }))}
                  className="text-[10px] px-2 py-1 rounded-md bg-white/70 text-gray-700 hover:bg-white"
                >
                  Clear
                </button>
              </div>
            </div>
            <textarea
              value={resources.resume}
              onChange={event => updateResources(prev => ({ ...prev, resume: event.target.value }))}
              placeholder="Paste resume text here..."
              className="w-full min-h-[120px] rounded-lg px-3 py-2 text-[10px] bg-white/80 border border-white/70 focus:outline-none focus:ring-2 focus:ring-blue-400/50"
            />
            <div className="mt-1 text-[9px] text-gray-500">{resumeCount} characters</div>
          </div>
        </div>

        <div className="p-3 rounded-xl bg-white/50 border border-white/70">
          <div className="text-xs font-semibold text-gray-800 mb-2">Documents</div>
          {resources.documents.length === 0 ? (
            <div className="text-[10px] text-gray-500 mb-2">No documents yet.</div>
          ) : (
            <div className="space-y-2 mb-2 max-h-48 overflow-y-auto">
              {resources.documents.map(item => (
                <div key={item.id} className="p-2 rounded-lg bg-white/80 border border-white/60">
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="text-[10px] font-semibold text-gray-800">{item.title}</div>
                      <div className="text-[9px] text-gray-500 line-clamp-2">
                        {item.content}
                      </div>
                    </div>
                    <div className="flex gap-1">
                      <button
                        className="text-[9px] px-2 py-1 rounded bg-blue-500/80 text-white"
                        onClick={() => startEdit(item, setDocDraft, setEditingDocId)}
                      >
                        Edit
                      </button>
                      <button
                        className="text-[9px] px-2 py-1 rounded bg-red-500/80 text-white"
                        onClick={() => deleteItem(item.id, "documents")}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                  {item.url && (
                    <div className="mt-1 text-[9px] text-blue-600 truncate">{item.url}</div>
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="space-y-2">
            <input
              type="text"
              value={docDraft.title}
              onChange={event => setDocDraft(prev => ({ ...prev, title: event.target.value }))}
              placeholder="Document title"
              className="w-full rounded-md px-2 py-1 text-[10px] bg-white/80 border border-white/70"
            />
            <textarea
              value={docDraft.content}
              onChange={event => setDocDraft(prev => ({ ...prev, content: event.target.value }))}
              placeholder="Summary or notes"
              className="w-full min-h-[80px] rounded-md px-2 py-1 text-[10px] bg-white/80 border border-white/70"
            />
            <input
              type="text"
              value={docDraft.url}
              onChange={event => setDocDraft(prev => ({ ...prev, url: event.target.value }))}
              placeholder="Source URL (optional)"
              className="w-full rounded-md px-2 py-1 text-[10px] bg-white/80 border border-white/70"
            />
            <div className="flex items-center justify-between">
              <label className="text-[9px] px-2 py-1 rounded-md bg-white/70 text-gray-700 cursor-pointer">
                Import file
                <input
                  type="file"
                  accept=".txt,.md,.csv,.json"
                  className="hidden"
                  onChange={event => handleDraftFile(event.target.files?.[0] || null, setDocDraft)}
                />
              </label>
              <div className="flex items-center gap-2">
                {editingDocId && (
                  <button
                    type="button"
                    className="text-[10px] px-3 py-1 rounded-md bg-white/70 text-gray-700"
                    onClick={() => {
                      setDocDraft(emptyDraft)
                      setEditingDocId(null)
                      setDocError(null)
                    }}
                  >
                    Cancel
                  </button>
                )}
                <button
                  type="button"
                  className="text-[10px] px-3 py-1 rounded-md bg-gray-900/80 text-white"
                  onClick={saveDocument}
                >
                  {editingDocId ? "Update" : "Add"}
                </button>
              </div>
            </div>
            {docError && (
              <div className="text-[9px] text-red-600">{docError}</div>
            )}
          </div>
        </div>

        <div className="p-3 rounded-xl bg-white/50 border border-white/70">
          <div className="text-xs font-semibold text-gray-800 mb-2">Knowledge Sources</div>
          {resources.knowledge.length === 0 ? (
            <div className="text-[10px] text-gray-500 mb-2">No knowledge sources yet.</div>
          ) : (
            <div className="space-y-2 mb-2 max-h-48 overflow-y-auto">
              {resources.knowledge.map(item => (
                <div key={item.id} className="p-2 rounded-lg bg-white/80 border border-white/60">
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="text-[10px] font-semibold text-gray-800">{item.title}</div>
                      <div className="text-[9px] text-gray-500 line-clamp-2">
                        {item.content}
                      </div>
                    </div>
                    <div className="flex gap-1">
                      <button
                        className="text-[9px] px-2 py-1 rounded bg-blue-500/80 text-white"
                        onClick={() => startEdit(item, setKnowledgeDraft, setEditingKnowledgeId)}
                      >
                        Edit
                      </button>
                      <button
                        className="text-[9px] px-2 py-1 rounded bg-red-500/80 text-white"
                        onClick={() => deleteItem(item.id, "knowledge")}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                  {item.url && (
                    <div className="mt-1 text-[9px] text-blue-600 truncate">{item.url}</div>
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="space-y-2">
            <input
              type="text"
              value={knowledgeDraft.title}
              onChange={event => setKnowledgeDraft(prev => ({ ...prev, title: event.target.value }))}
              placeholder="Source title"
              className="w-full rounded-md px-2 py-1 text-[10px] bg-white/80 border border-white/70"
            />
            <textarea
              value={knowledgeDraft.content}
              onChange={event => setKnowledgeDraft(prev => ({ ...prev, content: event.target.value }))}
              placeholder="Key points or notes"
              className="w-full min-h-[80px] rounded-md px-2 py-1 text-[10px] bg-white/80 border border-white/70"
            />
            <input
              type="text"
              value={knowledgeDraft.url}
              onChange={event => setKnowledgeDraft(prev => ({ ...prev, url: event.target.value }))}
              placeholder="Source URL (optional)"
              className="w-full rounded-md px-2 py-1 text-[10px] bg-white/80 border border-white/70"
            />
            <div className="flex items-center justify-between">
              <label className="text-[9px] px-2 py-1 rounded-md bg-white/70 text-gray-700 cursor-pointer">
                Import file
                <input
                  type="file"
                  accept=".txt,.md,.csv,.json"
                  className="hidden"
                  onChange={event => handleDraftFile(event.target.files?.[0] || null, setKnowledgeDraft)}
                />
              </label>
              <div className="flex items-center gap-2">
                {editingKnowledgeId && (
                  <button
                    type="button"
                    className="text-[10px] px-3 py-1 rounded-md bg-white/70 text-gray-700"
                    onClick={() => {
                      setKnowledgeDraft(emptyDraft)
                      setEditingKnowledgeId(null)
                      setKnowledgeError(null)
                    }}
                  >
                    Cancel
                  </button>
                )}
                <button
                  type="button"
                  className="text-[10px] px-3 py-1 rounded-md bg-gray-900/80 text-white"
                  onClick={saveKnowledge}
                >
                  {editingKnowledgeId ? "Update" : "Add"}
                </button>
              </div>
            </div>
            {knowledgeError && (
              <div className="text-[9px] text-red-600">{knowledgeError}</div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export default Resources
