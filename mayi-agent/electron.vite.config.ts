import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

const projectRoot = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve(projectRoot, 'src/main/index.ts')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve(projectRoot, 'src/preload/index.ts')
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@': resolve(projectRoot, 'src/renderer/src')
      }
    },
    plugins: [vue()]
  }
})
