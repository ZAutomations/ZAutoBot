/**
 * The one place an IPC handler is registered.
 *
 * Handlers never reject across the bridge: Electron glues the channel name onto a rejection
 * message, which turns a clean "No image folder selected" into noise. Returning an
 * `IpcResult` keeps the text the user sees exactly the text the main process produced, and
 * the preload turns it back into a real `Error` on the other side.
 */
import { ipcMain } from 'electron'
import type { IpcResult } from '@shared/types'

export function handle<T>(
  channel: string,
  fn: (...args: never[]) => Promise<T> | T
): void {
  ipcMain.handle(channel, async (_event, ...args): Promise<IpcResult<T>> => {
    try {
      return { ok: true, data: await fn(...(args as never[])) }
    } catch (err) {
      const message = (err as Error)?.message || String(err)
      console.error(`[ipc] ${channel}: ${message}`)
      return { ok: false, error: message }
    }
  })
}
