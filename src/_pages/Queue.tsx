// src/_pages/Queue.tsx - WITH MULTIPLE RESPONSE MODES
import React, { useState, useEffect, useRef } from "react"
import { useQuery } from "react-query"
import ScreenshotQueue from "../components/Queue/ScreenshotQueue"
import {
  Toast,
  ToastTitle,
  ToastDescription,
  ToastVariant,
  ToastMessage
} from "../components/ui/toast"
import QueueCommands from "../components/Queue/QueueCommands"
import ModelSelector from "../components/ui/ModelSelector"
import ChatMessage from "../components/chat/ChatMessage"
import { cleanLLMResponse } from "../utils/lmResponseParser"
import MeetingMode from "../components/ui/MeetingMode"
import Resources from "./Resources"
import { RuntimeMeeting } from "../lib/meetingsStore"

interface QueueProps {
  setView: React.Dispatch<React.SetStateAction<"dashboard" | "queue" | "solutions" | "workspace" | "debug">>
  mode?: "full" | "meeting"
  onExitToDashboard?: () => void
  onMeetingSaved?: (meeting: RuntimeMeeting) => Promise<void> | void
}

interface ChatMessageType {
  role: "user" | "gemini" | "system";
  text: string;
  timestamp: number;
  canRegenerate?: boolean;
  originalPrompt?: string;
  id?: string;
}

type ResponseMode = "code-only" | "theory-only" | "balanced" | "detailed";

