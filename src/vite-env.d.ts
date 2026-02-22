/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_DB_URL?: string
  readonly VITE_SUPABASE_URL?: string
  readonly VITE_SUPABASE_ANON_KEY?: string
  readonly VITE_UPSTASH_VECTOR_REST_URL?: string
  readonly VITE_UPSTASH_VECTOR_REST_TOKEN?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
