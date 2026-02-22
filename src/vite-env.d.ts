/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_DB_URL?: string
  readonly VITE_SUPABASE_URL?: string
  readonly VITE_SUPABASE_ANON_KEY?: string
  readonly VITE_UPSTASH_VECTOR_REST_URL?: string
  readonly VITE_UPSTASH_VECTOR_REST_TOKEN?: string
  readonly VITE_STT_PROVIDER?: string
  readonly VITE_STT_PROVIDER_CHAIN?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

interface PuterSpeechSegment {
  speaker?: string
  text?: string
}

interface PuterSpeechToTextResult {
  text?: string
  transcript?: string
  segments?: PuterSpeechSegment[]
}

interface PuterGlobal {
  ai?: {
    speech2txt: (
      input:
        | string
        | Blob
        | {
            file: string | Blob
            translate?: boolean
            model?: string
            response_format?: string
            chunking_strategy?: string
            timestamp_granularities?: string[]
          },
      options?: {
        model?: string
        translate?: boolean
        response_format?: string
        chunking_strategy?: string
        timestamp_granularities?: string[]
      }
    ) => Promise<string | PuterSpeechToTextResult>
  }
}

interface Window {
  puter?: PuterGlobal
}
