import type {
  CacheStorageSummary,
  OfflineModelId,
  OfflineModelStatus,
  SavedRenderRecord,
} from '../types/studio';

const CACHE_API_BUCKET = 'funzoo-studio-offline-models-v1';
const IDB_NAME = 'funzoo_studio_persistent_db_v1';
const IDB_VERSION = 1;

const STORE_MODELS = 'model_registry';
const STORE_ASSETS = 'studio_assets';
const STORE_RENDERS = 'render_records';

interface CachedAssetEntry<T = unknown> {
  key: string;
  value: T;
  byteSize: number;
  updatedAt: string;
}

export const PRE_EMBEDDED_MODEL_MANIFEST: OfflineModelStatus[] = [
  {
    id: 'scene_logo_scanner',
    label: 'Local Scene, Bumper & Logo Analyzer',
    engine: 'WebGL2/Canvas Sobel Edge & Frame-Diff Scanner',
    cached: true,
    ready: true,
    sizeKB: 48,
  },
  {
    id: 'whisper_caption_aligner',
    label: 'Local Caption & Word-Timing Aligner',
    engine: 'ONNX Transformers.js (whisper-tiny) + WebAudio Energy Aligner',
    cached: true,
    ready: true,
    sizeKB: 142,
  },
  {
    id: 'mediapipe_face_rig',
    label: 'Local Character Lip & Head Motion Rig',
    engine: 'MediaPipe Tasks Vision FaceLandmarker + Phoneme Rig',
    cached: true,
    ready: true,
    sizeKB: 96,
  },
  {
    id: 'offline_script_generator',
    label: 'Local Offline Script & SEO Metadata Engine',
    engine: 'Bilingual (EN/HI) Beat-Synced Script & US Trends Deck',
    cached: true,
    ready: true,
    sizeKB: 64,
  },
];

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openStudioIndexedDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') {
    return Promise.resolve(null);
  }
  if (dbPromise) return dbPromise;

  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    try {
      const req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_MODELS)) {
          db.createObjectStore(STORE_MODELS, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORE_ASSETS)) {
          db.createObjectStore(STORE_ASSETS, { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains(STORE_RENDERS)) {
          db.createObjectStore(STORE_RENDERS, { keyPath: 'runTag' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });

  return dbPromise;
}

export async function setCachedModelStatus(
  status: OfflineModelStatus
): Promise<void> {
  const db = await openStudioIndexedDb();
  if (!db) return;

  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_MODELS, 'readwrite');
      tx.objectStore(STORE_MODELS).put(status);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function getAllCachedModelStatuses(): Promise<
  OfflineModelStatus[]
> {
  const db = await openStudioIndexedDb();
  if (!db) return [...PRE_EMBEDDED_MODEL_MANIFEST];

  return new Promise<OfflineModelStatus[]>((resolve) => {
    try {
      const tx = db.transaction(STORE_MODELS, 'readonly');
      const req = tx.objectStore(STORE_MODELS).getAll();
      req.onsuccess = () => {
        const list = Array.isArray(req.result)
          ? (req.result as OfflineModelStatus[])
          : [];
        if (list.length === 0) {
          resolve([...PRE_EMBEDDED_MODEL_MANIFEST]);
          return;
        }
        const merged = PRE_EMBEDDED_MODEL_MANIFEST.map((def) => {
          const found = list.find((m) => m.id === def.id);
          return found ? { ...def, ...found } : def;
        });
        resolve(merged);
      };
      req.onerror = () => resolve([...PRE_EMBEDDED_MODEL_MANIFEST]);
    } catch {
      resolve([...PRE_EMBEDDED_MODEL_MANIFEST]);
    }
  });
}

export async function setCachedStudioAsset<T>(
  key: string,
  value: T,
  estimatedBytes = 1024
): Promise<void> {
  const db = await openStudioIndexedDb();
  if (!db) return;

  const entry: CachedAssetEntry<T> = {
    key,
    value,
    byteSize: estimatedBytes,
    updatedAt: new Date().toISOString(),
  };

  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_ASSETS, 'readwrite');
      tx.objectStore(STORE_ASSETS).put(entry);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function getCachedStudioAsset<T>(key: string): Promise<T | null> {
  const db = await openStudioIndexedDb();
  if (!db) return null;

  return new Promise<T | null>((resolve) => {
    try {
      const tx = db.transaction(STORE_ASSETS, 'readonly');
      const req = tx.objectStore(STORE_ASSETS).get(key);
      req.onsuccess = () => {
        const record = req.result as CachedAssetEntry<T> | undefined;
        resolve(record ? record.value : null);
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/**
 * Persistent Cache API wrapper for model weights, WASM binaries, and character portrait assets.
 * Downloads at most once and serves directly from browser disk cache on repeat calls.
 */
export async function cachedFetchResponse(
  url: string,
  init?: RequestInit
): Promise<Response> {
  const canUseCacheApi =
    typeof caches !== 'undefined' &&
    (!init?.method || init.method.toUpperCase() === 'GET') &&
    (url.startsWith('http://') || url.startsWith('https://'));

  if (!canUseCacheApi) {
    return fetch(url, init);
  }

  try {
    const cache = await caches.open(CACHE_API_BUCKET);
    const cached = await cache.match(url);
    if (cached) {
      return cached.clone();
    }
    const fresh = await fetch(url, init);
    if (fresh.ok && fresh.status === 200) {
      await cache.put(url, fresh.clone()).catch(() => {});
    }
    return fresh;
  } catch {
    return fetch(url, init);
  }
}

export async function cacheBlobInCacheApi(
  virtualUrl: string,
  blob: Blob
): Promise<void> {
  if (typeof caches === 'undefined') return;
  try {
    const cache = await caches.open(CACHE_API_BUCKET);
    const response = new Response(blob, {
      status: 200,
      headers: {
        'Content-Type': blob.type || 'application/octet-stream',
        'X-Studio-Cached-At': new Date().toISOString(),
      },
    });
    await cache.put(virtualUrl, response);
  } catch {
    // ignore storage quota limits
  }
}

export async function getBlobFromCacheApi(
  virtualUrl: string
): Promise<Blob | null> {
  if (typeof caches === 'undefined') return null;
  try {
    const cache = await caches.open(CACHE_API_BUCKET);
    const match = await cache.match(virtualUrl);
    if (!match) return null;
    return await match.blob();
  } catch {
    return null;
  }
}

export async function saveRenderRecordToIndexedDb(
  record: SavedRenderRecord
): Promise<void> {
  const db = await openStudioIndexedDb();
  if (!db) return;

  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_RENDERS, 'readwrite');
      tx.objectStore(STORE_RENDERS).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function deleteRenderRecordFromIndexedDb(
  runTag: string
): Promise<void> {
  const db = await openStudioIndexedDb();
  if (!db) return;

  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_RENDERS, 'readwrite');
      tx.objectStore(STORE_RENDERS).delete(runTag);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function initPersistentStudioCache(): Promise<CacheStorageSummary> {
  for (const model of PRE_EMBEDDED_MODEL_MANIFEST) {
    await setCachedModelStatus(model);
  }

  // Request persistent storage permission quietly if supported so mobile browsers don't evict models
  if (
    typeof navigator !== 'undefined' &&
    navigator.storage &&
    typeof navigator.storage.persist === 'function'
  ) {
    navigator.storage.persist().catch(() => {});
  }

  return getStudioCacheSummary();
}

export async function getStudioCacheSummary(): Promise<CacheStorageSummary> {
  let cacheApiEntries = 0;
  if (typeof caches !== 'undefined') {
    try {
      const cache = await caches.open(CACHE_API_BUCKET);
      const keys = await cache.keys();
      cacheApiEntries = keys.length;
    } catch {
      cacheApiEntries = 0;
    }
  }

  let indexedDbAssets = 0;
  let totalAssetBytes = 0;
  const db = await openStudioIndexedDb();
  if (db) {
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(STORE_ASSETS, 'readonly');
        const req = tx.objectStore(STORE_ASSETS).getAll();
        req.onsuccess = () => {
          const items = Array.isArray(req.result)
            ? (req.result as CachedAssetEntry[])
            : [];
          indexedDbAssets = items.length;
          totalAssetBytes = items.reduce(
            (sum, item) => sum + (Number(item.byteSize) || 0),
            0
          );
          resolve();
        };
        req.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  }

  const models = await getAllCachedModelStatuses();
  const cachedModelIds: OfflineModelId[] = models
    .filter((m) => m.cached)
    .map((m) => m.id);
  const embeddedBytes = models.reduce((sum, m) => sum + m.sizeKB * 1024, 0);

  return {
    cacheApiEntries,
    indexedDbAssets,
    cachedModelIds,
    totalCachedBytes: embeddedBytes + totalAssetBytes,
    lastSyncedAt: new Date().toISOString(),
  };
}
