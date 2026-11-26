import type { SavedCharacterAsset, StudioConfig } from '../types/studio';

const CONFIG_STORAGE_KEY = 'explainer_studio_browser_config_v3';

interface StoredStudioConfig {
  geminiApiKey?: string;
  nvidiaApiKey?: string;
  youtubeApiKey?: string;
  cloudinaryCloudName?: string;
  cloudinaryUploadPreset?: string;
  characterImageUrl?: string;
  savedCharacters?: SavedCharacterAsset[];
}

export function getBuildWiredDefaults(): {
  geminiApiKey: string;
  nvidiaApiKey: string;
  youtubeApiKey: string;
  cloudinaryCloudName: string;
  cloudinaryUploadPreset: string;
} {
  return {
    geminiApiKey: (import.meta.env.VITE_GEMINI_API_KEY ?? '').trim(),
    nvidiaApiKey: (import.meta.env.VITE_NVIDIA_API_KEY ?? '').trim(),
    youtubeApiKey: (import.meta.env.VITE_YOUTUBE_API_KEY ?? '').trim(),
    cloudinaryCloudName: (import.meta.env.VITE_CLOUDINARY_CLOUD_NAME ?? '').trim(),
    cloudinaryUploadPreset: (
      import.meta.env.VITE_CLOUDINARY_UPLOAD_PRESET ?? ''
    ).trim(),
  };
}

export function isAutoWiredFromBuild(): boolean {
  const wired = getBuildWiredDefaults();
  return Boolean(wired.geminiApiKey);
}

export function loadStudioConfig(): StudioConfig {
  const wired = getBuildWiredDefaults();
  let stored: StoredStudioConfig = {};

  try {
    const raw =
      window.localStorage.getItem(CONFIG_STORAGE_KEY) ||
      window.localStorage.getItem('explainer_studio_config_v2');
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
    characterImageUrl: current.characterImageUrl,
    savedCharacters: current.savedCharacters,
  };
  return saveStudioConfig(next);
}

export function getMissingConfigFields(config: StudioConfig): string[] {
  const missing: string[] = [];
  if (!config.geminiApiKey) missing.push('Gemini API Key');
  return missing;
}
