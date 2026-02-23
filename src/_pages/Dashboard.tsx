import React, { useCallback, useEffect, useMemo, useState } from "react"
import { StoredUser } from "../lib/authStore"
import {
  computeMeetingStats,
  getMeetingsStorageMode,
  loadMeetingRecords,
  MeetingRecord
} from "../lib/meetingsStore"

interface DashboardProps {
  user: StoredUser
  refreshKey: number
  onOpenNewMeeting: () => void
  onOpenWorkspace: () => void
  onLogout: () => void
}

const formatDuration = (seconds: number): string => {
  const hrs = Math.floor(seconds / 3600)
  const mins = Math.floor((seconds % 3600) / 60)
  const secs = seconds % 60
  if (hrs > 0) return `${hrs}h ${mins}m`
  if (mins > 0) return `${mins}m ${secs}s`
  return `${secs}s`
}

const formatDateTime = (timestamp?: number): string => {
  if (!timestamp) return "Never"
  return new Date(timestamp).toLocaleString()
}

const formatClockTime = (timestamp?: number): string => {
  if (!timestamp) return "--"
  return new Date(timestamp).toLocaleTimeString()
}

const formatMeetingOffset = (meeting: MeetingRecord, timestamp?: number): string => {
  if (!timestamp) return "--"
  const offsetSeconds = Math.max(0, Math.floor((timestamp - meeting.startTime) / 1000))
  return formatDuration(offsetSeconds)
}

const getMeetingAverageAnswerQuality = (meeting: MeetingRecord): number => {
  const answers = meeting.analytics?.answers || []
  if (answers.length === 0) return 0
  const total = answers.reduce((sum, answer) => sum + (answer.quality?.overall || 0), 0)
  return Math.round((total / answers.length) * 100)
}

