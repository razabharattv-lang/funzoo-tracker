export interface BuildRuntimeEnv {
  geminiApiKey: string;
  nvidiaApiKey: string;
  youtubeApiKey: string;
}

function sanitizeEnvKey(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (
    !trimmed ||
    trimmed === 'undefined' ||
    trimmed === 'null' ||
    /^<[^>]+>$/.test(trimmed)
  ) {
    return '';
  }
  return trimmed;
}

/**
 * Reads optional GitHub Pages build-time secrets (when deployed statically without Express).
 * On full-stack Express deployments, server-side `/api/*` routes use `process.env` directly.
 */
export function getBuildRuntimeEnv(): BuildRuntimeEnv {
  return {
    geminiApiKey: sanitizeEnvKey(import.meta.env?.VITE_GEMINI_API_KEY),
    nvidiaApiKey: sanitizeEnvKey(import.meta.env?.VITE_NVIDIA_API_KEY),
    youtubeApiKey: sanitizeEnvKey(import.meta.env?.VITE_YOUTUBE_API_KEY),
  };
}