const Queue: React.FC<QueueProps> = ({
  setView,
  mode = "full",
  onExitToDashboard,
  onMeetingSaved
}) => {
  const isMeetingOnlyMode = mode === "meeting"
  const [toastOpen, setToastOpen] = useState(false)
  const [toastMessage, setToastMessage] = useState<ToastMessage>({
    title: "",
    description: "",
    variant: "neutral"
  })

  const [isTooltipVisible, setIsTooltipVisible] = useState(false)
  const [tooltipHeight, setTooltipHeight] = useState(0)
  const contentRef = useRef<HTMLDivElement>(null)

  const [chatInput, setChatInput] = useState("")
  const [chatMessages, setChatMessages] = useState<ChatMessageType[]>([])
  const [chatLoading, setChatLoading] = useState(false)
  const [isChatOpen, setIsChatOpen] = useState(false)
  const chatInputRef = useRef<HTMLInputElement>(null)
  const chatScrollRef = useRef<HTMLDivElement>(null)
  
  // Context continuation
  const [contextMessage, setContextMessage] = useState<string>("")
  const [hoveredMessageId, setHoveredMessageId] = useState<string | null>(null)
  const [isMeetingOpen, setIsMeetingOpen] = useState(isMeetingOnlyMode)
  const [meetingEndRequestToken, setMeetingEndRequestToken] = useState(0)
  const [isResourcesOpen, setIsResourcesOpen] = useState(false)
  const [isIncognitoMode, setIsIncognitoMode] = useState(false)
  const [lockWindowResize, setLockWindowResize] = useState(false)

  // Abort controller
  const abortControllerRef = useRef<AbortController | null>(null)
  const [lastUserPrompt, setLastUserPrompt] = useState<string>("")
  
  // Response mode (NEW!)
  const [responseMode, setResponseMode] = useState<ResponseMode>("balanced")
  
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [currentModel, setCurrentModel] = useState<{ provider: string; model: string }>({
    provider: "groq",
    model: "llama-3.3-70b-versatile"
  })

  const barRef = useRef<HTMLDivElement>(null)

  const { data: screenshots = [], refetch } = useQuery<Array<{ path: string; preview: string }>, Error>(
    ["screenshots"],
    async () => {
      try {
        const existing = await window.electronAPI.getScreenshots()
        return existing
      } catch (error) {
        console.error("Error loading screenshots:", error)
        showToast("Error", "Failed to load existing screenshots", "error")
        return []
      }
    },
    {
      staleTime: Infinity,
      cacheTime: Infinity,
      refetchOnWindowFocus: true,
      refetchOnMount: true
    }
  )

  const showToast = (
    title: string,
    description: string,
    variant: ToastVariant
  ) => {
    setToastMessage({ title, description, variant })
    setToastOpen(true)
  }

  const handleDeleteScreenshot = async (index: number) => {
    const screenshotToDelete = screenshots[index]

    try {
      const response = await window.electronAPI.deleteScreenshot(
        screenshotToDelete.path
      )

      if (response.success) {
        refetch()
      } else {
        console.error("Failed to delete screenshot:", response.error)
        showToast("Error", "Failed to delete the screenshot file", "error")
      }
    } catch (error) {
      console.error("Error deleting screenshot:", error)
    }
  }

  const handleStopGeneration = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null
      setChatLoading(false)
      
      const systemMessage: ChatMessageType = {
        role: "system",
        text: "⏹️ Generation stopped",
        timestamp: Date.now(),
        id: Date.now().toString()
      };
      setChatMessages((msgs) => [...msgs, systemMessage])
      
      showToast("Stopped", "Response cancelled", "neutral")
    }
  }

  const handleRegenerate = async () => {
    if (!lastUserPrompt) {
      showToast("Error", "No previous prompt", "error")
      return
    }

    setChatMessages((msgs) => {
      const lastMsg = msgs[msgs.length - 1]
      if (lastMsg.role === "gemini") {
        return msgs.slice(0, -1)
      }
      return msgs
    })

    setTimeout(() => {
      handleChatSend(lastUserPrompt, false, true)
    }, 100)
  }

  const handleCopyForFollowUp = (messageText: string) => {
    setContextMessage(messageText)
    showToast("Context Added", "Previous response added to context", "neutral")
    chatInputRef.current?.focus()
  }

  const handleClearContext = () => {
    setContextMessage("")
    showToast("Context Cleared", "Starting fresh conversation", "neutral")
  }

  const closeMeetingMode = () => {
    setIsMeetingOpen(false)
    if (isMeetingOnlyMode) {
      onExitToDashboard?.()
    }
  }

  const handleEndMeeting = () => {
    if (!isMeetingOpen) {
      onExitToDashboard?.()
      return
    }
    setMeetingEndRequestToken(prev => prev + 1)
  }

  const handleMeetingToggle = () => {
    setIsMeetingOpen(prev => {
      const next = !prev
      if (next) {
        setIsResourcesOpen(false)
      } else if (isMeetingOnlyMode) {
        onExitToDashboard?.()
      }
      return next
    })
  }

  const handleResourcesToggle = () => {
    if (isMeetingOnlyMode) return
    setIsResourcesOpen(prev => {
      const next = !prev
      if (next) {
        setIsMeetingOpen(false)
      }
      return next
    })
  }

  const handleIncognitoToggle = async () => {
    try {
      const result = await window.electronAPI.toggleIncognitoMode()
      const enabled = Boolean(result.enabled)
      setIsIncognitoMode(enabled)
      showToast(
        enabled ? "Incognito On" : "Incognito Off",
        enabled
          ? "Stealth mode ON: always on top and harder to capture in screenshots."
          : "Stealth mode OFF: normal window layering and screenshot capture allowed.",
        "neutral"
      )
    } catch (error) {
      console.error("Failed to toggle incognito mode:", error)
      showToast("Error", "Unable to toggle incognito mode.", "error")
    }
  }

  useEffect(() => {
    // Keep resize lock only for resources overlay; meeting mode should resize with content.
    setLockWindowResize(isResourcesOpen)
  }, [isResourcesOpen])

  useEffect(() => {
    if (isMeetingOnlyMode) {
      setIsMeetingOpen(true)
      setIsResourcesOpen(false)
      setIsChatOpen(false)
      setIsSettingsOpen(false)
    }
  }, [isMeetingOnlyMode])

  const handleChatSend = async (
    userInput?: string, 
    _isVoiceInput = false,
    isRegenerate = false
  ) => {
    const inputText = userInput || chatInput;
    if (!inputText.trim()) return
    
    setLastUserPrompt(inputText)

    if (!isRegenerate) {
      const userMessage: ChatMessageType = {
        role: "user",
        text: inputText,
        timestamp: Date.now(),
        id: Date.now().toString()
      };
      setChatMessages((msgs) => [...msgs, userMessage])
    }
    
    setChatLoading(true)
    if (!userInput) setChatInput("")
    
    abortControllerRef.current = new AbortController()
    
    try {
      const enhancedPrompt = buildModeBasedPrompt(inputText, responseMode, contextMessage);
      
      const response = await window.electronAPI.invoke(
        "gemini-chat", 
        enhancedPrompt,
        { signal: abortControllerRef.current.signal }
      )
      
      if (abortControllerRef.current.signal.aborted) {
        return
      }
      
      const cleanedResponse = cleanLLMResponse(response)
      
      const assistantMessage: ChatMessageType = {
        role: "gemini",
        text: cleanedResponse,
        timestamp: Date.now(),
        canRegenerate: true,
        originalPrompt: inputText,
        id: Date.now().toString()
      };
      
      setChatMessages((msgs) => [...msgs, assistantMessage])
      
      if (contextMessage) {
        setContextMessage("")
      }
    } catch (err: any) {
      if (err.name === 'AbortError' || abortControllerRef.current?.signal.aborted) {
        console.log('Request cancelled')
        return
      }
      
      const errorMessage: ChatMessageType = {
        role: "gemini",
        text: "Error: " + (err.message || "Please try again"),
        timestamp: Date.now(),
        id: Date.now().toString()
      };
      setChatMessages((msgs) => [...msgs, errorMessage])
    } finally {
      setChatLoading(false)
      abortControllerRef.current = null
      chatInputRef.current?.focus()
    }
  }

  // BUILD PROMPTS FOR DIFFERENT MODES
  const buildModeBasedPrompt = (userInput: string, mode: ResponseMode, context: string): string => {
    const contextSection = context 
      ? `\n\nPREVIOUS CONTEXT:\n${context}\n\nNow answer this follow-up:\n`
      : "\n\n";

    switch(mode) {
      case "code-only":
        return `You are a coding expert. Provide ONLY CODE with minimal explanation.
${contextSection}
Question: ${userInput}

RULES:
- Focus on code solutions
- Include 2-3 code examples
- Brief 1-line comments only
- No theory or lengthy explanations
- Show different approaches if applicable

Format:
\`\`\`language
// Brief comment
code here
\`\`\`

Be direct and code-focused.`;

      case "theory-only":
        return `You are a computer science educator. Provide ONLY THEORY with NO CODE.
${contextSection}
Question: ${userInput}

RULES:
- Pure conceptual explanation
- No code examples
- Focus on theory, principles, and concepts
- Use analogies and clear definitions
- Explain the "why" behind things

Format:
1. Definition
2. Key principles (3-4 points)
3. How it works conceptually
4. When/why to use it
5. Related concepts

NO CODE BLOCKS. Theory only.`;

      case "balanced":
        return `You are a coding expert. Provide balanced code + theory.
${contextSection}
Question: ${userInput}

Include:
1. Brief definition (1-2 sentences)
2. 2 code examples (basic + practical)
3. Key concept explanation
4. One common mistake

Format code as:
\`\`\`javascript
// code
\`\`\`

Balance theory and practice. Be concise.`;

      case "detailed":
        return `You are a comprehensive technical instructor. Provide detailed explanation with examples.
${contextSection}
Question: ${userInput}

Include:
1. Clear definition with context
2. Why it matters (3-4 points)
3. How it works internally
4. 3-4 code examples (basic → advanced)
5. Common pitfalls (2-3 with code)
6. Comparison with alternatives
7. Interview tips

Format:
## Section Headers
* Bullet points
\`\`\`language
// well-commented code
\`\`\`

Be thorough and educational.`;

      default:
        return buildModeBasedPrompt(userInput, "balanced", context);
    }
  }

  // Get mode description
  const getModeDescription = (mode: ResponseMode): string => {
    switch(mode) {
      case "code-only": return "Just code, minimal theory";
      case "theory-only": return "Pure concepts, no code";
      case "balanced": return "Quick mix of code + theory";
      case "detailed": return "Deep dive with everything";
      default: return "";
    }
  }

  // Get mode timing
  const getModeTiming = (mode: ResponseMode): string => {
    switch(mode) {
      case "code-only": return "~2-3 sec";
      case "theory-only": return "~3-4 sec";
      case "balanced": return "~3-5 sec";
      case "detailed": return "~8-12 sec";
      default: return "";
    }
  }

  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight
    }
  }, [chatMessages, chatLoading])

  useEffect(() => {
    const loadCurrentModel = async () => {
      try {
        const config = await window.electronAPI.getCurrentLlmConfig();
        setCurrentModel({ provider: config.provider, model: config.model });
      } catch (error) {
        console.error('Error loading model config:', error);
      }
    };
    loadCurrentModel();
  }, []);

  useEffect(() => {
    let isMounted = true

    const loadIncognitoMode = async () => {
      try {
        const state = await window.electronAPI.getIncognitoMode()
        if (isMounted) {
          setIsIncognitoMode(Boolean(state.enabled))
        }
      } catch (error) {
        console.error("Error loading incognito mode:", error)
      }
    }

    loadIncognitoMode()

    const unsubscribe = window.electronAPI.onIncognitoModeChanged((enabled: boolean) => {
      if (isMounted) {
        setIsIncognitoMode(Boolean(enabled))
      }
    })

    return () => {
      isMounted = false
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    const updateDimensions = () => {
      if (contentRef.current) {
        let contentHeight = contentRef.current.scrollHeight
        const contentWidth = contentRef.current.scrollWidth
        if (isTooltipVisible) {
          contentHeight += tooltipHeight
        }
      if (!lockWindowResize) {
  window.electronAPI.updateContentDimensions({
    width: contentWidth,
    height: contentHeight
  })
}

      }
    }

const resizeObserver = new ResizeObserver(() => {
  if (lockWindowResize) return
  updateDimensions()
})
    if (contentRef.current) {
      resizeObserver.observe(contentRef.current)
    }
    updateDimensions()

    const cleanupFunctions = [
      window.electronAPI.onScreenshotTaken(() => refetch()),
      window.electronAPI.onResetView(() => refetch()),
      window.electronAPI.onSolutionError((error: string) => {
        showToast("Error", "Processing failed", "error")
        setView("queue")
        console.error("Processing error:", error)
      }),
      window.electronAPI.onProcessingNoScreenshots(() => {
        showToast("No Screenshots", "No screenshots to process", "neutral")
      })
    ]

    return () => {
      resizeObserver.disconnect()
      cleanupFunctions.forEach((cleanup) => cleanup())
    }
  }, [isTooltipVisible, tooltipHeight, refetch, setView, lockWindowResize])

  useEffect(() => {
    if (isMeetingOnlyMode) {
      return
    }

    const unsubscribe = window.electronAPI.onScreenshotTaken(async (data) => {
      await refetch();
      
      if (!isChatOpen) {
        setIsChatOpen(true);
      }
      
      setChatLoading(true);
      
      try {
        const latest = data?.path || (Array.isArray(data) && data.length > 0 && data[data.length - 1]?.path);
        if (latest) {
          const systemMessage: ChatMessageType = {
            role: "user",
            text: "📸 Analyzing...",
            timestamp: Date.now(),
            id: Date.now().toString()
          };
          setChatMessages((msgs) => [...msgs, systemMessage]);
          
          const response = await window.electronAPI.invoke("analyze-image-file", latest);
          const cleanedResponse = cleanLLMResponse(response.text || response);
          
          const assistantMessage: ChatMessageType = {
            role: "gemini",
            text: cleanedResponse,
            timestamp: Date.now(),
            id: Date.now().toString()
          };
          
          setChatMessages((msgs) => [...msgs, assistantMessage]);
        }
      } catch (err) {
        const errorMessage: ChatMessageType = {
          role: "gemini",
          text: `Error: ${String(err)}`,
          timestamp: Date.now(),
          id: Date.now().toString()
        };
        setChatMessages((msgs) => [...msgs, errorMessage]);
      } finally {
        setChatLoading(false);
      }
    });
    
    return () => {
      unsubscribe && unsubscribe();
    };
  }, [refetch, isChatOpen, isMeetingOnlyMode]);

  const handleTooltipVisibilityChange = (visible: boolean, height: number) => {
    setIsTooltipVisible(visible)
    setTooltipHeight(height)
  }

  const handleChatToggle = () => {
    if (isMeetingOnlyMode) return
    setIsChatOpen(!isChatOpen)
  }

  const handleSettingsToggle = () => {
    if (isMeetingOnlyMode) return
    setIsSettingsOpen(!isSettingsOpen)
  }

  const handleModelChange = (provider: "ollama" | "groq", model: string) => {
    setCurrentModel({ provider, model })
    const modelName = model || "Groq"
    
    const systemMessage: ChatMessageType = {
      role: "system",
      text: `🔄 ☁️ ${modelName} active`,
      timestamp: Date.now(),
      id: Date.now().toString()
    };
    
    setChatMessages((msgs) => [...msgs, systemMessage])
  }

  const handleVoiceResult = async (transcribedText: string) => {
    if (isMeetingOnlyMode) return
    if (!isChatOpen) {
      setIsChatOpen(true);
    }

    const userMessage: ChatMessageType = {
      role: "user",
      text: `🎤 ${transcribedText}`,
      timestamp: Date.now(),
      id: Date.now().toString()
    };
    setChatMessages((msgs) => [...msgs, userMessage]);

    await handleChatSend(transcribedText, true);
  };

  return (
    <div>
    <div
      ref={barRef}

      className="select-none"
    >
      <div className="bg-transparent w-full">
        <div className="px-2 py-1">
          <Toast
            open={toastOpen}
            onOpenChange={setToastOpen}
            variant={toastMessage.variant}
            duration={3000}
          >
            <ToastTitle>{toastMessage.title}</ToastTitle>
            <ToastDescription>{toastMessage.description}</ToastDescription>
          </Toast>
          
          <div className="w-fit">
           <QueueCommands
  screenshots={screenshots}
  onTooltipVisibilityChange={handleTooltipVisibilityChange}
  onChatToggle={handleChatToggle}
  onSettingsToggle={handleSettingsToggle}
  onMeetingToggle={handleMeetingToggle}  // ADD THIS LINE
  onResourcesToggle={handleResourcesToggle}
  onIncognitoToggle={handleIncognitoToggle}
  isIncognitoMode={isIncognitoMode}
  onVoiceResult={handleVoiceResult}
  meetingOnly={isMeetingOnlyMode}
  onEndMeeting={handleEndMeeting}
/>
          </div>

       
          {!isMeetingOnlyMode && isSettingsOpen && (
            <div className="mt-4 w-full mx-auto">
              <ModelSelector onModelChange={handleModelChange} onChatOpen={() => setIsChatOpen(true)} />
            </div>
          )}
          
          {/* Chat Interface with Multiple Modes */}
          {!isMeetingOnlyMode && isChatOpen && (
            <div className="mt-4 w-full mx-auto liquid-glass chat-container p-4 flex flex-col">
              {/* Mode Selector Bar */}
              <div className="mb-3 flex gap-2 items-center justify-between flex-wrap">
                <div className="flex gap-1">
                  <button
                    onClick={() => setResponseMode("code-only")}
                    className={`px-2 py-1 text-[9px] rounded transition-all ${
                      responseMode === "code-only"
                        ? "bg-purple-500/80 text-white shadow-md"
                        : "bg-white/20 text-gray-300 hover:bg-white/30"
                    }`}
                    title="Code only, minimal theory (2-3 sec)"
                  >
                    💻 Code
                  </button>
                  <button
                    onClick={() => setResponseMode("theory-only")}
                    className={`px-2 py-1 text-[9px] rounded transition-all ${
                      responseMode === "theory-only"
                        ? "bg-blue-500/80 text-white shadow-md"
                        : "bg-white/20 text-gray-300 hover:bg-white/30"
                    }`}
                    title="Theory only, no code (3-4 sec)"
                  >
                    📖 Theory
                  </button>
                  <button
                    onClick={() => setResponseMode("balanced")}
                    className={`px-2 py-1 text-[9px] rounded transition-all ${
                      responseMode === "balanced"
                        ? "bg-green-500/80 text-white shadow-md"
                        : "bg-white/20 text-gray-300 hover:bg-white/30"
                    }`}
                    title="Balanced code + theory (3-5 sec)"
                  >
                    ⚖️ Balanced
                  </button>
                  <button
                    onClick={() => setResponseMode("detailed")}
                    className={`px-2 py-1 text-[9px] rounded transition-all ${
                      responseMode === "detailed"
                        ? "bg-orange-500/80 text-white shadow-md"
                        : "bg-white/20 text-gray-300 hover:bg-white/30"
                    }`}
                    title="Detailed everything (8-12 sec)"
                  >
                    📚 Detailed
                  </button>
                </div>
                
                <div className="flex gap-2">
                  {chatLoading && (
                    <button
                      onClick={handleStopGeneration}
                      className="px-2 py-1 bg-red-500/80 hover:bg-red-600/80 text-white text-[9px] rounded flex items-center gap-1"
                    >
                      ⏹️ Stop
                    </button>
                  )}
                  {!chatLoading && lastUserPrompt && (
                    <button
                      onClick={handleRegenerate}
                      className="px-2 py-1 bg-blue-500/80 hover:bg-blue-600/80 text-white text-[9px] rounded flex items-center gap-1"
                    >
                      🔄 Retry
                    </button>
                  )}
                </div>
              </div>

              {/* Mode Info */}
              <div className="mb-3 px-2 py-1 bg-white/10 rounded text-[9px] text-gray-300 text-center">
                {getModeDescription(responseMode)} • {getModeTiming(responseMode)}
              </div>
              
              {/* Context Indicator */}
              {contextMessage && (
                <div className="mb-3 p-2 bg-blue-500/20 border border-blue-500/40 rounded-lg">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1">
                      <div className="text-[10px] text-blue-300 font-semibold mb-1">
                        📎 Context Active
                      </div>
                      <div className="text-[9px] text-gray-300 line-clamp-2">
                        {contextMessage.substring(0, 150)}...
                      </div>
                    </div>
                    <button
                      onClick={handleClearContext}
                      className="px-2 py-1 bg-red-500/80 hover:bg-red-600/80 text-white text-[9px] rounded"
                    >
                      Clear
                    </button>
                  </div>
                </div>
              )}
              
              <div 
                ref={chatScrollRef}
                className="flex-1 overflow-y-auto mb-3 p-3 rounded-lg bg-white/10 backdrop-blur-md max-h-96 min-h-[120px] glass-content border border-white/20 shadow-lg"
              >
                {chatMessages.length === 0 ? (
                  <div className="text-sm text-gray-600 text-center mt-8">
                    💬 Multi-Mode Coach - ☁️ {currentModel.model}
                    <br />
                    <span className="text-xs text-gray-500">Choose your learning style above</span>
                    <br />
                    <span className="text-xs text-gray-500">💻 Code-focused • 📖 Theory-focused • ⚖️ Balanced • 📚 Comprehensive</span>
                  </div>
                ) : (
                  <>
                    {chatMessages.map((msg, idx) => (
                      <div
                        key={msg.id || idx}
                        className="relative group"
                        onMouseEnter={() => setHoveredMessageId(msg.id || null)}
                        onMouseLeave={() => setHoveredMessageId(null)}
                      >
                        <ChatMessage
                          role={msg.role === "system" ? "gemini" : msg.role}
                          text={msg.text}
                          timestamp={msg.timestamp}
                        />
                        
                        {msg.role === "gemini" && msg.id && hoveredMessageId === msg.id && (
                          <button
                            onClick={() => handleCopyForFollowUp(msg.text)}
                            className="absolute top-2 right-2 px-2 py-1 bg-blue-500/80 hover:bg-blue-600/80 text-white text-[9px] rounded opacity-0 group-hover:opacity-100 transition-all shadow-md flex items-center gap-1"
                          >
                            ⚡ Follow-up
                          </button>
                        )}
                      </div>
                    ))}
                    {chatLoading && <ChatMessage role="gemini" text="" isLoading={true} />}
                  </>
                )}
              </div>
              
              <form
                className="flex gap-2 items-center glass-content"
                onSubmit={e => {
                  e.preventDefault();
                  handleChatSend();
                }}
              >
                <input
                  ref={chatInputRef}
                  className="flex-1 rounded-lg px-3 py-2 bg-white/25 backdrop-blur-md text-gray-800 placeholder-gray-500 text-xs focus:outline-none focus:ring-1 focus:ring-gray-400/60 border border-white/40 shadow-lg transition-all duration-200"
                  placeholder={contextMessage ? "Ask follow-up..." : `Ask in ${responseMode} mode...`}
                  value={chatInput}
                  onChange={e => setChatInput(e.target.value)}
                  disabled={chatLoading}
                />
                <button
                  type="submit"
                  className="p-2 rounded-lg bg-gray-600/80 hover:bg-gray-700/80 border border-gray-500/60 flex items-center justify-center transition-all duration-200 backdrop-blur-sm shadow-lg disabled:opacity-50"
                  disabled={chatLoading || !chatInput.trim()}
                  tabIndex={-1}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="white" className="w-4 h-4">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 19.5l15-7.5-15-7.5v6l10 1.5-10 1.5v6z" />
                  </svg>
                </button>
              </form>
            </div>
          )}
        </div>
      </div>
      
    </div>
{isMeetingOpen &&
  (isMeetingOnlyMode ? (
    <div className="mt-3 flex w-full justify-center">
      <MeetingMode
        onClose={closeMeetingMode}
        onMeetingSaved={onMeetingSaved}
        endRequestToken={meetingEndRequestToken}
        compact={true}
      />
    </div>
  ) : (
    <div className="mt-3 flex w-full justify-center rounded-2xl border border-white/15 bg-black/50 p-4 backdrop-blur-sm">
      <MeetingMode
        onClose={closeMeetingMode}
        onMeetingSaved={onMeetingSaved}
        endRequestToken={meetingEndRequestToken}
        compact={false}
      />
    </div>
  ))}
       {!isMeetingOnlyMode && isResourcesOpen && (
  <div className="mt-3 w-full rounded-2xl border border-white/15 bg-black/50 p-4 backdrop-blur-sm">
    <Resources onClose={() => setIsResourcesOpen(false)} />
  </div>
)}
    </div>
  )
}

export default Queue
