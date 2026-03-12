// App.tsx - UPDATED WITH COMPLETE TYPES

import { ToastProvider } from "./components/ui/toast"
import Queue from "./_pages/Queue"
import Auth from "./_pages/Auth"
import { ToastViewport } from "@radix-ui/react-toast"
import { useEffect, useRef, useState } from "react"
import type { MouseEvent as ReactMouseEvent } from "react"
import Solutions from "./_pages/Solutions"
import Dashboard from "./_pages/Dashboard"
import Workspace from "./_pages/Workspace"
import AppNavbar, { AppNavbarTarget } from "./components/ui/AppNavbar"
import { QueryClient, QueryClientProvider } from "react-query"
import { getCurrentUser, logoutUser, StoredUser } from "./lib/authStore"
import { RuntimeMeeting, saveMeetingRecord } from "./lib/meetingsStore"

// Meeting-related types
interface MeetingNote {
  timestamp: number;
  speaker: string;
  type: string;
  content: string;
  tags: string[];
}

interface MeetingTranscript {
  timestamp: number;
  text: string;
  source?: "user" | "interviewer";
}

interface LiveTranscriptPayload {
  text: string;
  source: "user" | "interviewer";
}

interface MeetingSummary {
  keyPoints: string[];
  decisions: string[];
  actionItems: string[];
  participants: string[];
  nextSteps: string[];
}

interface MindMapNode {
  id: string;
  label: string;
  children?: MindMapNode[];
}

interface Meeting {
  id: string;
  title: string;
  startTime: number;
  endTime?: number;
  isRecording: boolean;
  isPaused: boolean;
  notes: MeetingNote[];
  transcripts: MeetingTranscript[];
  analytics?: Record<string, unknown>;
  summary?: MeetingSummary;
  mindMap?: MindMapNode;
}

interface WindowResizeState {
  active: boolean
  lastScreenX: number
  lastScreenY: number
  pendingDeltaWidth: number
  pendingDeltaHeight: number
  rafId: number | null
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: Infinity,
      cacheTime: Infinity
    }
  }
})

