import type { SavedCharacterAsset, StudioConfig } from '../types/studio';

export const DEFAULT_REPO_OWNER = 'razabharattv-lang';
export const DEFAULT_REPO_NAME = 'funzoo-tracker';
export const DEFAULT_GITHUB_BRANCH = 'main';

const CONFIG_STORAGE_KEY = 'explainer_studio_config_v2';

interface StoredStudioConfig {
  githubToken?: string;
  repoOwner?: string;
  repoName?: string;
  githubBranch?: string;
  cloudinaryCloudName?: string;
  cloudinaryUploadPreset?: string;
  sessionCookie?: string;
  characterImageUrl?: string;
  savedCharacters?: SavedCharacterAsset[];
}

function decodeBase64Token(encoded?: string): string {
  const clean = (encoded ?? '').trim();
  if (!clean) return '';
  try {
    return window.atob(clean).trim();
  } catch {
    return '';
  }
}

export function getBuildWiredDefaults(): {
  githubToken: string;
  repoOwner: string;
  repoName: string;
  githubBranch: string;
  cloudinaryCloudName: string;
  cloudinaryUploadPreset: string;
} {
  return {
    githubToken:
      decodeBase64Token(import.meta.env.VITE_GH_PAT_B64) ||
      (import.meta.env.VITE_GITHUB_TOKEN ?? '').trim(),
    repoOwner:
      (import.meta.env.VITE_REPO_OWNER ?? DEFAULT_REPO_OWNER).trim() ||
      DEFAULT_REPO_OWNER,
    repoName:
      (import.meta.env.VITE_REPO_NAME ?? DEFAULT_REPO_NAME).trim() ||
      DEFAULT_REPO_NAME,
    githubBranch:
      (import.meta.env.VITE_GITHUB_BRANCH ?? DEFAULT_GITHUB_BRANCH).trim() ||
      DEFAULT_GITHUB_BRANCH,
    cloudinaryCloudName: (
      import.meta.env.VITE_CLOUDINARY_CLOUD_NAME ?? ''
    ).trim(),
    cloudinaryUploadPreset: (
      import.meta.env.VITE_CLOUDINARY_UPLOAD_PRESET ?? ''
    ).trim(),
  };
}

export function isAutoWiredFromBuild(): boolean {
  const wired = getBuildWiredDefaults();
  return Boolean(wired.githubToken && wired.cloudinaryCloudName);
}

export function loadStudioConfig(): StudioConfig {
  const wired = getBuildWiredDefaults();
  let stored: StoredStudioConfig = {};
  try {
    const raw =
      window.localStorage.getItem(CONFIG_STORAGE_KEY) ||
      window.localStorage.getItem('us_explainer_studio_config_v1');
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
    githubToken: (stored.githubToken || wired.githubToken || '').trim(),
    repoOwner: (stored.repoOwner || wired.repoOwner || DEFAULT_REPO_OWNER).trim(),
    repoName: (stored.repoName || wired.repoName || DEFAULT_REPO_NAME).trim(),
    githubBranch: (
      stored.githubBranch ||
      wired.githubBranch ||
      DEFAULT_GITHUB_BRANCH
    ).trim(),
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
    sessionCookie: (stored.sessionCookie ?? '').trim(),
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
    githubToken: (config.githubToken.trim() || wired.githubToken),
    repoOwner: config.repoOwner.trim() || wired.repoOwner || DEFAULT_REPO_OWNER,
    repoName: config.repoName.trim() || wired.repoName || DEFAULT_REPO_NAME,
    githubBranch:
      config.githubBranch.trim() || wired.githubBranch || DEFAULT_GITHUB_BRANCH,
    cloudinaryCloudName:
      config.cloudinaryCloudName.trim() || wired.cloudinaryCloudName,
    cloudinaryUploadPreset:
      config.cloudinaryUploadPreset.trim() || wired.cloudinaryUploadPreset,
    sessionCookie: (config.sessionCookie ?? '').trim(),
    characterImageUrl: cleanCharUrl,
    savedCharacters: nextCharacters,
  };

  try {
    // Only persist non-wired overrides & local character/cookie preferences
    const toStore: StoredStudioConfig = {
      githubToken:
        normalized.githubToken !== wired.githubToken ? normalized.githubToken : '',
      repoOwner: normalized.repoOwner,
      repoName: normalized.repoName,
      githubBranch: normalized.githubBranch,
      cloudinaryCloudName:
        normalized.cloudinaryCloudName !== wired.cloudinaryCloudName
          ? normalized.cloudinaryCloudName
          : '',
      cloudinaryUploadPreset:
        normalized.cloudinaryUploadPreset !== wired.cloudinaryUploadPreset
          ? normalized.cloudinaryUploadPreset
          : '',
      sessionCookie: normalized.sessionCookie,
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
    githubToken: wired.githubToken,
    repoOwner: wired.repoOwner,
    repoName: wired.repoName,
    githubBranch: wired.githubBranch,
    cloudinaryCloudName: wired.cloudinaryCloudName,
    cloudinaryUploadPreset: wired.cloudinaryUploadPreset,
    sessionCookie: '',
    characterImageUrl: current.characterImageUrl,
    savedCharacters: current.savedCharacters,
  };
  return saveStudioConfig(next);
}

export function getMissingConfigFields(
  config: StudioConfig,
  requireCloudinaryUpload: boolean
): string[] {
  const missing: string[] = [];
  if (!config.githubToken) missing.push('GitHub Token');
  if (!config.cloudinaryCloudName) missing.push('Cloudinary Cloud Name');
  if (requireCloudinaryUpload && !config.cloudinaryUploadPreset) {
    missing.push('Cloudinary Upload Preset');
  }
  if (!config.repoOwner) missing.push('Repo Owner');
  if (!config.repoName) missing.push('Repo Name');
  return missing;
}
