// src/components/chat/FormattedResponse.tsx
import React from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { dracula } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { parseLLMResponse, ParsedLLMResponse } from '../../utils/lmResponseParser';

interface FormattedResponseProps {
  content: string;
  className?: string;
}

export const FormattedResponse: React.FC<FormattedResponseProps> = ({ content, className = '' }) => {
  const parsed = parseLLMResponse(content);

  return (
    <div className={`formatted-response space-y-3 ${className}`}>
      {/* Display thoughts/analysis if available */}
      {parsed.metadata?.thoughts && parsed.metadata.thoughts.length > 0 && (
        <div className="thoughts-section">
          <h3 className="text-xs font-semibold text-white mb-2">Analysis:</h3>
          <div className="space-y-1.5">
            {parsed.metadata.thoughts.map((thought, index) => (
              <div key={index} className="flex items-start gap-2 text-xs text-gray-100">
                <div className="w-1 h-1 rounded-full bg-blue-400/80 mt-1.5 shrink-0" />
                <div className="leading-relaxed text-black">{thought}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Display code with syntax highlighting */}
      {parsed.type === 'code' && (
        <div className="code-section">
          <SyntaxHighlighter
            language={parsed.language || 'python'}
            style={dracula}
            customStyle={{
              margin: 0,
              padding: '0.75rem',
              borderRadius: '0.375rem',
              fontSize: '0.75rem',
              lineHeight: '1.5',
              maxWidth: '100%',
              backgroundColor: '#282a36'
            }}
            showLineNumbers
            wrapLongLines
          >
            {parsed.content}
          </SyntaxHighlighter>
        </div>
      )}

      {/* Display structured solution */}
      {parsed.type === 'structured' && (
        <div className="solution-section">
          <h3 className="text-xs font-semibold text-white mb-2">Solution:</h3>
          <SyntaxHighlighter
            language={parsed.language || 'python'}
            style={dracula}
            customStyle={{
              margin: 0,
              padding: '0.75rem',
              borderRadius: '0.375rem',
              fontSize: '0.75rem',
              lineHeight: '1.5',
              maxWidth: '100%',
              backgroundColor: '#282a36'
            }}
            showLineNumbers
            wrapLongLines
          >
            {parsed.content}
          </SyntaxHighlighter>
        </div>
      )}

      {/* Display plain text */}
      {parsed.type === 'text' && (
        <div className="text-section">
          <div className="text-xs text-black leading-relaxed whitespace-pre-wrap">
            {parsed.content}
          </div>
        </div>
      )}

      {/* Display complexity information */}
      {parsed.metadata?.complexity && (parsed.metadata.complexity.time || parsed.metadata.complexity.space) && (
        <div className="complexity-section mt-3 pt-3 border-t border-gray-700/50">
          <h3 className="text-xs font-semibold text-white mb-2">Complexity:</h3>
          <div className="space-y-1">
            {parsed.metadata.complexity.time && (
              <div className="flex items-center gap-2 text-xs text-gray-100">
                <div className="w-1 h-1 rounded-full bg-blue-400/80 shrink-0" />
                <div>
                  <strong>Time:</strong> {parsed.metadata.complexity.time}
                </div>
              </div>
            )}
            {parsed.metadata.complexity.space && (
              <div className="flex items-center gap-2 text-xs text-gray-100">
                <div className="w-1 h-1 rounded-full bg-blue-400/80 shrink-0" />
                <div>
                  <strong>Space:</strong> {parsed.metadata.complexity.space}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default FormattedResponse;