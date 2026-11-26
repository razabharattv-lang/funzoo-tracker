import type { SavedRenderRecord } from '../types/studio';

const STORAGE_KEY = 'us_explainer_studio_renders_v1';

export function loadSavedRenders(): SavedRenderRecord[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as SavedRenderRecord[]) : [];
  } catch {
    return [];
  }
}

export function saveRenderRecord(record: SavedRenderRecord): SavedRenderRecord[] {
  const existing = loadSavedRenders().filter(
    (item) => item.manifest.job_id !== record.manifest.job_id
  );
  const next = [record, ...existing].slice(0, 25);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore quota errors
  }
  return next;
}

export function deleteRenderRecord(jobId: string): SavedRenderRecord[] {
  const next = loadSavedRenders().filter((item) => item.manifest.job_id !== jobId);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore quota errors
  }
  return next;
}
