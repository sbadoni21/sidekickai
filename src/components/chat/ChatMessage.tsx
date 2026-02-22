// src/components/chat/ChatMessage.tsx
import React from 'react';
import FormattedResponse from './FormattedResponse';

interface ChatMessageProps {
  role: 'user' | 'gemini' | 'assistant';
  text: string;
  timestamp?: number;
  isLoading?: boolean;
}

export const ChatMessage: React.FC<ChatMessageProps> = ({ 
  role, 
  text, 
  timestamp,
  isLoading = false 
}) => {
  const isUser = role === 'user';
  const isAssistant = role === 'gemini' || role === 'assistant';

  if (isLoading) {
    return (
      <div className="flex justify-start mb-3">
        <div className="bg-white/85 text-gray-600 px-3 py-1.5 rounded-xl text-xs backdrop-blur-sm border border-gray-200/50 shadow-md mr-12">
          <span className="inline-flex items-center gap-1">
            <span className="animate-pulse text-gray-400">●</span>
            <span className="animate-pulse animation-delay-200 text-gray-400">●</span>
            <span className="animate-pulse animation-delay-400 text-gray-400">●</span>
            <span className="ml-2">Thinking...</span>
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className={`w-full flex ${isUser ? 'justify-end' : 'justify-start'} mb-3`}>
      <div
        className={`max-w-[85%] px-3 py-2 rounded-xl shadow-md backdrop-blur-sm border ${
          isUser
            ? 'bg-gray-700/80 text-gray-100 ml-12 border-gray-600/40'
            : 'bg-white/90 text-gray-800 mr-12 border-gray-200/50'
        }`}
      >
        {/* Display formatted response for assistant messages */}
        {isAssistant ? (
          <FormattedResponse content={text} />
        ) : (
          <div className="text-xs leading-relaxed whitespace-pre-wrap">
            {text}
          </div>
        )}
        
        {/* Optional timestamp */}
        {timestamp && (
          <div className={`text-[10px] mt-1 ${isUser ? 'text-gray-400' : 'text-gray-500'}`}>
            {new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </div>
        )}
      </div>
    </div>
  );
};

export default ChatMessage;