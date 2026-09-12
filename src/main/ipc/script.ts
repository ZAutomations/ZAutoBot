/**
 * Script import and channel handlers.
 *
 * The importer is deterministic by design — the user's words pass through it untouched.
 * Everything here reads files and hands the text to `parse.ts`; nothing rewrites a prompt.
 */
import { promises as fs } from 'node:fs'
import { basename } from 'node:path'
import { BrowserWindow, dialog } from 'electron'
import { IPC_CHANNELS } from '@shared/ipc'
import type { Channel, JobMode, ScriptImportResult } from '@shared/types'
import { parseScriptText, parseSeparateFiles } from '../script/parse'
import { validateScript } from '../script/validate'
import type { ParsedScript } from '../script/types'
import {
  deleteChannel,
  listChannels,
  saveChannel,
  updateChannel
} from '../store/channels'
import { handle } from './handle'

const SCRIPT_FILTERS = [
  { name: 'Scripts', extensions: ['md', 'markdown', 'txt', 'json'] },
  { name: 'All files', extensions: ['*'] }
]

async function readTextFile(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf8')
  } catch (err) {
    throw new Error(`Could not read ${basename(filePath)}: ${(err as Error).message}`)
  }
}

/** Parse and validate in one step — the renderer never sees an unvalidated script. */
function importScript(script: ParsedScript, mode: JobMode, filePath?: string): ScriptImportResult {
  return { script, validation: validateScript(script, mode), filePath }
}

export function registerScriptHandlers(): void {
  handle(IPC_CHANNELS.SCRIPT_PICK, async (mode: JobMode): Promise<ScriptImportResult | null> => {
    const window =
      BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? undefined

    const result = await dialog.showOpenDialog(window as BrowserWindow, {
      title: 'Choose a script',
      properties: ['openFile'],
      filters: SCRIPT_FILTERS
    })
    if (result.canceled || !result.filePaths.length) return null

    const filePath = result.filePaths[0]
    const text = await readTextFile(filePath)
    const script = parseScriptText(text, basename(filePath))
    return importScript(script, mode, filePath)
  })

  handle(
    IPC_CHANNELS.SCRIPT_PARSE_TEXT,
    (text: string, filename: string | undefined, mode: JobMode): ScriptImportResult =>
      importScript(parseScriptText(text, filename), mode)
  )

  handle(
    IPC_CHANNELS.SCRIPT_PARSE_FILES,
    async (input: {
      narrationPath?: string
      promptsPath?: string
      thumbnailPath?: string
      title?: string
      mode: JobMode
    }): Promise<ScriptImportResult> => {
      if (!input.narrationPath && !input.promptsPath) {
        throw new Error('Choose at least a narration or a prompts file.')
      }

      const script = parseSeparateFiles({
        narration: input.narrationPath ? await readTextFile(input.narrationPath) : '',
        prompts: input.promptsPath ? await readTextFile(input.promptsPath) : undefined,
        thumbnail: input.thumbnailPath ? await readTextFile(input.thumbnailPath) : undefined,
        title: input.title
      })

      return importScript(script, input.mode, input.narrationPath ?? input.promptsPath)
    }
  )
}

export function registerChannelHandlers(): void {
  handle(IPC_CHANNELS.CHANNEL_LIST, (): Promise<Channel[]> => listChannels())

  handle(
    IPC_CHANNELS.CHANNEL_SAVE,
    (input: Partial<Channel> & { name: string }): Promise<Channel> => saveChannel(input)
  )

  handle(
    IPC_CHANNELS.CHANNEL_UPDATE,
    (id: string, patch: Partial<Channel>): Promise<Channel | null> => updateChannel(id, patch)
  )

  handle(IPC_CHANNELS.CHANNEL_DELETE, async (id: string) => {
    await deleteChannel(id)
  })
}
