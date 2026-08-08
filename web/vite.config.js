import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Built assets are uploaded to the Storage static website ($web).
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist' },
});
