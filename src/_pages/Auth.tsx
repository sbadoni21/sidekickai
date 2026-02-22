import React, { useState } from "react"
import { loginUser, registerUser, StoredUser } from "../lib/authStore"

interface AuthProps {
  onAuthenticated: (user: StoredUser) => void
}

const Auth: React.FC<AuthProps> = ({ onAuthenticated }) => {
  const [mode, setMode] = useState<"login" | "register">("login")
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const resetErrors = () => setError(null)

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    resetErrors()

    if (!email.trim() || !password.trim() || (mode === "register" && !name.trim())) {
      setError("Please fill in all required fields.")
      return
    }

    if (mode === "register") {
      if (password.length < 6) {
        setError("Password must be at least 6 characters.")
        return
      }

      if (password !== confirmPassword) {
        setError("Passwords do not match.")
        return
      }
    }

    setIsSubmitting(true)
    try {
      const result =
        mode === "login"
          ? await loginUser({ email, password })
          : await registerUser({ name, email, password })

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
    <div className="min-h-[360px] w-full flex items-center justify-center p-2">
      <div className="w-[420px] rounded-2xl border border-slate-200 bg-white/95 shadow-[0_18px_50px_rgba(15,23,42,0.35)] p-6">
        <div className="auth-drag-handle mb-4 rounded-xl border border-slate-300/80 bg-slate-100/80 py-1">
          <span className="pointer-events-none select-none text-[9px] font-semibold uppercase tracking-[0.18em] text-slate-500">
            Hold and drag to move
          </span>
        </div>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-lg font-semibold text-gray-900">Interview Companion</h1>
            <p className="text-xs text-gray-600">Secure your session and load your resources.</p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              className={`px-3 py-1 rounded-full text-[10px] font-medium transition-all ${
                mode === "login"
                  ? "bg-blue-600/90 text-white shadow"
                  : "bg-white/30 text-gray-700 hover:bg-white/40"
              }`}
              onClick={() => {
                setMode("login")
                resetErrors()
              }}
            >
              Login
            </button>
            <button
              type="button"
              className={`px-3 py-1 rounded-full text-[10px] font-medium transition-all ${
                mode === "register"
                  ? "bg-blue-600/90 text-white shadow"
                  : "bg-white/30 text-gray-700 hover:bg-white/40"
              }`}
              onClick={() => {
                setMode("register")
                resetErrors()
              }}
            >
              Register
            </button>
          </div>
        </div>

        <form className="space-y-3" onSubmit={handleSubmit}>
          {mode === "register" && (
            <div>
              <label className="text-[10px] uppercase tracking-wide text-gray-600">Full name</label>
              <input
                type="text"
                value={name}
                onChange={event => setName(event.target.value)}
                className="mt-1 w-full rounded-lg px-3 py-2 bg-white/60 text-gray-900 text-xs border border-white/60 focus:outline-none focus:ring-2 focus:ring-blue-500/60"
                placeholder="Jane Candidate"
              />
            </div>
          )}

          <div>
            <label className="text-[10px] uppercase tracking-wide text-gray-600">Email</label>
            <input
              type="email"
              value={email}
              onChange={event => setEmail(event.target.value)}
              className="mt-1 w-full rounded-lg px-3 py-2 bg-white/60 text-gray-900 text-xs border border-white/60 focus:outline-none focus:ring-2 focus:ring-blue-500/60"
              placeholder="you@email.com"
            />
          </div>

          <div>
            <label className="text-[10px] uppercase tracking-wide text-gray-600">Password</label>
            <input
              type="password"
              value={password}
              onChange={event => setPassword(event.target.value)}
              className="mt-1 w-full rounded-lg px-3 py-2 bg-white/60 text-gray-900 text-xs border border-white/60 focus:outline-none focus:ring-2 focus:ring-blue-500/60"
              placeholder="••••••••"
            />
          </div>

          {mode === "register" && (
            <div>
              <label className="text-[10px] uppercase tracking-wide text-gray-600">Confirm password</label>
              <input
                type="password"
                value={confirmPassword}
                onChange={event => setConfirmPassword(event.target.value)}
                className="mt-1 w-full rounded-lg px-3 py-2 bg-white/60 text-gray-900 text-xs border border-white/60 focus:outline-none focus:ring-2 focus:ring-blue-500/60"
                placeholder="••••••••"
              />
            </div>
          )}

          {error && (
            <div className="rounded-lg bg-red-500/20 border border-red-400/60 px-3 py-2 text-[10px] text-red-700">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full mt-2 px-3 py-2 rounded-lg bg-gray-900/90 text-white text-xs font-semibold hover:bg-gray-900 disabled:opacity-60"
          >
            {isSubmitting ? "Please wait..." : mode === "login" ? "Sign in" : "Create account"}
          </button>
        </form>

        <div className="mt-4 text-[10px] text-gray-500">
          Your data stays on this device. Use the Resources panel to upload resumes and knowledge sources.
        </div>
      </div>
    </div>
  )
}

export default Auth
