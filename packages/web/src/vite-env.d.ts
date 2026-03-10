/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CP_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare const __BUILD_SHA__: string;
declare const __BUILD_BRANCH__: string;