const App: React.FC = () => {
  const electronAPI = window.electronAPI
  const [view, setView] = useState<"dashboard" | "queue" | "solutions" | "workspace" | "debug">("dashboard")
  const [queueMode, setQueueMode] = useState<"full" | "meeting">("full")
  const [dashboardRefreshKey, setDashboardRefreshKey] = useState(0)
  const [currentUser, setCurrentUser] = useState<StoredUser | null>(() =>
    getCurrentUser()
  )
  const [isIncognitoMode, setIsIncognitoMode] = useState(false)
  const [isIncognitoAnimating, setIsIncognitoAnimating] = useState(false)
  const [isIncognitoBusy, setIsIncognitoBusy] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const hasLoadedIncognitoRef = useRef(false)
  const resizeStateRef = useRef<WindowResizeState>({
    active: false,
    lastScreenX: 0,
    lastScreenY: 0,
    pendingDeltaWidth: 0,
    pendingDeltaHeight: 0,
    rafId: null
  })
  const [isWindowResizing, setIsWindowResizing] = useState(false)

  // Effect for height monitoring
  useEffect(() => {
    if (!electronAPI?.onResetView) {
      console.error("Electron preload API is unavailable. Skipping reset-view listener.")
      return
    }

    const cleanup = electronAPI.onResetView(() => {
      console.log("Received 'reset-view' message from main process.")
      queryClient.invalidateQueries(["screenshots"])
      queryClient.invalidateQueries(["problem_statement"])
      queryClient.invalidateQueries(["solution"])
      queryClient.invalidateQueries(["new_solution"])
      setView("queue")
    })

    return () => {
      cleanup()
    }
  }, [])

  useEffect(() => {
    if (!containerRef.current) return

    const updateHeight = () => {
      if (!containerRef.current) return
      if (isWindowResizing) return
      const height = containerRef.current.scrollHeight
      const width = containerRef.current.scrollWidth
      electronAPI?.updateContentDimensions({ width, height })
    }

    const resizeObserver = new ResizeObserver(() => {
      updateHeight()
    })

    // Initial height update
    updateHeight()

    // Observe for changes
    resizeObserver.observe(containerRef.current)

    // Also update height when view changes
    const mutationObserver = new MutationObserver(() => {
      updateHeight()
    })

    mutationObserver.observe(containerRef.current, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true
    })

    return () => {
      resizeObserver.disconnect()
      mutationObserver.disconnect()
    }
  }, [view, queueMode, isWindowResizing]) // Re-run when view/meeting mode or resize mode changes

  useEffect(() => {
    if (!electronAPI) {
      console.error("Electron preload API is unavailable. Skipping renderer event subscriptions.")
      return
    }

    const cleanupFunctions = [
      electronAPI.onSolutionStart(() => {
        setView("solutions")
        console.log("starting processing")
      }),

      electronAPI.onUnauthorized(() => {
        queryClient.removeQueries(["screenshots"])
        queryClient.removeQueries(["solution"])
        queryClient.removeQueries(["problem_statement"])
        setView("queue")
        console.log("Unauthorized")
      }),
      
      electronAPI.onResetView(() => {
        console.log("Received 'reset-view' message from main process")
        queryClient.removeQueries(["screenshots"])
        queryClient.removeQueries(["solution"])
        queryClient.removeQueries(["problem_statement"])
        setView("queue")
        console.log("View reset to 'queue' via Command+R shortcut")
      }),
      
      electronAPI.onProblemExtracted((data: any) => {
        if (view === "queue") {
          console.log("Problem extracted successfully")
          queryClient.invalidateQueries(["problem_statement"])
          queryClient.setQueryData(["problem_statement"], data)
        }
      })
    ]
    
    return () => cleanupFunctions.forEach((cleanup) => cleanup())
  }, [])

  useEffect(() => {
    if (!isWindowResizing) {
      return
    }

    const flushResize = () => {
      const state = resizeStateRef.current
      state.rafId = null

      const deltaWidth = state.pendingDeltaWidth
      const deltaHeight = state.pendingDeltaHeight
      if (!deltaWidth && !deltaHeight) {
        return
      }

      state.pendingDeltaWidth = 0
      state.pendingDeltaHeight = 0
      electronAPI
        .resizeWindowBy({ deltaWidth, deltaHeight })
        .catch((error) => {
          console.error("Failed to resize window:", error)
        })
    }

    const handleMouseMove = (event: MouseEvent) => {
      const state = resizeStateRef.current
      if (!state.active) return

      const deltaWidth = event.screenX - state.lastScreenX
      const deltaHeight = event.screenY - state.lastScreenY

      state.lastScreenX = event.screenX
      state.lastScreenY = event.screenY
      state.pendingDeltaWidth += deltaWidth
      state.pendingDeltaHeight += deltaHeight

      if (state.rafId === null) {
        state.rafId = window.requestAnimationFrame(flushResize)
      }
    }

    const handleMouseUp = () => {
      const state = resizeStateRef.current
      state.active = false
      setIsWindowResizing(false)
      if (state.rafId !== null) {
        window.cancelAnimationFrame(state.rafId)
        state.rafId = null
      }
      flushResize()
    }

    window.addEventListener("mousemove", handleMouseMove)
    window.addEventListener("mouseup", handleMouseUp)
    window.addEventListener("blur", handleMouseUp)

    return () => {
      window.removeEventListener("mousemove", handleMouseMove)
      window.removeEventListener("mouseup", handleMouseUp)
      window.removeEventListener("blur", handleMouseUp)
      const state = resizeStateRef.current
      if (state.rafId !== null) {
        window.cancelAnimationFrame(state.rafId)
        state.rafId = null
      }
      state.active = false
      state.pendingDeltaWidth = 0
      state.pendingDeltaHeight = 0
    }
  }, [isWindowResizing, electronAPI])

  useEffect(() => {
    if (!electronAPI?.getIncognitoMode || !electronAPI?.onIncognitoModeChanged) {
      return
    }

    let mounted = true

    const loadCurrentState = async () => {
      try {
        const state = await electronAPI.getIncognitoMode()
        if (!mounted) return
        setIsIncognitoMode(Boolean(state.enabled))
        hasLoadedIncognitoRef.current = true
      } catch (error) {
        console.error("Failed to load incognito mode:", error)
      }
    }

    loadCurrentState()

    const unsubscribe = electronAPI.onIncognitoModeChanged((enabled: boolean) => {
      if (!mounted) return
      setIsIncognitoMode(Boolean(enabled))
    })

    return () => {
      mounted = false
      unsubscribe?.()
    }
  }, [electronAPI])

  useEffect(() => {
    if (!hasLoadedIncognitoRef.current) return
    setIsIncognitoAnimating(true)
    const timeout = window.setTimeout(() => {
      setIsIncognitoAnimating(false)
    }, 680)
    return () => window.clearTimeout(timeout)
  }, [isIncognitoMode])

  const handleResizeMouseDown = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()

    const state = resizeStateRef.current
    state.active = true
    state.lastScreenX = event.screenX
    state.lastScreenY = event.screenY
    state.pendingDeltaWidth = 0
    state.pendingDeltaHeight = 0
    if (state.rafId !== null) {
      window.cancelAnimationFrame(state.rafId)
      state.rafId = null
    }
    setIsWindowResizing(true)
  }

  const resizeGrip = (
    <button
      aria-label="Resize window"
      className={`window-resize-grip${isWindowResizing ? " window-resize-grip-active" : ""}`}
      onMouseDown={handleResizeMouseDown}
      title="Drag to resize"
      type="button"
    />
  )

  const handleLogout = () => {
    logoutUser()
    setCurrentUser(null)
    setQueueMode("full")
    setView("dashboard")
  }

  const handleOpenNewMeeting = () => {
    setQueueMode("meeting")
    setView("queue")
  }

  const handleOpenWorkspace = () => {
    setView("workspace")
  }

  const handleExitToDashboard = () => {
    setQueueMode("full")
    setView("dashboard")
  }

  const handleMeetingSaved = async (meeting: RuntimeMeeting) => {
    if (!currentUser) return
    try {
      await saveMeetingRecord(currentUser, meeting)
      setDashboardRefreshKey(prev => prev + 1)
    } catch (error) {
      console.error("Failed to persist meeting history:", error)
    }
  }

  const isMeetingOverlayView = view === "queue" && queueMode === "meeting"

  const handleToggleIncognitoMode = async () => {
    if (!electronAPI?.setIncognitoMode || isIncognitoBusy) return
    const previous = isIncognitoMode
    const next = !previous
    setIsIncognitoBusy(true)
    setIsIncognitoMode(next)
    try {
      const result = await electronAPI.setIncognitoMode(next)
      setIsIncognitoMode(Boolean(result?.enabled))
    } catch (error) {
      console.error("Failed to toggle incognito mode:", error)
      setIsIncognitoMode(previous)
    } finally {
      setIsIncognitoBusy(false)
    }
  }

  const handleAppNavigation = (target: AppNavbarTarget) => {
    if (target === "dashboard") {
      setQueueMode("full")
      setView("dashboard")
      return
    }
    if (target === "assistant") {
      setQueueMode("full")
      setView("queue")
      return
    }
    if (target === "meeting") {
      setQueueMode("meeting")
      setView("queue")
      return
    }
    if (target === "workspace") {
      setView("workspace")
    }
  }

  if (!currentUser) {
    return (
      <div ref={containerRef} className="min-h-0 relative app-window-shell">
        <Auth
          onAuthenticated={(user) => {
            setCurrentUser(user)
            setQueueMode("full")
            setView("dashboard")
          }}
        />
        {resizeGrip}
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      className={`min-h-0 relative app-window-shell ${
        isIncognitoMode ? "app-incognito-mode" : ""
      } ${isIncognitoAnimating ? "app-incognito-animating" : ""} ${
        isMeetingOverlayView ? "app-window-shell-meeting" : ""
      }`}
    >
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <div className="app-auth-layout h-full w-full">
            <AppNavbar
              user={currentUser}
              currentView={view}
              queueMode={queueMode}
              isIncognitoMode={isIncognitoMode}
              isIncognitoBusy={isIncognitoBusy}
              onNavigate={handleAppNavigation}
              onToggleIncognito={handleToggleIncognitoMode}
              onLogout={handleLogout}
            />
            <div
              className={`app-auth-content min-h-0 flex-1 overflow-auto ${
                isMeetingOverlayView ? "app-auth-content-meeting" : ""
              }`}
            >
              {view === "dashboard" ? (
                <Dashboard
                  user={currentUser}
                  refreshKey={dashboardRefreshKey}
                  onOpenNewMeeting={handleOpenNewMeeting}
                  onOpenWorkspace={handleOpenWorkspace}
                  onLogout={handleLogout}
                />
              ) : view === "queue" ? (
                <Queue
                  setView={setView}
                  mode={queueMode}
                  onExitToDashboard={handleExitToDashboard}
                  onMeetingSaved={handleMeetingSaved}
                />
              ) : view === "workspace" ? (
                <Workspace onBackToDashboard={handleExitToDashboard} />
              ) : view === "solutions" ? (
                <Solutions setView={setView} />
              ) : (
                <></>
              )}
            </div>
          </div>
          <ToastViewport />
        </ToastProvider>
      </QueryClientProvider>
      {resizeGrip}
    </div>
  )
}

export default App

// Export types for use in other components
export type { 
  Meeting, 
  MeetingNote, 
  MeetingTranscript, 
  MeetingSummary, 
  MindMapNode 
}
