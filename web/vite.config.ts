import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const remote = process.env.REMOTE === '1'
const apiTarget = remote ? 'https://honeycomb.rowan.earth' : 'http://localhost:8080'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
      },
      ...(!remote && {
        '/termite': {
          target: 'http://localhost:11434',
          changeOrigin: true,
          rewrite: (path: string) => path.replace(/^\/termite/, ''),
        },
      }),
    },
  },
})
