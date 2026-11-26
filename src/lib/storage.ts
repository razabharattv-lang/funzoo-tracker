import type { SavedRenderRecord } from '../types/studio';

const STORAGE_KEY = 'explainer_studio_renders_v4';

export function loadSavedRenders(): SavedRenderRecord[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
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
  const existing = loadSavedRenders().filter(
    (item) => item.runTag !== record.runTag
  );
  const next = [record, ...existing].slice(0, 20);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore storage quota errors
  }
  return next;
}

export function deleteRenderRecord(runTag: string): SavedRenderRecord[] {
  const next = loadSavedRenders().filter((item) => item.runTag !== runTag);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore storage quota errors
  }
  return next;
}
