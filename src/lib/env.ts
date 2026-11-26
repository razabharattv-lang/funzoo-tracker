import type { SavedCharacterAsset, StudioConfig } from '../types/studio';

const CONFIG_STORAGE_KEY = 'explainer_studio_browser_config_v6';

interface StoredStudioConfig {
  geminiApiKey?: string;
  nvidiaApiKey?: string;
  youtubeApiKey?: string;
  cloudinaryCloudName?: string;
  cloudinaryUploadPreset?: string;
  externalGpuEndpoint?: string;
  externalGpuKey?: string;
  characterImageUrl?: string;
  savedCharacters?: SavedCharacterAsset[];
}

export function getBuildWiredDefaults(): {
  geminiApiKey: string;
  nvidiaApiKey: string;
  youtubeApiKey: string;
  cloudinaryCloudName: string;
  cloudinaryUploadPreset: string;
  externalGpuEndpoint: string;
  externalGpuKey: string;
} {
  return {
    geminiApiKey: (import.meta.env.VITE_GEMINI_API_KEY ?? '').trim(),
    nvidiaApiKey: (import.meta.env.VITE_NVIDIA_API_KEY ?? '').trim(),
    youtubeApiKey: (import.meta.env.VITE_YOUTUBE_API_KEY ?? '').trim(),
    cloudinaryCloudName: (
      import.meta.env.VITE_CLOUDINARY_CLOUD_NAME ?? ''
    ).trim(),
    cloudinaryUploadPreset: (
      import.meta.env.VITE_CLOUDINARY_UPLOAD_PRESET ?? ''
    ).trim(),
    externalGpuEndpoint: (
      import.meta.env.VITE_EXTERNAL_GPU_ENDPOINT ?? ''
    ).trim(),
    externalGpuKey: (import.meta.env.VITE_EXTERNAL_GPU_KEY ?? '').trim(),
  };
}

export function isAutoWiredFromBuild(): boolean {
  const wired = getBuildWiredDefaults();
  return Boolean(
    wired.geminiApiKey ||
      wired.nvidiaApiKey ||
      wired.youtubeApiKey ||
      wired.cloudinaryCloudName ||
      wired.externalGpuEndpoint
  );
}

export function hasExternalGpuConfigured(config: StudioConfig): boolean {
  const ep = config.externalGpuEndpoint.trim();
  return ep.startsWith('http://') || ep.startsWith('https://');
}

export function loadStudioConfig(): StudioConfig {
  const wired = getBuildWiredDefaults();
  let stored: StoredStudioConfig = {};

  try {
    const raw =
      window.localStorage.getItem(CONFIG_STORAGE_KEY) ||
      window.localStorage.getItem('explainer_studio_browser_config_v5') ||
      window.localStorage.getItem('explainer_studio_browser_config_v4') ||
      window.localStorage.getItem('explainer_studio_browser_config_v3');
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object') {
        stored = parsed as StoredStudioConfig;
      }
    }
  } catch {
    stored = {};
  }

  let savedCharacters = Array.isArray(stored.savedCharacters)
    ? stored.savedCharacters.filter(
        (c) => c && typeof c.id === 'string' && typeof c.url === 'string'
      )
    : [];

  const characterImageUrl = (
    stored.characterImageUrl ??
    savedCharacters[0]?.url ??
    ''
  ).trim();

  if (
    characterImageUrl &&
    !savedCharacters.some((c) => c.url === characterImageUrl)
  ) {
    savedCharacters = [
      {
        id: 'char_config_default',
        name: 'Default Portrait',
        url: characterImageUrl,
        publicId: '',
        uploadedAt: new Date().toISOString(),
      },
      ...savedCharacters,
    ].slice(0, 8);
  }

  return {
    geminiApiKey: (stored.geminiApiKey || wired.geminiApiKey || '').trim(),
    nvidiaApiKey: (stored.nvidiaApiKey || wired.nvidiaApiKey || '').trim(),
    youtubeApiKey: (stored.youtubeApiKey || wired.youtubeApiKey || '').trim(),
    cloudinaryCloudName: (
      stored.cloudinaryCloudName ||
      wired.cloudinaryCloudName ||
      ''
    ).trim(),
    cloudinaryUploadPreset: (
      stored.cloudinaryUploadPreset ||
      wired.cloudinaryUploadPreset ||
      ''
    ).trim(),
    externalGpuEndpoint: (
      stored.externalGpuEndpoint ||
      wired.externalGpuEndpoint ||
      ''
    ).trim(),
    externalGpuKey: (
      stored.externalGpuKey ||
      wired.externalGpuKey ||
      ''
    ).trim(),
    characterImageUrl,
    savedCharacters,
  };
}

