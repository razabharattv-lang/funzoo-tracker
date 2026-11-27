declare global {
  interface ImportMetaEnv {
    readonly VITE_GEMINI_API_KEY?: string;
    readonly VITE_YOUTUBE_API_KEY?: string;
    readonly VITE_NVIDIA_API_KEY?: string;
    readonly VITE_CLOUDINARY_CLOUD_NAME?: string;
    readonly VITE_CLOUDINARY_UPLOAD_PRESET?: string;
  }
}

export interface BuildRuntimeEnv {
  geminiApiKey: string;
  nvidiaApiKey: string;
  youtubeApiKey: string;
  cloudinaryCloudName: string;
  cloudinaryUploadPreset: string;
}

export function normalizeEnvKey(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (
    !trimmed ||
    trimmed === 'undefined' ||
    trimmed === 'null' ||
    /^<[^>]+>$/.test(trimmed) ||
    /^\$\{\{[^}]+\}\}$/.test(trimmed)
  ) {
    return '';
  }
  return trimmed;
}

export function pickNormalizedEnvKey(...candidates: unknown[]): string {
  for (const candidate of candidates) {
    const normalized = normalizeEnvKey(candidate);
    if (normalized) return normalized;
  }
  return '';
}

/**
 * Reads optional GitHub Pages build-time client keys (when deployed statically without Express).
 * Uses direct static `import.meta.env.VITE_*` properties so Vite `define` replacement reliably
 * inlines keys at build time. Server/workflow-only secrets (`GH_PAT`, `CLOUDINARY_API_KEY`,
 * `CLOUDINARY_API_SECRET`) are never read here.
 */
export function getBuildRuntimeEnv(): BuildRuntimeEnv {
  return {
    geminiApiKey: pickNormalizedEnvKey(import.meta.env.VITE_GEMINI_API_KEY),
    nvidiaApiKey: pickNormalizedEnvKey(import.meta.env.VITE_NVIDIA_API_KEY),
    youtubeApiKey: pickNormalizedEnvKey(import.meta.env.VITE_YOUTUBE_API_KEY),
    cloudinaryCloudName: pickNormalizedEnvKey(
      import.meta.env.VITE_CLOUDINARY_CLOUD_NAME
    ),
    cloudinaryUploadPreset: pickNormalizedEnvKey(
      import.meta.env.VITE_CLOUDINARY_UPLOAD_PRESET
    ),
  };
}
