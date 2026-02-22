import React, { useEffect, useState } from "react"

interface ModelConfig {
  provider: "groq"
  model: string
  isOllama?: boolean
}

interface RuntimeSecretsStatus {
  groqApiKeyConfigured: boolean
  elevenLabsApiKeyConfigured: boolean
}

interface ModelSelectorProps {
  onModelChange?: (provider: "groq", model: string) => void
  onChatOpen?: () => void
}

const ModelSelector: React.FC<ModelSelectorProps> = ({ onModelChange, onChatOpen }) => {
  const [currentConfig, setCurrentConfig] = useState<ModelConfig | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [connectionStatus, setConnectionStatus] = useState<
    "testing" | "success" | "error" | null
  >(null)
  const [errorMessage, setErrorMessage] = useState("")
  const [groqApiKey, setGroqApiKey] = useState("")
  const [elevenLabsApiKey, setElevenLabsApiKey] = useState("")
  const [savedSecretsStatus, setSavedSecretsStatus] = useState<RuntimeSecretsStatus | null>(null)

  useEffect(() => {
    loadCurrentConfig()
  }, [])

  const loadCurrentConfig = async () => {
    try {
      setIsLoading(true)
      const config = await window.electronAPI.getCurrentLlmConfig()
      setCurrentConfig({
        provider: "groq",
        model: config.model || "llama-3.3-70b-versatile",
        isOllama: false
      })
      const status = await window.electronAPI.getRuntimeSecretsStatus()
      setSavedSecretsStatus(status)
    } catch (error) {
      console.error("Error loading current config:", error)
    } finally {
      setIsLoading(false)
    }
  }

  const testConnection = async () => {
    try {
      setConnectionStatus("testing")
      const result = await window.electronAPI.testLlmConnection()
      setConnectionStatus(result.success ? "success" : "error")
      if (!result.success) {
        setErrorMessage(result.error || "Unknown error")
      }
    } catch (error) {
      setConnectionStatus("error")
      setErrorMessage(String(error))
    }
  }

  const handleProviderSwitch = async () => {
    try {
      setConnectionStatus("testing")
      const hasGroqInput = groqApiKey.trim().length > 0
      const hasElevenLabsInput = elevenLabsApiKey.trim().length > 0

      if (hasGroqInput || hasElevenLabsInput) {
        const saved = await window.electronAPI.setRuntimeSecrets({
          ...(hasGroqInput ? { groqApiKey: groqApiKey.trim() } : {}),
          ...(hasElevenLabsInput ? { elevenLabsApiKey: elevenLabsApiKey.trim() } : {})
        })
        if (!saved.success) {
          setConnectionStatus("error")
          setErrorMessage(saved.error || "Failed to save API keys")
          return
        }
      }

      const result = await window.electronAPI.switchToGroq(groqApiKey || undefined)

      if (result.success) {
        await loadCurrentConfig()
        setGroqApiKey("")
        setElevenLabsApiKey("")
        setConnectionStatus("success")
        onModelChange?.("groq", "llama-3.3-70b-versatile")
        setTimeout(() => {
          onChatOpen?.()
        }, 500)
      } else {
        setConnectionStatus("error")
        setErrorMessage(result.error || "Switch failed")
      }
    } catch (error) {
      setConnectionStatus("error")
      setErrorMessage(String(error))
    }
  }

  const getStatusColor = () => {
    switch (connectionStatus) {
      case "testing":
        return "text-yellow-600"
      case "success":
        return "text-green-600"
      case "error":
        return "text-red-600"
      default:
        return "text-gray-600"
    }
  }

  const getStatusText = () => {
    switch (connectionStatus) {
      case "testing":
        return "Testing connection..."
      case "success":
        return "Connected successfully"
      case "error":
        return `Error: ${errorMessage}`
      default:
        return "Ready"
    }
  }

  if (isLoading) {
    return (
      <div className="p-4 bg-white/20 backdrop-blur-md rounded-lg border border-white/30">
        <div className="animate-pulse text-sm text-gray-600">Loading model configuration...</div>
      </div>
    )
  }

  return (
    <div className="p-4 bg-white/20 backdrop-blur-md rounded-lg border border-white/30 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-800">AI Model Selection</h3>
        <div className={`text-xs ${getStatusColor()}`}>{getStatusText()}</div>
      </div>

      {currentConfig && (
        <div className="text-xs text-gray-600 bg-white/40 p-2 rounded">
          Current: ☁️ {currentConfig.model}
        </div>
      )}

      {savedSecretsStatus && (
        <div className="text-xs text-gray-600 bg-white/30 p-2 rounded">
          Stored keys: Groq {savedSecretsStatus.groqApiKeyConfigured ? "Yes" : "No"} | ElevenLabs{" "}
          {savedSecretsStatus.elevenLabsApiKeyConfigured ? "Yes" : "No"}
        </div>
      )}

      <div className="space-y-2">
        <label className="text-xs font-medium text-gray-700">
          Groq API Key (optional if already set)
        </label>
        <input
          type="password"
          placeholder="Enter API key to update..."
          value={groqApiKey}
          onChange={event => setGroqApiKey(event.target.value)}
          className="w-full px-3 py-2 text-xs bg-white/40 border border-white/60 rounded focus:outline-none focus:ring-2 focus:ring-blue-400/60"
        />

        <label className="text-xs font-medium text-gray-700">
          ElevenLabs API Key (for meeting STT, optional)
        </label>
        <input
          type="password"
          placeholder="Enter ElevenLabs key to save locally..."
          value={elevenLabsApiKey}
          onChange={event => setElevenLabsApiKey(event.target.value)}
          className="w-full px-3 py-2 text-xs bg-white/40 border border-white/60 rounded focus:outline-none focus:ring-2 focus:ring-blue-400/60"
        />
      </div>

      <div className="flex gap-2 pt-2">
        <button
          onClick={handleProviderSwitch}
          disabled={connectionStatus === "testing"}
          className="flex-1 px-3 py-2 bg-blue-500 hover:bg-blue-600 disabled:bg-gray-400 text-white text-xs rounded transition-all shadow-md"
        >
          {connectionStatus === "testing" ? "Switching..." : "Apply Changes"}
        </button>

        <button
          onClick={testConnection}
          disabled={connectionStatus === "testing"}
          className="px-3 py-2 bg-gray-500 hover:bg-gray-600 disabled:bg-gray-400 text-white text-xs rounded transition-all shadow-md"
        >
          Test
        </button>
      </div>

      <div className="text-xs text-gray-600 space-y-1">
        <div>
          💡 <strong>Cloud API mode:</strong> All answers use remote inference (no local model).
        </div>
        <div>
          💡 API keys are stored locally on this device for packaged `.exe` runs.
        </div>
      </div>
    </div>
  )
}

export default ModelSelector
