import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    proxy: {
      '/api-proxy/nebius': {
        target: 'https://api.tokenfactory.nebius.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api-proxy\/nebius/, '')
      },
      '/api-proxy/nvidia': {
        target: 'https://integrate.api.nvidia.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api-proxy\/nvidia/, '')
      }
    }
  }
});
