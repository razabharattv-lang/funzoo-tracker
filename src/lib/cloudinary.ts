import type { RenderResultManifest, StudioConfig } from '../types/studio';

export interface CloudinaryUploadResponse {
  secure_url: string;
  public_id: string;
  duration?: number;
  bytes?: number;
}

export function uploadRawVideoToCloudinary(
  file: File,
  runTag: string,
  config: StudioConfig,
  onProgress: (percent: number) => void,
  signal?: AbortSignal
): Promise<CloudinaryUploadResponse> {
  return new Promise((resolve, reject) => {
    const endpoint = `https://api.cloudinary.com/v1_1/${encodeURIComponent(
      config.cloudinaryCloudName
    )}/video/upload`;

    const formData = new FormData();
    formData.append('file', file);
    formData.append('upload_preset', config.cloudinaryUploadPreset);
    formData.append('folder', 'explainer-studio/raw');
    formData.append('public_id', `raw_${runTag}`);
    formData.append('tags', `${runTag},temp_raw`);

    const xhr = new XMLHttpRequest();

    const onAbort = () => {
      xhr.abort();
      reject(new DOMException('Upload cancelled by user.', 'AbortError'));
    };

    if (signal) {
      if (signal.aborted) {
        reject(new DOMException('Upload cancelled by user.', 'AbortError'));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        const pct = Math.min(100, Math.round((event.loaded / event.total) * 100));
        onProgress(pct);
      }
    };

    xhr.onload = () => {
      signal?.removeEventListener('abort', onAbort);
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const parsed = JSON.parse(xhr.responseText) as CloudinaryUploadResponse;
          if (!parsed.secure_url || !parsed.public_id) {
            reject(new Error('Cloudinary returned an incomplete upload payload.'));
            return;
          }
          resolve(parsed);
        } catch {
          reject(new Error('Failed to parse Cloudinary upload response.'));
        }
      } else {
        let message = `Cloudinary upload failed (HTTP ${xhr.status}).`;
        try {
          const errJson = JSON.parse(xhr.responseText) as { error?: { message?: string } };
          if (errJson.error?.message) {
            message = `Cloudinary error: ${errJson.error.message}`;
          }
        } catch {
          // keep default message
        }
        reject(new Error(message));
      }
    };

    xhr.onerror = () => {
      signal?.removeEventListener('abort', onAbort);
      reject(new Error('Network error while uploading video to Cloudinary.'));
    };

    xhr.open('POST', endpoint, true);
    xhr.send(formData);
  });
}

export async function uploadCharacterPortraitToCloudinary(
  file: File,
  config: StudioConfig
): Promise<CloudinaryUploadResponse> {
  if (!config.cloudinaryCloudName || !config.cloudinaryUploadPreset) {
    throw new Error(
      'Enter your Cloudinary Cloud Name and Unsigned Upload Preset in Studio Config first.'
    );
  }

  const endpoint = `https://api.cloudinary.com/v1_1/${encodeURIComponent(
    config.cloudinaryCloudName
  )}/image/upload`;

  const formData = new FormData();
  formData.append('file', file);
  formData.append('upload_preset', config.cloudinaryUploadPreset);
  formData.append('folder', 'explainer-studio/characters');
  formData.append('tags', 'keep_character');

  const response = await fetch(endpoint, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    let message = `Character portrait upload failed (HTTP ${response.status}).`;
    try {
      const errJson = (await response.json()) as { error?: { message?: string } };
      if (errJson.error?.message) {
        message = `Cloudinary error: ${errJson.error.message}`;
      }
    } catch {
      // keep default
    }
    throw new Error(message);
  }

  const parsed = (await response.json()) as CloudinaryUploadResponse;
  if (!parsed.secure_url) {
    throw new Error('Cloudinary did not return an image URL.');
  }
  return parsed;
}

export async function fetchRenderResultManifest(
  cloudName: string,
  runTag: string,
  signal?: AbortSignal
): Promise<RenderResultManifest> {
  const baseUrl = `https://res.cloudinary.com/${encodeURIComponent(
    cloudName
  )}/raw/upload/explainer-studio/results/${encodeURIComponent(runTag)}.json`;

  let lastError = 'Manifest not ready yet.';
  for (let attempt = 1; attempt <= 6; attempt++) {
    if (signal?.aborted) {
      throw new DOMException('Cancelled by user.', 'AbortError');
    }
    try {
      const response = await fetch(`${baseUrl}?t=${Date.now()}`, {
        method: 'GET',
        cache: 'no-store',
        signal,
      });
      if (response.ok) {
        return (await response.json()) as RenderResultManifest;
      }
      lastError = `Cloudinary manifest HTTP ${response.status}`;
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err;
      lastError = (err as Error).message;
    }
    await new Promise((r) => setTimeout(r, attempt * 1500));
  }

  throw new Error(
    `Could not retrieve render manifest from Cloudinary (${lastError}).`
  );
}
