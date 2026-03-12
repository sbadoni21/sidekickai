// src/utils/llmResponseParser.ts

export interface ParsedLLMResponse {
  type: 'text' | 'code' | 'structured';
  content: string;
  language?: string;
  metadata?: {
    thoughts?: string[];
    complexity?: {
      time?: string;
      space?: string;
    };
  };
}

/**
 * Attempts to parse LLM response which might be JSON, markdown, or plain text
 */
export function parseLLMResponse(response: string): ParsedLLMResponse {
  if (!response || typeof response !== 'string') {
    return {
      type: 'text',
      content: 'No response received'
    };
  }

  // Try to parse as JSON first
  try {
    const parsed = JSON.parse(response);
    
    // If it's a structured response with code
    if (parsed.code || parsed.solution) {
      return {
        type: 'structured',
        content: parsed.code || parsed.solution,
        language: detectLanguage(parsed.code || parsed.solution),
        metadata: {
          thoughts: parsed.thoughts || parsed.analysis || parsed.explanation,
          complexity: {
            time: parsed.time_complexity || parsed.timeComplexity,
            space: parsed.space_complexity || parsed.spaceComplexity
          }
        }
      };
    }

    // If it's just JSON data, format it nicely
    return {
      type: 'text',
      content: formatJSON(parsed)
    };
  } catch {
    // Not JSON, continue with other parsing methods
  }

  // Check if response contains code blocks
  const codeBlockMatch = response.match(/```(\w+)?\n([\s\S]+?)```/);
  if (codeBlockMatch) {
    const code = codeBlockMatch[2].trim();
    const language = codeBlockMatch[1] || detectLanguage(code);
    
    // Extract any text before the code block as thoughts
    const textBefore = response.substring(0, response.indexOf('```')).trim();
    
    return {
      type: 'code',
      content: code,
      language,
      metadata: {
        thoughts: textBefore ? [textBefore] : undefined
      }
    };
  }

  // Check if it looks like code (no markdown formatting)
  if (looksLikeCode(response)) {
    return {
      type: 'code',
      content: response.trim(),
      language: detectLanguage(response)
    };
  }

  // Plain text response
  return {
    type: 'text',
    content: response.trim()
  };
}

/**
 * Formats JSON object as readable text
 */
function formatJSON(obj: any): string {
  if (typeof obj === 'string') return obj;
  
  const lines: string[] = [];
  
  function processObject(data: any, prefix = ''): void {
    if (Array.isArray(data)) {
      data.forEach((item, index) => {
        if (typeof item === 'object') {
          lines.push(`${prefix}${index + 1}.`);
          processObject(item, prefix + '  ');
        } else {
          lines.push(`${prefix}• ${item}`);
        }
      });
    } else if (typeof data === 'object' && data !== null) {
      Object.entries(data).forEach(([key, value]) => {
        const label = key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
        
        if (typeof value === 'object' && value !== null) {
          lines.push(`${prefix}${label}:`);
          processObject(value, prefix + '  ');
        } else {
          lines.push(`${prefix}${label}: ${value}`);
        }
      });
    } else {
      lines.push(`${prefix}${data}`);
    }
  }
  
  processObject(obj);
  return lines.join('\n');
}

/**
 * Detects if text looks like code
 */
function looksLikeCode(text: string): boolean {
  const codeIndicators = [
    /^(def|class|function|const|let|var|import|from|public|private|fun|val|SELECT|INSERT|UPDATE|DELETE|<\?php|func|object|case class)\s/m,
    /[{}\[\]();]/,
    /^\s{2,}/m, // Indentation
    /(=>|===|!==|\|\||&&|::|->|<-)/,
  ];
  
  const matches = codeIndicators.filter(pattern => pattern.test(text));
  return matches.length >= 2;
}

/**
 * Detects programming language from code content
 */
function detectLanguage(code: string): string {
  if (!code) return 'python';
  
  if (/^\s*<\?php/.test(code) || /\$\w+\s*=/.test(code) || /\becho\b/.test(code)) {
    return 'php';
  }
  if (/^\s*def\s+\w+[!?=]?\s*(\(|$)/m.test(code) || /\bputs\b/.test(code) || /^\s*end\s*$/m.test(code)) {
    return 'ruby';
  }
  if (/^\s*fun\s+\w+\s*\(/m.test(code) || /^\s*(val|var)\s+\w+\s*[:=]/m.test(code) || /println\s*\(/.test(code)) {
    return 'kotlin';
  }
  if (/^\s*func\s+\w+\s*\(/m.test(code) || /import\s+Foundation/.test(code) || /\bguard\b/.test(code)) {
    return 'swift';
  }
  if (/^\s*object\s+\w+/m.test(code) || /^\s*case\s+class\s+\w+/m.test(code) || /println\s*\(/.test(code) && /=>/.test(code)) {
    return 'scala';
  }
  if (/^\s*void\s+main\s*\(/m.test(code) || /import\s+'package:/.test(code) || /\bfinal\s+\w+\s*=/.test(code)) {
    return 'dart';
  }
  if (/^\s*(SELECT|INSERT|UPDATE|DELETE|WITH|CREATE|ALTER|DROP)\b/im.test(code) || /\bFROM\b/i.test(code) && /\bWHERE\b/i.test(code)) {
    return 'sql';
  }
  if (/^\s*(def|class)\s+\w+.*:\s*$/m.test(code) || /^\s*(import|from)\s+\w+/m.test(code) || /^\s*(if|for|while|with|try)\b.*:\s*$/m.test(code)) {
    return 'python';
  }
  if (/^(function|const|let|var|=>)/.test(code) || /^(export|import)/.test(code)) {
    return 'javascript';
  }
  if (/^(public|private|class)\s/.test(code) && /<.*>/.test(code)) {
    return 'java';
  }
  if (/^(fn|let|mut|impl|struct)/.test(code)) {
    return 'rust';
  }
  
  return 'python'; // Default
}

/**
 * Extracts sections from markdown-style text
 */
export function extractSections(text: string): {
  analysis?: string[];
  solution?: string;
  complexity?: { time?: string; space?: string };
} {
  const sections: any = {};
  
  // Extract Analysis/Thoughts section
  const analysisMatch = text.match(/(?:Analysis|Thoughts|Approach):\s*\n((?:[-•]\s*.+\n?)+)/i);
  if (analysisMatch) {
    sections.analysis = analysisMatch[1]
      .split('\n')
      .filter(line => line.trim())
      .map(line => line.replace(/^[-•]\s*/, '').trim());
  }
  
  // Extract complexity
  const timeMatch = text.match(/Time Complexity:\s*(.+)/i);
  const spaceMatch = text.match(/Space Complexity:\s*(.+)/i);
  if (timeMatch || spaceMatch) {
    sections.complexity = {
      time: timeMatch?.[1].trim(),
      space: spaceMatch?.[1].trim()
    };
  }
  
  return sections;
}

/**
 * Cleans up common LLM response artifacts
 */
export function cleanLLMResponse(text: string): string {
  return text
    .replace(/^["']|["']$/g, '') // Remove surrounding quotes
    .replace(/\\n/g, '\n') // Fix escaped newlines
    .replace(/\\t/g, '  ') // Fix escaped tabs
    .replace(/\n{3,}/g, '\n\n') // Remove excessive newlines
    .trim();
}
