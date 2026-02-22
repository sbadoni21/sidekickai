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

const Dashboard: React.FC<DashboardProps> = ({
  user,
  refreshKey,
  onOpenNewMeeting,
  onOpenWorkspace,
  onLogout
}) => {
  const [meetings, setMeetings] = useState<MeetingRecord[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const storageMode = getMeetingsStorageMode()

  const stats = useMemo(() => computeMeetingStats(meetings), [meetings])

  const loadDashboard = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const loaded = await loadMeetingRecords(user.id)
      setMeetings(loaded)
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
    <div className="h-full w-full p-0">
      <div className="h-full w-full bg-white p-4 sm:p-6">
        <div className="auth-drag-handle mb-4 rounded-xl border border-slate-300/80 bg-slate-100/80 py-1">
          <span className="pointer-events-none select-none text-[9px] font-semibold uppercase tracking-[0.18em] text-slate-500">
            Hold and drag to move
          </span>
        </div>

        <div className="flex items-start justify-between mb-5">
          <div>
            <h1 className="text-xl font-bold text-slate-900">Meeting Dashboard</h1>
            <p className="text-xs text-slate-600 mt-1">
              {user.name} • {user.email}
            </p>
            <p className="text-[10px] text-slate-500 mt-1">
              Storage: {storageMode === "supabase" ? "Supabase" : "Local fallback"}
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={onOpenNewMeeting}
              className="px-3 py-2 rounded-lg bg-blue-600 text-white text-xs font-semibold hover:bg-blue-700"
            >
              Open New Meeting
            </button>
            <button
              onClick={onOpenWorkspace}
              className="px-3 py-2 rounded-lg bg-slate-100 text-slate-700 text-xs font-semibold hover:bg-slate-200 border border-slate-200"
            >
              Open Workspace
            </button>
            <button
              onClick={onLogout}
              className="px-3 py-2 rounded-lg bg-red-50 text-red-700 text-xs font-semibold hover:bg-red-100 border border-red-200"
            >
              Logout
            </button>
          </div>
        </div>

        <div className="grid grid-cols-3 md:grid-cols-6 gap-3 mb-5">
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
            <div className="text-[10px] uppercase tracking-wide text-slate-500">Meetings</div>
            <div className="text-lg font-bold text-slate-900 mt-1">{stats.totalMeetings}</div>
          </div>
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
            <div className="text-[10px] uppercase tracking-wide text-slate-500">Total Time</div>
            <div className="text-lg font-bold text-slate-900 mt-1">
              {formatDuration(stats.totalDurationSeconds)}
            </div>
          </div>
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
            <div className="text-[10px] uppercase tracking-wide text-slate-500">Notes Captured</div>
            <div className="text-lg font-bold text-slate-900 mt-1">{stats.totalNotes}</div>
          </div>
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
            <div className="text-[10px] uppercase tracking-wide text-slate-500">Last Meeting</div>
            <div className="text-xs font-semibold text-slate-800 mt-1">
              {formatDateTime(stats.lastMeetingAt)}
            </div>
          </div>
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
            <div className="text-[10px] uppercase tracking-wide text-slate-500">Questions</div>
            <div className="text-lg font-bold text-slate-900 mt-1">{stats.totalDetectedQuestions}</div>
          </div>
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
            <div className="text-[10px] uppercase tracking-wide text-slate-500">Answer Quality</div>
            <div className="text-lg font-bold text-slate-900 mt-1">
              {Math.round((stats.avgAnswerQuality || 0) * 100)}%
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 overflow-hidden">
          <div className="px-4 py-3 bg-slate-100/70 border-b border-slate-200 flex items-center justify-between">
            <h2 className="text-xs font-semibold text-slate-700">Meeting History</h2>
            <button
              onClick={loadDashboard}
              className="text-[10px] px-2 py-1 rounded bg-white border border-slate-200 text-slate-600 hover:bg-slate-50"
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
                <div
                  key={`${meeting.userId}-${meeting.remoteMeetingId}`}
                  className="px-4 py-3 border-b border-slate-100 last:border-b-0 bg-white"
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
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default Dashboard
