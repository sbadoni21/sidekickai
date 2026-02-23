import React from "react"
import { LayoutDashboard, LogOut, Shield, Sparkles, BriefcaseBusiness, FolderKanban } from "lucide-react"
import { StoredUser } from "../../lib/authStore"

type AppView = "dashboard" | "queue" | "solutions" | "workspace" | "debug"

export type AppNavbarTarget = "dashboard" | "assistant" | "meeting" | "workspace"

interface AppNavbarProps {
  user: StoredUser
  currentView: AppView
  queueMode: "full" | "meeting"
  isIncognitoMode: boolean
  isIncognitoBusy?: boolean
  onNavigate: (target: AppNavbarTarget) => void
  onToggleIncognito: () => void
  onLogout: () => void
}

const buildUserInitials = (user: StoredUser): string => {
  const raw = (user.name || user.email || "").trim()
  if (!raw) return "U"
  const parts = raw.split(/\s+/).filter(Boolean)
  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase()
  }
  return `${parts[0][0] || ""}${parts[1][0] || ""}`.toUpperCase()
}

const AppNavbar: React.FC<AppNavbarProps> = ({
  user,
  currentView,
  queueMode,
  isIncognitoMode,
  isIncognitoBusy = false,
  onNavigate,
  onToggleIncognito,
  onLogout
}) => {
  const activeTarget: AppNavbarTarget =
    currentView === "queue" ? (queueMode === "meeting" ? "meeting" : "assistant") : currentView === "workspace" ? "workspace" : "dashboard"

  return (
    <header className={`app-global-nav ${isIncognitoMode ? "is-incognito" : ""}`}>
      <div className="app-global-drag-strip">
        <span className="app-global-drag-label">Hold and drag to move</span>
      </div>

      <div className="app-global-nav-row">
        <div className="app-global-user-card">
          <div className="app-global-user-avatar">{buildUserInitials(user)}</div>
          <div className="app-global-user-meta">
            <div className="app-global-user-name">{user.name || "User"}</div>
            <div className="app-global-user-email">{user.email}</div>
          </div>
        </div>

        <nav className="app-global-tabs" aria-label="Primary navigation">
          <button
            type="button"
            className={`app-global-tab ${activeTarget === "dashboard" ? "is-active" : ""}`}
            onClick={() => onNavigate("dashboard")}
          >
            <LayoutDashboard className="h-3.5 w-3.5" />
            Dashboard
          </button>
          <button
            type="button"
            className={`app-global-tab ${activeTarget === "meeting" ? "is-active" : ""}`}
            onClick={() => onNavigate("meeting")}
          >
            <BriefcaseBusiness className="h-3.5 w-3.5" />
            Meeting
          </button>
          <button
            type="button"
            className={`app-global-tab ${activeTarget === "assistant" ? "is-active" : ""}`}
            onClick={() => onNavigate("assistant")}
          >
            <Sparkles className="h-3.5 w-3.5" />
            Assistant
          </button>
          <button
            type="button"
            className={`app-global-tab ${activeTarget === "workspace" ? "is-active" : ""}`}
            onClick={() => onNavigate("workspace")}
          >
            <FolderKanban className="h-3.5 w-3.5" />
            Workspace
          </button>
        </nav>

        <div className="app-global-actions">
          <button
            type="button"
            className="app-incognito-toggle"
            data-enabled={isIncognitoMode ? "true" : "false"}
            onClick={onToggleIncognito}
            disabled={isIncognitoBusy}
            title="Toggle stealth mode (always-on-top + screenshot protection)"
          >
            <span className="app-incognito-track">
              <span className="app-incognito-thumb" />
            </span>
            <span className="app-incognito-text">
              <Shield className="h-3.5 w-3.5" />
              {isIncognitoMode ? "Incognito On" : "Incognito Off"}
            </span>
          </button>

          <button type="button" className="app-btn app-btn-danger px-3 py-2 text-xs" onClick={onLogout}>
            <LogOut className="h-3.5 w-3.5" />
            Logout
          </button>
        </div>
      </div>
    </header>
  )
}

export default AppNavbar