const Dashboard: React.FC<DashboardProps> = ({
  user,
  refreshKey,
  onOpenNewMeeting,
  onOpenWorkspace,
  onLogout
}) => {
  const [meetings, setMeetings] = useState<MeetingRecord[]>([])
  const [selectedMeetingId, setSelectedMeetingId] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const storageMode = getMeetingsStorageMode()

  const stats = useMemo(() => computeMeetingStats(meetings), [meetings])
  const selectedMeeting = useMemo(() => {
    if (meetings.length === 0) return null
    if (!selectedMeetingId) return meetings[0]
    return meetings.find(meeting => meeting.remoteMeetingId === selectedMeetingId) || meetings[0]
  }, [meetings, selectedMeetingId])

  const loadDashboard = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const loaded = await loadMeetingRecords(user.id)
      setMeetings(loaded)
      setSelectedMeetingId(prev =>
        loaded.some(meeting => meeting.remoteMeetingId === prev)
          ? prev
          : loaded[0]?.remoteMeetingId || null
      )
    } catch (loadError) {
      console.error(loadError)
      setError("Failed to load meeting history.")
    } finally {
      setIsLoading(false)
    }
  }, [user.id])

  useEffect(() => {
    loadDashboard()
  }, [loadDashboard, refreshKey])

  return (
    <div className="app-page-shell h-full w-full p-0">
      <div className="app-page-surface h-full w-full p-4 sm:p-6">
        <div className="app-drag-pill auth-drag-handle mb-4 rounded-xl py-1">
          <span className="pointer-events-none select-none text-[9px] font-semibold uppercase tracking-[0.18em] text-slate-500">
            Hold and drag to move
          </span>
        </div>

        <div className="app-anim-rise mb-5 flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Meeting Dashboard</h1>
            <p className="mt-1 text-sm text-slate-600">
              {user.name} • {user.email}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Storage: {storageMode === "supabase" ? "Supabase" : "Local fallback"}
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={onOpenNewMeeting}
              className="app-btn app-btn-primary px-3 py-2 text-xs font-semibold"
            >
              Open New Meeting
            </button>
            <button
              onClick={onOpenWorkspace}
              className="app-btn app-btn-secondary px-3 py-2 text-xs font-semibold"
            >
              Open Workspace
            </button>
            <button
              onClick={onLogout}
              className="app-btn app-btn-danger px-3 py-2 text-xs font-semibold"
            >
              Logout
            </button>
          </div>
        </div>

        <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-6">
          <div className="app-surface-card app-anim-rise rounded-xl p-3">
            <div className="text-[10px] uppercase tracking-wide text-slate-500">Meetings</div>
            <div className="text-lg font-bold text-slate-900 mt-1">{stats.totalMeetings}</div>
          </div>
          <div className="app-surface-card app-anim-rise rounded-xl p-3">
            <div className="text-[10px] uppercase tracking-wide text-slate-500">Total Time</div>
            <div className="text-lg font-bold text-slate-900 mt-1">
              {formatDuration(stats.totalDurationSeconds)}
            </div>
          </div>
          <div className="app-surface-card app-anim-rise rounded-xl p-3">
            <div className="text-[10px] uppercase tracking-wide text-slate-500">Notes Captured</div>
            <div className="text-lg font-bold text-slate-900 mt-1">{stats.totalNotes}</div>
          </div>
          <div className="app-surface-card app-anim-rise rounded-xl p-3">
            <div className="text-[10px] uppercase tracking-wide text-slate-500">Last Meeting</div>
            <div className="text-xs font-semibold text-slate-800 mt-1">
              {formatDateTime(stats.lastMeetingAt)}
            </div>
          </div>
          <div className="app-surface-card app-anim-rise rounded-xl p-3">
            <div className="text-[10px] uppercase tracking-wide text-slate-500">Questions</div>
            <div className="text-lg font-bold text-slate-900 mt-1">{stats.totalDetectedQuestions}</div>
          </div>
          <div className="app-surface-card app-anim-rise rounded-xl p-3">
            <div className="text-[10px] uppercase tracking-wide text-slate-500">Answer Quality</div>
            <div className="text-lg font-bold text-slate-900 mt-1">
              {Math.round((stats.avgAnswerQuality || 0) * 100)}%
            </div>
          </div>
        </div>

        <div className="app-surface-card overflow-hidden rounded-xl">
          <div className="px-4 py-3 bg-slate-100/70 border-b border-slate-200 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-700">Meeting History</h2>
            <button
              onClick={loadDashboard}
              className="app-btn app-btn-secondary px-2 py-1 text-[11px] text-slate-600"
            >
              Refresh
            </button>
          </div>

          {isLoading ? (
            <div className="p-6 text-xs text-slate-500">Loading meetings...</div>
          ) : error ? (
            <div className="p-6 text-xs text-red-600">{error}</div>
          ) : meetings.length === 0 ? (
            <div className="p-6 text-xs text-slate-500">
              No meetings saved yet. Start one with “Open New Meeting”.
            </div>
          ) : (
            <div className="max-h-[320px] overflow-y-auto">
              {meetings.map(meeting => (
                <button
                  type="button"
                  key={`${meeting.userId}-${meeting.remoteMeetingId}`}
                  onClick={() => setSelectedMeetingId(meeting.remoteMeetingId)}
                  className={`app-list-row w-full border-b border-slate-100 px-4 py-3 text-left last:border-b-0 ${
                    selectedMeeting?.remoteMeetingId === meeting.remoteMeetingId
                      ? "bg-blue-50 ring-1 ring-inset ring-blue-200"
                      : "bg-white"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-slate-800 truncate">
                        {meeting.title}
                      </div>
                      <div className="text-[10px] text-slate-500 mt-1">
                        {formatDateTime(meeting.startTime)}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 text-[10px]">
                      <span className="px-2 py-1 rounded bg-slate-100 text-slate-700">
                        {formatDuration(meeting.durationSeconds)}
                      </span>
                      <span className="px-2 py-1 rounded bg-blue-50 text-blue-700">
                        {meeting.noteCount} notes
                      </span>
                      <span className="px-2 py-1 rounded bg-emerald-50 text-emerald-700">
                        {meeting.transcriptCount} lines
                      </span>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {selectedMeeting && (
          <div className="app-surface-card app-anim-rise mt-4 overflow-hidden rounded-xl">
            <div className="px-4 py-3 bg-slate-100/70 border-b border-slate-200 flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-slate-700">Meeting Details</h2>
              <div className="text-xs text-slate-600 truncate max-w-[65%] text-right">
                {selectedMeeting.title}
              </div>
            </div>

            <div className="space-y-4 p-4">
              <div className="grid grid-cols-2 gap-2 md:grid-cols-6">
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-2">
                  <div className="text-[10px] uppercase tracking-wide text-slate-500">Started</div>
                  <div className="mt-1 text-[11px] font-semibold text-slate-700">
                    {formatDateTime(selectedMeeting.startTime)}
                  </div>
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-2">
                  <div className="text-[10px] uppercase tracking-wide text-slate-500">Ended</div>
                  <div className="mt-1 text-[11px] font-semibold text-slate-700">
                    {formatDateTime(selectedMeeting.endTime)}
                  </div>
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-2">
                  <div className="text-[10px] uppercase tracking-wide text-slate-500">Duration</div>
                  <div className="mt-1 text-[11px] font-semibold text-slate-700">
                    {formatDuration(selectedMeeting.durationSeconds)}
                  </div>
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-2">
                  <div className="text-[10px] uppercase tracking-wide text-slate-500">Questions</div>
                  <div className="mt-1 text-[11px] font-semibold text-slate-700">
                    {selectedMeeting.analytics?.detectedQuestions?.length || 0}
                  </div>
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-2">
                  <div className="text-[10px] uppercase tracking-wide text-slate-500">Answers</div>
                  <div className="mt-1 text-[11px] font-semibold text-slate-700">
                    {selectedMeeting.analytics?.answers?.length || 0}
                  </div>
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-2">
                  <div className="text-[10px] uppercase tracking-wide text-slate-500">Avg Quality</div>
                  <div className="mt-1 text-[11px] font-semibold text-slate-700">
                    {getMeetingAverageAnswerQuality(selectedMeeting)}%
                  </div>
                </div>
              </div>

              {(selectedMeeting.summary?.keyPoints?.length ||
                selectedMeeting.summary?.decisions?.length ||
                selectedMeeting.summary?.actionItems?.length ||
                selectedMeeting.summary?.nextSteps?.length) && (
                <section className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <h3 className="text-xs font-semibold text-slate-800">Summary</h3>
                  <div className="mt-2 grid grid-cols-1 gap-3 md:grid-cols-2">
                    {selectedMeeting.summary?.keyPoints?.length ? (
                      <div>
                        <div className="text-[10px] uppercase tracking-wide text-slate-500">Key Points</div>
                        <ul className="mt-1 space-y-1 text-xs text-slate-700">
                          {selectedMeeting.summary.keyPoints.map((item, index) => (
                            <li key={`key-point-${index}`}>• {item}</li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                    {selectedMeeting.summary?.decisions?.length ? (
                      <div>
                        <div className="text-[10px] uppercase tracking-wide text-slate-500">Decisions</div>
                        <ul className="mt-1 space-y-1 text-xs text-slate-700">
                          {selectedMeeting.summary.decisions.map((item, index) => (
                            <li key={`decision-${index}`}>• {item}</li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                    {selectedMeeting.summary?.actionItems?.length ? (
                      <div>
                        <div className="text-[10px] uppercase tracking-wide text-slate-500">Action Items</div>
                        <ul className="mt-1 space-y-1 text-xs text-slate-700">
                          {selectedMeeting.summary.actionItems.map((item, index) => (
                            <li key={`action-item-${index}`}>• {item}</li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                    {selectedMeeting.summary?.nextSteps?.length ? (
                      <div>
                        <div className="text-[10px] uppercase tracking-wide text-slate-500">Next Steps</div>
                        <ul className="mt-1 space-y-1 text-xs text-slate-700">
                          {selectedMeeting.summary.nextSteps.map((item, index) => (
                            <li key={`next-step-${index}`}>• {item}</li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </div>
                </section>
              )}

              <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
                <section className="rounded-lg border border-slate-200 bg-white p-3">
                  <h3 className="text-xs font-semibold text-slate-800">Notes ({selectedMeeting.noteCount})</h3>
                  {selectedMeeting.notes.length === 0 ? (
                    <div className="mt-2 text-xs text-slate-500">No notes saved for this meeting.</div>
                  ) : (
                    <div className="mt-2 max-h-[240px] space-y-2 overflow-y-auto pr-1">
                      {selectedMeeting.notes.slice(0, 120).map((note, index) => (
                        <div key={`${note.timestamp}-${index}`} className="rounded border border-slate-200 bg-slate-50 px-2 py-1.5">
                          <div className="flex items-center justify-between text-[10px] text-slate-500">
                            <span>{note.speaker || "Speaker"}</span>
                            <span>{formatClockTime(note.timestamp)}</span>
                          </div>
                          <p className="mt-1 text-xs text-slate-700">{note.content}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </section>

                <section className="rounded-lg border border-slate-200 bg-white p-3">
                  <h3 className="text-xs font-semibold text-slate-800">Transcript ({selectedMeeting.transcriptCount})</h3>
                  {selectedMeeting.transcripts.length === 0 ? (
                    <div className="mt-2 text-xs text-slate-500">No transcript lines saved.</div>
                  ) : (
                    <div className="mt-2 max-h-[240px] space-y-2 overflow-y-auto pr-1">
                      {selectedMeeting.transcripts.slice(0, 200).map((line, index) => (
                        <div key={`${line.timestamp}-${index}`} className="rounded border border-slate-200 bg-slate-50 px-2 py-1.5">
                          <div className="flex items-center justify-between text-[10px] text-slate-500">
                            <span className="capitalize">{line.source || "user"}</span>
                            <span>{formatMeetingOffset(selectedMeeting, line.timestamp)}</span>
                          </div>
                          <p className="mt-1 text-xs text-slate-700">{line.text}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              </div>

              <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
                <section className="rounded-lg border border-slate-200 bg-white p-3">
                  <h3 className="text-xs font-semibold text-slate-800">
                    Detected Questions ({selectedMeeting.analytics?.detectedQuestions?.length || 0})
                  </h3>
                  {selectedMeeting.analytics?.detectedQuestions?.length ? (
                    <div className="mt-2 max-h-[220px] space-y-2 overflow-y-auto pr-1">
                      {selectedMeeting.analytics.detectedQuestions.slice(0, 100).map(question => (
                        <div key={question.id} className="rounded border border-slate-200 bg-slate-50 px-2 py-1.5">
                          <div className="flex items-center justify-between text-[10px] text-slate-500">
                            <span className="capitalize">{question.source}</span>
                            <span>{Math.round(question.confidence * 100)}% confidence</span>
                          </div>
                          <p className="mt-1 text-xs text-slate-700">{question.question}</p>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="mt-2 text-xs text-slate-500">No detected questions for this meeting.</div>
                  )}
                </section>

                <section className="rounded-lg border border-slate-200 bg-white p-3">
                  <h3 className="text-xs font-semibold text-slate-800">
                    AI Answers ({selectedMeeting.analytics?.answers?.length || 0})
                  </h3>
                  {selectedMeeting.analytics?.answers?.length ? (
                    <div className="mt-2 max-h-[220px] space-y-2 overflow-y-auto pr-1">
                      {selectedMeeting.analytics.answers.slice(0, 100).map(answer => (
                        <div key={answer.id} className="rounded border border-slate-200 bg-slate-50 px-2 py-1.5">
                          <div className="flex flex-wrap items-center justify-between gap-1 text-[10px] text-slate-500">
                            <span>{answer.provider} / {answer.model}</span>
                            <span>{Math.round((answer.quality?.overall || 0) * 100)}% quality</span>
                          </div>
                          <p className="mt-1 text-[11px] font-semibold text-slate-700">{answer.question}</p>
                          <p className="mt-1 text-xs text-slate-700 whitespace-pre-wrap">{answer.answer}</p>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="mt-2 text-xs text-slate-500">No AI answers saved for this meeting.</div>
                  )}
                </section>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default Dashboard
