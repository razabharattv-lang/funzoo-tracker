import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const isGithubPages =
    process.env.GITHUB_PAGES === 'true' || env.GITHUB_PAGES === 'true';

  const geminiStaticKey = (
    env.VITE_GEMINI_API_KEY ||
    (isGithubPages ? env.GEMINI_API_KEY : '') ||
    ''
  ).trim();
  const nvidiaStaticKey = (
    env.VITE_NVIDIA_API_KEY ||
    (isGithubPages ? env.NVIDIA_API_KEY : '') ||
    ''
  ).trim();
  const youtubeStaticKey = (
    env.VITE_YOUTUBE_API_KEY ||
    (isGithubPages ? env.YOUTUBE_API_KEY : '') ||
    ''
  ).trim();

  return {
    base: isGithubPages ? '/funzoo-tracker/' : '/',
    plugins: [react(), tailwindcss()],
    define: {
      'import.meta.env.VITE_GEMINI_API_KEY': JSON.stringify(geminiStaticKey),
      'import.meta.env.VITE_NVIDIA_API_KEY': JSON.stringify(nvidiaStaticKey),
      'import.meta.env.VITE_YOUTUBE_API_KEY': JSON.stringify(youtubeStaticKey),
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
