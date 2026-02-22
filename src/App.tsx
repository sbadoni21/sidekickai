// App.tsx - UPDATED WITH COMPLETE TYPES

import { ToastProvider } from "./components/ui/toast"
import Queue from "./_pages/Queue"
import Auth from "./_pages/Auth"
import { ToastViewport } from "@radix-ui/react-toast"
import { useEffect, useRef, useState } from "react"
import Solutions from "./_pages/Solutions"
import Dashboard from "./_pages/Dashboard"
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

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: Infinity,
      cacheTime: Infinity
    }
  }
})

const App: React.FC = () => {
  const [view, setView] = useState<"dashboard" | "queue" | "solutions" | "debug">("dashboard")
  const [queueMode, setQueueMode] = useState<"full" | "meeting">("full")
  const [dashboardRefreshKey, setDashboardRefreshKey] = useState(0)
  const [currentUser, setCurrentUser] = useState<StoredUser | null>(() =>
    getCurrentUser()
  )
  const containerRef = useRef<HTMLDivElement>(null)

  // Effect for height monitoring
  useEffect(() => {
    const cleanup = window.electronAPI.onResetView(() => {
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
      const height = containerRef.current.scrollHeight
      const width = containerRef.current.scrollWidth
      window.electronAPI?.updateContentDimensions({ width, height })
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
  }, [view]) // Re-run when view changes

  useEffect(() => {
    const cleanupFunctions = [
      window.electronAPI.onSolutionStart(() => {
        setView("solutions")
        console.log("starting processing")
      }),

      window.electronAPI.onUnauthorized(() => {
        queryClient.removeQueries(["screenshots"])
        queryClient.removeQueries(["solution"])
        queryClient.removeQueries(["problem_statement"])
        setView("queue")
        console.log("Unauthorized")
      }),
      
      window.electronAPI.onResetView(() => {
        console.log("Received 'reset-view' message from main process")
        queryClient.removeQueries(["screenshots"])
        queryClient.removeQueries(["solution"])
        queryClient.removeQueries(["problem_statement"])
        setView("queue")
        console.log("View reset to 'queue' via Command+R shortcut")
      }),
      
      window.electronAPI.onProblemExtracted((data: any) => {
        if (view === "queue") {
          console.log("Problem extracted successfully")
          queryClient.invalidateQueries(["problem_statement"])
          queryClient.setQueryData(["problem_statement"], data)
        }
      })
    ]
    
    return () => cleanupFunctions.forEach((cleanup) => cleanup())
  }, [])

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
    setQueueMode("full")
    setView("queue")
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

  if (!currentUser) {
    return (
      <div ref={containerRef} className="min-h-0">
        <Auth
          onAuthenticated={(user) => {
            setCurrentUser(user)
            setQueueMode("full")
            setView("dashboard")
          }}
        />
      </div>
    )
  }

  return (
    <div ref={containerRef} className="min-h-0">
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
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
          ) : view === "solutions" ? (
            <Solutions setView={setView} />
          ) : (
            <></>
          )}
          <ToastViewport />
        </ToastProvider>
      </QueryClientProvider>
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
