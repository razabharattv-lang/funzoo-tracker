import type { StudioConfig } from '../types/studio';

export interface CharacterUploadResult {
  secure_url: string;
  public_id: string;
}

async function compressPortraitToDataUrl(file: File): Promise<string> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Could not decode portrait image.'));
      el.src = objectUrl;
    });

    const maxSide = 512;
    const scale = Math.min(1, maxSide / Math.max(img.width, img.height, 1));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable.');
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', 0.85);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export async function uploadCharacterPortraitToCloudinary(
  file: File,
  config: StudioConfig
): Promise<CharacterUploadResult> {
  // If Cloudinary is configured, upload directly (tagged keep_character).
  // Otherwise, save a crisp compressed Data URL locally so preview works immediately.
  if (!config.cloudinaryCloudName || !config.cloudinaryUploadPreset) {
    const dataUrl = await compressPortraitToDataUrl(file);
    return {
      secure_url: dataUrl,
      public_id: `local_portrait_${Date.now()}`,
    };
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
    // Graceful fallback to local data URL if Cloudinary preset rejects CORS or upload
    const dataUrl = await compressPortraitToDataUrl(file);
    return {
      secure_url: dataUrl,
      public_id: `local_portrait_${Date.now()}`,
    };
  }

  const parsed = (await response.json()) as {
    secure_url?: string;
    public_id?: string;
  };
  if (!parsed.secure_url) {
    const dataUrl = await compressPortraitToDataUrl(file);
    return {
      secure_url: dataUrl,
      public_id: `local_portrait_${Date.now()}`,
    };
  }

  return {
    secure_url: parsed.secure_url,
    public_id: parsed.public_id ?? '',
  };
}
