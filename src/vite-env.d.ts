/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_GEMINI_API_KEY?: string;
  readonly VITE_NVIDIA_API_KEY?: string;
  readonly VITE_YOUTUBE_API_KEY?: string;
  readonly VITE_CLOUDINARY_CLOUD_NAME?: string;
  readonly VITE_CLOUDINARY_UPLOAD_PRESET?: string;
  readonly VITE_EXTERNAL_GPU_ENDPOINT?: string;
  readonly VITE_EXTERNAL_GPU_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
