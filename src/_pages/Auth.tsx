import React, { useState } from "react"
import { loginUser, StoredUser } from "../lib/authStore"

interface AuthProps {
  onAuthenticated: (user: StoredUser) => void
}

const Auth: React.FC<AuthProps> = ({ onAuthenticated }) => {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const resetErrors = () => setError(null)

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    resetErrors()

    if (!email.trim() || !password.trim()) {
      setError("Please fill in all required fields.")
      return
    }

    setIsSubmitting(true)
    try {
      const result = await loginUser({ email, password })

      if (result.error || !result.user) {
        setError(result.error || "Authentication failed.")
        return
      }

      onAuthenticated(result.user)
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="app-page-shell h-full w-full p-0">
      <div className="app-page-surface h-full w-full p-4 sm:p-6">
        <div className="app-drag-pill auth-drag-handle mb-4 rounded-xl py-1">
          <span className="pointer-events-none select-none text-[9px] font-semibold uppercase tracking-[0.18em] text-slate-500">
            Hold and drag to move
          </span>
        </div>
        <div className="app-surface-card app-anim-rise mx-auto w-full max-w-[440px] rounded-2xl p-5">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h1 className="text-xl font-semibold text-gray-900">Interview Companion</h1>
              <p className="text-sm text-gray-600">Secure your session and load your resources.</p>
            </div>
            <div className="rounded-full bg-slate-100 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-600">
              Sign in
            </div>
          </div>

          <form className="space-y-3" onSubmit={handleSubmit}>
            <div>
              <label className="text-[11px] uppercase tracking-wide text-gray-600">Email</label>
              <input
                type="email"
                value={email}
                onChange={event => setEmail(event.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500/35"
                placeholder="you@email.com"
              />
            </div>

            <div>
              <label className="text-[11px] uppercase tracking-wide text-gray-600">Password</label>
              <input
                type="password"
                value={password}
                onChange={event => setPassword(event.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500/35"
                placeholder="••••••••"
              />
            </div>

            {error && (
              <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={isSubmitting}
              className="app-btn app-btn-primary mt-2 w-full px-3 py-2.5 text-sm font-semibold disabled:opacity-60"
            >
              {isSubmitting ? "Please wait..." : "Sign in"}
            </button>
          </form>

          <div className="mt-4 text-xs text-gray-500">
            Your data stays on this device. Use the Resources panel to upload resumes and knowledge sources.
          </div>
        </div>
      </div>
    </div>
  )
}

export default Auth
