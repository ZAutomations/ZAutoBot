/**
 * App-level handlers: version info, opening things in the OS, and the file/folder pickers.
 */
import { app, BrowserWindow, dialog, shell } from 'electron'
import { IPC_CHANNELS } from '@shared/ipc'
import type { AppInfo, PickOptions } from '@shared/types'
import { hasBundledBinaries, binaries } from '../video/binaries'
import { paths } from '../store/paths'
import { handle } from './handle'

/** Dialogs are always raised from a window the user is looking at. */
function parentWindow(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? undefined
}

export function registerAppHandlers(): void {
  handle(IPC_CHANNELS.APP_GET_INFO, (): AppInfo => {
    const { ffmpeg, ffprobe } = binaries()
    return {
      version: app.getVersion(),
      platform: process.platform,
      userDataDir: paths.root(),
      ffmpegPath: ffmpeg,
      ffprobePath: ffprobe,
      binariesBundled: hasBundledBinaries()
    }
  })

  handle(IPC_CHANNELS.APP_OPEN_PATH, async (target: string) => {
    // A project may hand us its folder rather than a file; both are valid to reveal.
    const error = await shell.openPath(target)
    if (error) throw new Error(error)
  })

  handle(IPC_CHANNELS.APP_PICK_FILE, async (options: PickOptions = {}) => {
    const result = await dialog.showOpenDialog(parentWindow() as BrowserWindow, {
      title: options.title,
      defaultPath: options.defaultPath,
      properties: ['openFile'],
      filters: options.filters
    })
    return result.canceled ? null : result.filePaths[0]
  })

  handle(IPC_CHANNELS.APP_PICK_DIR, async (options: PickOptions = {}) => {
    const result = await dialog.showOpenDialog(parentWindow() as BrowserWindow, {
      title: options.title,
      defaultPath: options.defaultPath,
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : result.filePaths[0]
  })
}
