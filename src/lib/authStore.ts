export interface StoredUser {
  id: string
  name: string
  email: string
  createdAt: number
}

interface FirebaseConfig {
  apiKey: string
  authDomain: string
  projectId: string
  storageBucket: string
  messagingSenderId: string
  appId: string
  measurementId: string
}

interface FirebaseAuthResponse {
  idToken: string
  email: string
  refreshToken: string
  expiresIn: string
  localId: string
  displayName?: string
}

interface StoredSession {
  idToken: string
  refreshToken: string
  expiresAt: number
  user: StoredUser
}

const firebaseConfig: FirebaseConfig = {
  apiKey: "AIzaSyDa_XQrsRwHhmBkAMD5VhefhHOFE6swVLw",
  authDomain: "sidekickai-58d2d.firebaseapp.com",
  projectId: "sidekickai-58d2d",
  storageBucket: "sidekickai-58d2d.firebasestorage.app",
  messagingSenderId: "1013808105166",
  appId: "1:1013808105166:web:86fa10a6c3b1e1b9c0729f",
  measurementId: "G-1J00H31MSN"
}

const SESSION_KEY = "cluely_firebase_auth_session_v1"
const IDENTITY_TOOLKIT_BASE_URL = "https://identitytoolkit.googleapis.com/v1"

const safeParse = <T>(value: string | null, fallback: T): T => {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

const saveSession = (session: StoredSession) => {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session))
}

const clearSession = () => {
  localStorage.removeItem(SESSION_KEY)
}

const loadSession = (): StoredSession | null => {
  return safeParse<StoredSession | null>(localStorage.getItem(SESSION_KEY), null)
}

const mapFirebaseError = (message: string): string => {
  const code = message.split(" : ")[0]
  switch (code) {
    case "EMAIL_EXISTS":
      return "An account with this email already exists."
    case "EMAIL_NOT_FOUND":
      return "No account found for this email."
    case "INVALID_PASSWORD":
    case "INVALID_LOGIN_CREDENTIALS":
      return "Incorrect email or password."
    case "USER_DISABLED":
      return "This account has been disabled."
    case "INVALID_EMAIL":
      return "Please enter a valid email address."
    case "MISSING_PASSWORD":
      return "Password is required."
    case "WEAK_PASSWORD":
      return "Password must be at least 6 characters."
    case "OPERATION_NOT_ALLOWED":
      return "Email/password sign-in is not enabled for this Firebase project."
    case "TOO_MANY_ATTEMPTS_TRY_LATER":
      return "Too many attempts. Please try again later."
    default:
      return "Authentication failed. Please try again."
  }
}

const requestFirebaseAuth = async <T>(
  endpoint: string,
  payload: Record<string, unknown>
): Promise<{ data?: T; error?: string }> => {
  try {
    const response = await fetch(
      `${IDENTITY_TOOLKIT_BASE_URL}/${endpoint}?key=${firebaseConfig.apiKey}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      }
    )

    const body = (await response.json()) as any

    if (!response.ok) {
      const rawMessage =
        typeof body?.error?.message === "string"
          ? body.error.message
          : "UNKNOWN_ERROR"
      return { error: mapFirebaseError(rawMessage) }
    }

    return { data: body as T }
  } catch {
    return { error: "Unable to reach Firebase Authentication. Check your internet connection." }
  }
}

const toStoredUser = (
  auth: FirebaseAuthResponse,
  fallbackName?: string
): StoredUser => {
  const baseName = fallbackName?.trim() || auth.displayName?.trim()
  const derivedName = auth.email.split("@")[0] || "Candidate"
  return {
    id: auth.localId,
    name: baseName || derivedName,
    email: auth.email,
    createdAt: Date.now()
  }
}

const persistAuthSession = (auth: FirebaseAuthResponse, user: StoredUser) => {
  const expiresInSeconds = Number(auth.expiresIn || "3600")
  const expiresAt = Date.now() + expiresInSeconds * 1000
  saveSession({
    idToken: auth.idToken,
    refreshToken: auth.refreshToken,
    expiresAt,
    user
  })
}

export const getCurrentUser = (): StoredUser | null => {
  const session = loadSession()
  return session?.user || null
}

export const registerUser = async (params: {
  name: string
  email: string
  password: string
}): Promise<{ user?: StoredUser; error?: string }> => {
  const name = params.name.trim()
  const email = params.email.trim().toLowerCase()
  const password = params.password

  if (!name || !email || !password) {
    return { error: "All fields are required." }
  }

  const signup = await requestFirebaseAuth<FirebaseAuthResponse>(
    "accounts:signUp",
    {
      email,
      password,
      returnSecureToken: true
    }
  )

  if (!signup.data) {
    return { error: signup.error || "Authentication failed." }
  }

  let finalAuth = signup.data
  const update = await requestFirebaseAuth<FirebaseAuthResponse>(
    "accounts:update",
    {
      idToken: signup.data.idToken,
      displayName: name,
      returnSecureToken: true
    }
  )

  if (update.data) {
    finalAuth = update.data
  }

  const user = toStoredUser(finalAuth, name)
  persistAuthSession(finalAuth, user)
  return { user }
}

export const loginUser = async (params: {
  email: string
  password: string
}): Promise<{ user?: StoredUser; error?: string }> => {
  const email = params.email.trim().toLowerCase()
  const password = params.password

  if (!email || !password) {
    return { error: "Email and password are required." }
  }

  const login = await requestFirebaseAuth<FirebaseAuthResponse>(
    "accounts:signInWithPassword",
    {
      email,
      password,
      returnSecureToken: true
    }
  )

  if (!login.data) {
    return { error: login.error || "Authentication failed." }
  }

  const user = toStoredUser(login.data)
  persistAuthSession(login.data, user)
  return { user }
}

export const logoutUser = () => {
  clearSession()
}
