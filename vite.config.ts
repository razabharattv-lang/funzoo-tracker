import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const isGithubPages =
    process.env.GITHUB_PAGES === 'true' || env.GITHUB_PAGES === 'true';

  const readSafeKey = (
    viteKey: string,
    rawKey: string,
    allowRawOutsidePages = false
  ): string => {
    const fromVite = process.env[viteKey] || env[viteKey] || '';
    const fromRaw =
      isGithubPages || allowRawOutsidePages
        ? process.env[rawKey] || env[rawKey] || ''
        : '';
    return (fromVite || fromRaw).trim();
  };

  const geminiStaticKey = readSafeKey('VITE_GEMINI_API_KEY', 'GEMINI_API_KEY');
  const youtubeStaticKey = readSafeKey('VITE_YOUTUBE_API_KEY', 'YOUTUBE_API_KEY');
  const nvidiaStaticKey = readSafeKey('VITE_NVIDIA_API_KEY', 'NVIDIA_API_KEY');
  const cloudinaryCloudName = readSafeKey(
    'VITE_CLOUDINARY_CLOUD_NAME',
    'CLOUDINARY_CLOUD_NAME',
    true
  );
  const cloudinaryUploadPreset = readSafeKey(
    'VITE_CLOUDINARY_UPLOAD_PRESET',
    'CLOUDINARY_UPLOAD_PRESET',
    true
  );

  return {
    base: isGithubPages ? '/funzoo-tracker/' : '/',
    plugins: [react(), tailwindcss()],
    define: {
      'import.meta.env.VITE_GEMINI_API_KEY': JSON.stringify(geminiStaticKey),
      'import.meta.env.VITE_YOUTUBE_API_KEY': JSON.stringify(youtubeStaticKey),
      'import.meta.env.VITE_NVIDIA_API_KEY': JSON.stringify(nvidiaStaticKey),
      'import.meta.env.VITE_CLOUDINARY_CLOUD_NAME': JSON.stringify(cloudinaryCloudName),
      'import.meta.env.VITE_CLOUDINARY_UPLOAD_PRESET': JSON.stringify(cloudinaryUploadPreset),
    },
    worker: {
      format: 'es',
    },
    server: {
      port: 3000,
      host: '0.0.0.0',
    },
    preview: {
      port: 3000,
      host: '0.0.0.0',
    },
    build: {
      outDir: 'dist',
      sourcemap: false,
    },
  };
});
