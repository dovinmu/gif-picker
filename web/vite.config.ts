import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Where /db/v1 requests go in dev:
//   default                         local Antfly at http://localhost:8080
//   REMOTE=1                        the deployed site (honeycomb.rowan.earth)
//   ANTFLY_CLOUD_INSTANCE=<id> \
//   ANTFLY_API_KEY=<key>            an Antfly Cloud instance; the key stays in
//                                   the dev server and is never sent to the browser
const remote = process.env.REMOTE === '1'
const cloudInstance = process.env.ANTFLY_CLOUD_INSTANCE
const cloudKey = process.env.ANTFLY_API_KEY
const cloudURL = process.env.ANTFLY_CLOUD_URL ?? 'https://platform.antfly.io'
const nsfw = process.env.NSFW === '1'

const dbProxy = cloudInstance
  ? {
      target: cloudURL,
      changeOrigin: true,
      rewrite: (path: string) => path.replace(/^\/db\/v1/, `/cloud/v1/${cloudInstance}/db/v1`),
      headers: cloudKey ? { Authorization: `Bearer ${cloudKey}` } : undefined,
    }
  : {
      target: remote ? 'https://honeycomb.rowan.earth' : 'http://localhost:8080',
      changeOrigin: true,
    }

// https://vite.dev/config/
export default defineConfig({
  define: {
    __NSFW_MODE__: JSON.stringify(nsfw),
  },
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/db/v1': dbProxy,
      ...(!remote && !cloudInstance && {
        '/termite': {
          target: 'http://localhost:11434',
          changeOrigin: true,
          rewrite: (path: string) => path.replace(/^\/termite/, ''),
        },
      }),
    },
  },
})
