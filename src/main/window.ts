/**
 * The application window.
 *
 * This build is ESM (package.json has `"type": "module"` and Electron 36 supports it), so
 * `__dirname` does not exist and electron-vite emits `.mjs` entry files. `import.meta.dirname`
 * is the ESM equivalent — it is available from Electron 30 onwards.
 */
import { join } from 'node:path'
import { BrowserWindow, shell } from 'electron'
import { is } from '@electron-toolkit/utils'

const here = import.meta.dirname

/** The one application window, once created. */
let mainWindow: BrowserWindow | null = null

export function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1120,
    minHeight: 720,
    show: false,
    autoHideMenuBar: true,
    // Matches the dark-first palette, so the first paint is not a white flash.
    backgroundColor: '#0b0e14',
    title: 'zBot',
    webPreferences: {
      preload: join(here, '../preload/index.mjs'),
      // Required for an ESM preload script.
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  window.on('ready-to-show', () => window.show())

  // Links in the UI open in the real browser; the app window never navigates away.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (is.dev && devServerUrl) {
    void window.loadURL(devServerUrl)
  } else {
    void window.loadFile(join(here, '../renderer/index.html'))
  }

  mainWindow = window
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })

  return window
}

/**
 * The application window, or null before it exists.
 *
 * The browser-automation workers attach to this window as child views — that is the
 * spec's design (§6), and the reason they need it: a view shares its host's visibility,
 * so pages keep rendering while the app is open. Headless runs make their own host; see
 * `hostWindow` in `images/browser/session.ts`.
 */
export function getMainWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
}