export function saveStudioConfig(config: StudioConfig): StudioConfig {
  const wired = getBuildWiredDefaults();
  const cleanCharUrl = (config.characterImageUrl ?? '').trim();
  let nextCharacters = [...config.savedCharacters];

  if (cleanCharUrl && !nextCharacters.some((c) => c.url === cleanCharUrl)) {
    nextCharacters = [
      {
        id: `char_${Date.now()}`,
        name: 'Saved Portrait',
        url: cleanCharUrl,
        publicId: '',
        uploadedAt: new Date().toISOString(),
      },
      ...nextCharacters,
    ].slice(0, 8);
  }

  const normalized: StudioConfig = {
    geminiApiKey: config.geminiApiKey.trim() || wired.geminiApiKey,
    nvidiaApiKey: config.nvidiaApiKey.trim() || wired.nvidiaApiKey,
    youtubeApiKey: config.youtubeApiKey.trim() || wired.youtubeApiKey,
    cloudinaryCloudName:
      config.cloudinaryCloudName.trim() || wired.cloudinaryCloudName,
    cloudinaryUploadPreset:
      config.cloudinaryUploadPreset.trim() || wired.cloudinaryUploadPreset,
    externalGpuEndpoint:
      config.externalGpuEndpoint.trim().replace(/\/+$/, '') ||
      wired.externalGpuEndpoint.replace(/\/+$/, ''),
    externalGpuKey: config.externalGpuKey.trim() || wired.externalGpuKey,
    characterImageUrl: cleanCharUrl,
    savedCharacters: nextCharacters,
  };

  try {
    const toStore: StoredStudioConfig = {
      geminiApiKey:
        normalized.geminiApiKey !== wired.geminiApiKey
          ? normalized.geminiApiKey
          : '',
      nvidiaApiKey:
        normalized.nvidiaApiKey !== wired.nvidiaApiKey
          ? normalized.nvidiaApiKey
          : '',
      youtubeApiKey:
        normalized.youtubeApiKey !== wired.youtubeApiKey
          ? normalized.youtubeApiKey
          : '',
      cloudinaryCloudName:
        normalized.cloudinaryCloudName !== wired.cloudinaryCloudName
          ? normalized.cloudinaryCloudName
          : '',
      cloudinaryUploadPreset:
        normalized.cloudinaryUploadPreset !== wired.cloudinaryUploadPreset
          ? normalized.cloudinaryUploadPreset
          : '',
      externalGpuEndpoint:
        normalized.externalGpuEndpoint !== wired.externalGpuEndpoint
          ? normalized.externalGpuEndpoint
          : '',
      externalGpuKey:
        normalized.externalGpuKey !== wired.externalGpuKey
          ? normalized.externalGpuKey
          : '',
      characterImageUrl: normalized.characterImageUrl,
      savedCharacters: normalized.savedCharacters,
    };
    window.localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(toStore));
  } catch {
    // Ignore storage quota errors
  }

  return normalized;
}

export function clearStudioKeysOnly(current: StudioConfig): StudioConfig {
  const wired = getBuildWiredDefaults();
  const next: StudioConfig = {
    geminiApiKey: wired.geminiApiKey,
    nvidiaApiKey: wired.nvidiaApiKey,
    youtubeApiKey: wired.youtubeApiKey,
    cloudinaryCloudName: wired.cloudinaryCloudName,
    cloudinaryUploadPreset: wired.cloudinaryUploadPreset,
    externalGpuEndpoint: wired.externalGpuEndpoint,
    externalGpuKey: wired.externalGpuKey,
    characterImageUrl: current.characterImageUrl,
    savedCharacters: current.savedCharacters,
  };
  return saveStudioConfig(next);
}

export function getMissingConfigFields(_config: StudioConfig): string[] {
  return [];
}
