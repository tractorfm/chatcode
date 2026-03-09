/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CP_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
