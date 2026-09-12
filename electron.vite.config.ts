import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// Main and preload are bundled into single files. Because package.json sets
// `"type": "module"` and Electron 36 supports ESM, electron-vite emits ESM: the main entry
// is `out/main/index.js` (ESM by virtue of that type field) and the preload is
// `out/preload/index.mjs` (Electron requires the .mjs extension for an ESM preload).
//
// Anything in package.json "dependencies" stays external and is imported at runtime from
// node_modules — so it must be a *static* ES import in source, never a runtime require()
// of a relative path (that path does not exist in the bundle).
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@main': resolve('src/main')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react()]
  }
})
