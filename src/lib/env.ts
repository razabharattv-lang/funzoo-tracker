export interface BuildRuntimeEnv {
  geminiApiKey: string;
  nvidiaApiKey: string;
  youtubeApiKey: string;
}

/**
 * Reads optional GitHub Pages build-time secrets (when deployed statically without Express).
 * On full-stack Express deployments, server-side `/api/*` routes use `process.env` directly.
 */
export function getBuildRuntimeEnv(): BuildRuntimeEnv {
  return {
    geminiApiKey: (import.meta.env.VITE_GEMINI_API_KEY ?? '').trim(),
    nvidiaApiKey: (import.meta.env.VITE_NVIDIA_API_KEY ?? '').trim(),
    youtubeApiKey: (import.meta.env.VITE_YOUTUBE_API_KEY ?? '').trim(),
  };
}
