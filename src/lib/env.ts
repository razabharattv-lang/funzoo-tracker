export interface BuildRuntimeEnv {
  geminiApiKey: string;
  nvidiaApiKey: string;
  youtubeApiKey: string;
  cloudinaryCloudName: string;
  cloudinaryUploadPreset: string;
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

function pickClientEnv(
  envObj: Record<string, unknown> | undefined,
  viteKey: string,
  fallbackKey: string
): string {
  return (
    sanitizeEnvKey(envObj?.[viteKey]) ||
    sanitizeEnvKey(envObj?.[fallbackKey])
  );
}

/**
 * Reads optional GitHub Pages build-time client keys (when deployed statically without Express).
 * Server/workflow-only secrets (`GH_PAT`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`) are never read here.
 */
export function getBuildRuntimeEnv(): BuildRuntimeEnv {
  const envObj = import.meta.env as Record<string, unknown> | undefined;
  return {
    geminiApiKey: pickClientEnv(envObj, 'VITE_GEMINI_API_KEY', 'GEMINI_API_KEY'),
    nvidiaApiKey: pickClientEnv(envObj, 'VITE_NVIDIA_API_KEY', 'NVIDIA_API_KEY'),
    youtubeApiKey: pickClientEnv(envObj, 'VITE_YOUTUBE_API_KEY', 'YOUTUBE_API_KEY'),
    cloudinaryCloudName: pickClientEnv(
      envObj,
      'VITE_CLOUDINARY_CLOUD_NAME',
      'CLOUDINARY_CLOUD_NAME'
    ),
    cloudinaryUploadPreset: pickClientEnv(
      envObj,
      'VITE_CLOUDINARY_UPLOAD_PRESET',
      'CLOUDINARY_UPLOAD_PRESET'
    ),
  };
}
