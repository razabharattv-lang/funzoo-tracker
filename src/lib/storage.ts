import type { SavedRenderRecord } from '../types/studio';

const STORAGE_KEY = 'explainer_studio_renders_v4';

function getSafeStorage(): Storage | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

export function loadSavedRenders(): SavedRenderRecord[] {
  try {
    const storage = getSafeStorage();
    if (!storage) return [];
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return (parsed as SavedRenderRecord[]).filter(
      (item) =>
        item &&
        typeof item.runTag === 'string' &&
        Array.isArray(item.clips) &&
        item.clips.length > 0
    );
  } catch {
    return [];
  }
}

export function saveRenderRecord(
  record: SavedRenderRecord
): SavedRenderRecord[] {
  const sanitizedRecord: SavedRenderRecord = {
    ...record,
    clips: record.clips.map((clip) => ({
      ...clip,
      // Do not persist ephemeral blob: URLs across sessions
      videoUrl: clip.videoUrl.startsWith('blob:') ? '' : clip.videoUrl,
    })),
  };
  const existing = loadSavedRenders().filter(
    (item) => item.runTag !== sanitizedRecord.runTag
  );
  const next = [sanitizedRecord, ...existing].slice(0, 20);
  try {
    const storage = getSafeStorage();
    storage?.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore storage quota / privacy errors
  }
  return next;
}

export function deleteRenderRecord(runTag: string): SavedRenderRecord[] {
  const next = loadSavedRenders().filter((item) => item.runTag !== runTag);
  try {
    const storage = getSafeStorage();
    storage?.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore storage quota / privacy errors
  }
  return next;
}
