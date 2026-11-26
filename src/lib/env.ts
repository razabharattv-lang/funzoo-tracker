import type { CloudEnvConfig } from '../types/studio';

export const DEFAULT_REPO_OWNER = 'razabharattv-lang';
export const DEFAULT_REPO_NAME = 'funzoo-tracker';
export const DEFAULT_GITHUB_BRANCH = 'main';

const CONFIG_STORAGE_KEY = 'us_explainer_studio_config_v1';

interface StoredStudioConfig {
  githubToken?: string;
  repoOwner?: string;
  repoName?: string;
  githubBranch?: string;
  cloudinaryCloudName?: string;
  cloudinaryUploadPreset?: string;
}

export function loadStudioConfig(): CloudEnvConfig {
  let stored: StoredStudioConfig = {};
  try {
    const raw = window.localStorage.getItem(CONFIG_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object') {
        stored = parsed as StoredStudioConfig;
      }
    }
  } catch {
    stored = {};
  }

  return {
    githubToken: (stored.githubToken ?? import.meta.env.VITE_GITHUB_TOKEN ?? '').trim(),
    repoOwner:
      (stored.repoOwner ?? import.meta.env.VITE_REPO_OWNER ?? DEFAULT_REPO_OWNER).trim() ||
      DEFAULT_REPO_OWNER,
    repoName:
      (stored.repoName ?? import.meta.env.VITE_REPO_NAME ?? DEFAULT_REPO_NAME).trim() ||
      DEFAULT_REPO_NAME,
    githubBranch:
      (stored.githubBranch ?? import.meta.env.VITE_GITHUB_BRANCH ?? DEFAULT_GITHUB_BRANCH).trim() ||
      DEFAULT_GITHUB_BRANCH,
    cloudinaryCloudName: (
      stored.cloudinaryCloudName ??
      import.meta.env.VITE_CLOUDINARY_CLOUD_NAME ??
      ''
    ).trim(),
    cloudinaryUploadPreset: (
      stored.cloudinaryUploadPreset ??
      import.meta.env.VITE_CLOUDINARY_UPLOAD_PRESET ??
      ''
    ).trim(),
  };
}

export function saveStudioConfig(config: CloudEnvConfig): CloudEnvConfig {
  const normalized: CloudEnvConfig = {
    githubToken: config.githubToken.trim(),
    repoOwner: config.repoOwner.trim() || DEFAULT_REPO_OWNER,
    repoName: config.repoName.trim() || DEFAULT_REPO_NAME,
    githubBranch: config.githubBranch.trim() || DEFAULT_GITHUB_BRANCH,
    cloudinaryCloudName: config.cloudinaryCloudName.trim(),
    cloudinaryUploadPreset: config.cloudinaryUploadPreset.trim(),
  };

  try {
    window.localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // Ignore storage quota errors
  }

  return normalized;
}

export function clearStudioConfig(): CloudEnvConfig {
  try {
    window.localStorage.removeItem(CONFIG_STORAGE_KEY);
  } catch {
    // Ignore storage errors
  }
  return {
    githubToken: '',
    repoOwner: DEFAULT_REPO_OWNER,
    repoName: DEFAULT_REPO_NAME,
    githubBranch: DEFAULT_GITHUB_BRANCH,
    cloudinaryCloudName: '',
    cloudinaryUploadPreset: '',
  };
}

export function getMissingConfigFields(config: CloudEnvConfig): string[] {
  const missing: string[] = [];
  if (!config.githubToken) missing.push('GitHub Token');
  if (!config.cloudinaryCloudName) missing.push('Cloudinary Cloud Name');
  if (!config.cloudinaryUploadPreset) missing.push('Cloudinary Upload Preset');
  if (!config.repoOwner) missing.push('Repo Owner');
  if (!config.repoName) missing.push('Repo Name');
  return missing;
}
