import React, { useState, useEffect, useRef } from "react"

interface QueueCommandsProps {
  onTooltipVisibilityChange: (visible: boolean, height: number) => void
  screenshots: Array<{ path: string; preview: string }>
  onChatToggle: () => void
  onSettingsToggle: () => void
  onMeetingToggle: () => void  // New prop for meeting mode
  onResourcesToggle: () => void
  onIncognitoToggle: () => void
  isIncognitoMode: boolean
  onVoiceResult?: (text: string) => void
  meetingOnly?: boolean
  onEndMeeting?: () => void
}

const QueueCommands: React.FC<QueueCommandsProps> = ({
  onTooltipVisibilityChange,
  screenshots,
  onChatToggle,
  onSettingsToggle,
  onMeetingToggle,
  onResourcesToggle,
  onIncognitoToggle,
  isIncognitoMode,
  onVoiceResult,
  meetingOnly = false,
  onEndMeeting
}) => {
  const [isTooltipVisible, setIsTooltipVisible] = useState(false)
  const tooltipRef = useRef<HTMLDivElement>(null)
  const [isRecording, setIsRecording] = useState(false)
  const [mediaRecorder, setMediaRecorder] = useState<MediaRecorder | null>(null)
  const chunks = useRef<Blob[]>([])

  useEffect(() => {
    let tooltipHeight = 0
    if (tooltipRef.current && isTooltipVisible) {
      tooltipHeight = tooltipRef.current.offsetHeight + 10
    }
    onTooltipVisibilityChange(isTooltipVisible, tooltipHeight)
  }, [isTooltipVisible, onTooltipVisibilityChange])

  const handleMouseEnter = () => {
    setIsTooltipVisible(true)
  }

  const handleMouseLeave = () => {
    setIsTooltipVisible(false)
  }

  const handleRecordClick = async () => {
    if (!isRecording) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        const recorder = new MediaRecorder(stream)
        recorder.ondataavailable = (e) => chunks.current.push(e.data)
        recorder.onstop = async () => {
          const blob = new Blob(chunks.current, { type: chunks.current[0]?.type || 'audio/webm' })
          chunks.current = []
          const reader = new FileReader()
          reader.onloadend = async () => {
            const base64Data = (reader.result as string).split(',')[1]
            console.debug('[QueueCommands] captured audio base64 length:', base64Data?.length)
            try {
              const result = await window.electronAPI.analyzeAudioFromBase64(base64Data, blob.type)
              console.debug('[QueueCommands] analyzeAudioFromBase64 result:', result)
              if (onVoiceResult) {
                onVoiceResult(result.text)
              }
            } catch (err) {
              console.error('Audio analysis failed:', err)
              if (onVoiceResult) {
                onVoiceResult('Error: Could not transcribe audio')
              }
            }
          }
          reader.readAsDataURL(blob)
          stream.getTracks().forEach(track => track.stop())
        }
        setMediaRecorder(recorder)
        recorder.start()
        setIsRecording(true)
      } catch (err) {
        console.error('Could not start recording:', err)
        if (onVoiceResult) {
          onVoiceResult('Error: Microphone access denied')
        }
      }
    } else {
      if (mediaRecorder) {
        mediaRecorder.stop()
        setIsRecording(false)
        setMediaRecorder(null)
      }
    }
  }

  return (
    <div className="w-fit">
      <div className="text-xs text-white/90 liquid-glass-bar py-1 px-4 flex items-center justify-center gap-4 draggable-area">
        {/* Show/Hide */}
        <div className="flex items-center gap-2">
          <span className="text-[11px] leading-none">Show/Hide</span>
          <div className="flex gap-1">
            <button className="bg-white/10 hover:bg-white/20 transition-colors rounded-md px-1.5 py-1 text-[11px] leading-none text-white/70">
              ⌘
            </button>
            <button className="bg-white/10 hover:bg-white/20 transition-colors rounded-md px-1.5 py-1 text-[11px] leading-none text-white/70">
              B
            </button>
          </div>
        </div>

        {meetingOnly && onEndMeeting && (
          <div className="flex items-center gap-2">
            <button
              className="bg-red-500/70 hover:bg-red-600/80 transition-colors rounded-md px-2 py-1 text-[11px] leading-none text-white"
              onClick={onEndMeeting}
              type="button"
            >
              End Meeting
            </button>
          </div>
        )}

        {/* Solve Command */}
        {!meetingOnly && screenshots.length > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-[11px] leading-none">Solve</span>
            <div className="flex gap-1">
              <button className="bg-white/10 hover:bg-white/20 transition-colors rounded-md px-1.5 py-1 text-[11px] leading-none text-white/70">
                ⌘
              </button>
              <button className="bg-white/10 hover:bg-white/20 transition-colors rounded-md px-1.5 py-1 text-[11px] leading-none text-white/70">
                ↵
              </button>
            </div>
          </div>
        )}

        {/* Voice Recording Button */}
        {!meetingOnly && (
          <div className="flex items-center gap-2">
            <button
              className={`bg-white/10 hover:bg-white/20 transition-colors rounded-md px-2 py-1 text-[11px] leading-none text-white/70 flex items-center gap-1 ${
                isRecording ? 'bg-red-500/70 hover:bg-red-500/90 animate-pulse' : ''
              }`}
              onClick={handleRecordClick}
              type="button"
            >
              {isRecording ? (
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-white animate-pulse"></span>
                  Stop Recording
                </span>
              ) : (
                <span>🎤 Voice</span>
              )}
            </button>
          </div>
        )}

        {/* Meeting Mode Button - NEW */}
        {!meetingOnly && (
          <div className="flex items-center gap-2">
            <button
              className="bg-white/10 hover:bg-white/20 transition-colors rounded-md px-2 py-1 text-[11px] leading-none text-white/70 flex items-center gap-1"
              onClick={onMeetingToggle}
              type="button"
            >
              📝 Meeting
            </button>
          </div>
        )}

        {/* Resources Button */}
        {!meetingOnly && (
          <div className="flex items-center gap-2">
            <button
              className="bg-white/10 hover:bg-white/20 transition-colors rounded-md px-2 py-1 text-[11px] leading-none text-white/70 flex items-center gap-1"
              onClick={onResourcesToggle}
              type="button"
            >
              📚 Resources
            </button>
          </div>
        )}

        {/* Incognito Mode Toggle */}
        <div className="flex items-center gap-2">
          <button
            className={`transition-colors rounded-md px-2 py-1 text-[11px] leading-none flex items-center gap-1 ${
              isIncognitoMode
                ? "bg-amber-500/80 hover:bg-amber-500 text-black"
                : "bg-white/10 hover:bg-white/20 text-white/70"
            }`}
            onClick={onIncognitoToggle}
            type="button"
            title="Toggle stealth mode (always-on-top + capture protection)"
          >
            {isIncognitoMode ? "🕶 Incognito ON" : "🕶 Incognito"}
          </button>
        </div>

        {/* Chat Button */}
        {!meetingOnly && (
          <div className="flex items-center gap-2">
            <button
              className="bg-white/10 hover:bg-white/20 transition-colors rounded-md px-2 py-1 text-[11px] leading-none text-white/70 flex items-center gap-1"
              onClick={onChatToggle}
              type="button"
            >
              💬 Chat
            </button>
          </div>
        )}

        {/* Settings Button */}
        {!meetingOnly && (
          <div className="flex items-center gap-2">
            <button
              className="bg-white/10 hover:bg-white/20 transition-colors rounded-md px-2 py-1 text-[11px] leading-none text-white/70 flex items-center gap-1"
              onClick={onSettingsToggle}
              type="button"
            >
              ⚙️ Models
            </button>
          </div>
        )}

        {/* Question mark with tooltip */}
        {!meetingOnly && (
          <div
            className="relative inline-block"
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
          >
            <div className="w-6 h-6 rounded-full bg-white/10 hover:bg-white/20 backdrop-blur-sm transition-colors flex items-center justify-center cursor-help z-10">
              <span className="text-xs text-white/70">?</span>
            </div>

            {isTooltipVisible && (
              <div
                ref={tooltipRef}
                className="absolute top-full right-0 mt-2 w-80"
              >
                <div className="p-3 text-xs bg-black/80 backdrop-blur-md rounded-lg border border-white/10 text-white/90 shadow-lg">
                  <div className="space-y-4">
                    <h3 className="font-medium truncate">Keyboard Shortcuts</h3>
                    <div className="space-y-3">
                    {/* Toggle Command */}
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="truncate">Toggle Window</span>
                        <div className="flex gap-1 flex-shrink-0">
                          <span className="bg-white/10 px-1.5 py-0.5 rounded text-[10px] leading-none">
                            ⌘
                          </span>
                          <span className="bg-white/10 px-1.5 py-0.5 rounded text-[10px] leading-none">
                            B
                          </span>
                        </div>
                      </div>
                      <p className="text-[10px] leading-relaxed text-white/70 truncate">
                        Show or hide this window.
                      </p>
                    </div>

                    {/* Screenshot Command */}
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="truncate">Take Screenshot</span>
                        <div className="flex gap-1 flex-shrink-0">
                          <span className="bg-white/10 px-1.5 py-0.5 rounded text-[10px] leading-none">
                            ⌘
                          </span>
                          <span className="bg-white/10 px-1.5 py-0.5 rounded text-[10px] leading-none">
                            H
                          </span>
                        </div>
                      </div>
                      <p className="text-[10px] leading-relaxed text-white/70 truncate">
                        Take a screenshot of the problem description.
                      </p>
                    </div>

                    {/* Solve Command */}
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="truncate">Solve Problem</span>
                        <div className="flex gap-1 flex-shrink-0">
                          <span className="bg-white/10 px-1.5 py-0.5 rounded text-[10px] leading-none">
                            ⌘
                          </span>
                          <span className="bg-white/10 px-1.5 py-0.5 rounded text-[10px] leading-none">
                            ↵
                          </span>
                        </div>
                      </div>
                      <p className="text-[10px] leading-relaxed text-white/70 truncate">
                        Generate a solution based on the current problem.
                      </p>
                    </div>

                    {/* Voice Command */}
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="truncate">Voice Input</span>
                        <div className="flex gap-1 flex-shrink-0">
                          <span className="bg-white/10 px-1.5 py-0.5 rounded text-[10px] leading-none">
                            🎤
                          </span>
                        </div>
                      </div>
                      <p className="text-[10px] leading-relaxed text-white/70 truncate">
                        Ask coding questions hands-free.
                      </p>
                    </div>

                    {/* Meeting Mode - NEW */}
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="truncate">Meeting Mode</span>
                        <div className="flex gap-1 flex-shrink-0">
                          <span className="bg-white/10 px-1.5 py-0.5 rounded text-[10px] leading-none">
                            📝
                          </span>
                        </div>
                      </div>
                      <p className="text-[10px] leading-relaxed text-white/70 truncate">
                        Record meetings with live notes, summaries, and mind maps.
                      </p>
                    </div>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

      </div>
    </div>
  )
}

export default QueueCommands
