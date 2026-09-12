/**
 * Script AI and skills handlers.
 *
 * Generation is a long conversation — minutes of streaming with quota waits — so the
 * invoke resolves only when the package is finished (or failed), and progress reaches the
 * renderer as pushes on `scriptai:progress`. Cancellation is a flag the conversation
 * loop checks between every fragment.
 */
import { BrowserWindow, dialog } from 'electron'
import { basename } from 'node:path'
import { IPC_CHANNELS } from '@shared/ipc'
import type { EngineTestResult, JobMode, ScriptAiProgress, ScriptImportResult, Skill } from '@shared/types'
import { handle } from './handle'
import { generatePackage, testScriptAi } from '../scriptai/generate'
import { extractSkillText } from '../skills/extract'
import { deriveSkillName, getSkill, listSkills, saveSkill, deleteSkill } from '../store/skills'
import type { AppSettings } from '@shared/types'

const SKILL_FILTERS = [
  { name: 'Skills', extensions: ['md', 'markdown', 'txt', 'pdf', 'skill', 'zip'] },
  { name: 'All files', extensions: ['*'] }
]

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload)
  }
}

/** Set by cancel; read by the loop between fragments. One generation at a time. */
let cancelled = false

export function registerScriptAiHandlers(): void {
  // -- skills --------------------------------------------------------------

  handle(IPC_CHANNELS.SKILL_LIST, (): Promise<Skill[]> => listSkills())

  handle(
    IPC_CHANNELS.SKILL_SAVE,
    (input: { id?: string; name?: string; content: string }): Promise<Skill> =>
      saveSkill({
        id: input.id,
        name: input.name ?? deriveSkillName(input.content),
        content: input.content
      })
  )

  handle(IPC_CHANNELS.SKILL_DELETE, async (id: string) => {
    await deleteSkill(id)
  })

  handle(IPC_CHANNELS.SKILL_PICK, async (): Promise<Skill | null> => {
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const result = await dialog.showOpenDialog(window as BrowserWindow, {
      title: 'Choose a skill',
      properties: ['openFile'],
      filters: SKILL_FILTERS
    })
    if (result.canceled || !result.filePaths.length) return null

    const filePath = result.filePaths[0]
    const content = await extractSkillText(filePath, basename(filePath))
    return saveSkill({ name: deriveSkillName(content, basename(filePath)), content })
  })

  // -- script ai -----------------------------------------------------------

  handle(
    IPC_CHANNELS.SCRIPT_AI_GENERATE,
    async (input: { skillId: string; title: string; mode: JobMode }): Promise<ScriptImportResult> => {
      const skill = await getSkill(input.skillId)
      if (!skill) throw new Error('That skill no longer exists — refresh the list.')

      if (!input.title.trim()) throw new Error('Give the video a title first.')

      cancelled = false
      return generatePackage({
        skillContent: skill.content,
        title: input.title.trim(),
        mode: input.mode,
        onProgress: (progress: ScriptAiProgress) =>
          broadcast(IPC_CHANNELS.SCRIPT_AI_PROGRESS, progress),
        isCancelled: () => cancelled
      })
    }
  )

  handle(IPC_CHANNELS.SCRIPT_AI_CANCEL, (): boolean => {
    cancelled = true
    return true
  })

  handle(
    IPC_CHANNELS.SCRIPT_AI_TEST,
    (pending?: Partial<AppSettings>): Promise<EngineTestResult> =>
      testScriptAi(pending).then((result) => {
        // EngineTestResult carries an optional file; a key test produces none.
        return result as EngineTestResult
      })
  )
}
