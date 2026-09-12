/**
 * Register every IPC handler. Called once, from the main process entry.
 */
import { registerAppHandlers } from './app'
import { registerImageHandlers, registerMusicHandlers, registerSettingsHandlers, registerTtsHandlers } from './media'
import { registerPipelineHandlers } from './pipeline'
import { registerProjectHandlers } from './projects'
import { registerChannelHandlers, registerScriptHandlers } from './script'
import { registerScriptAiHandlers } from './scriptai'

export function registerIpcHandlers(): void {
  registerAppHandlers()
  registerSettingsHandlers()
  registerScriptHandlers()
  registerChannelHandlers()
  registerProjectHandlers()
  registerPipelineHandlers()
  registerTtsHandlers()
  registerImageHandlers()
  registerMusicHandlers()
  registerScriptAiHandlers()
}
