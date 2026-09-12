/**
 * Main process entry.
 *
 * Order matters: IPC handlers are registered before the window loads, or the renderer's
 * first `window.api` call races an empty handler table.
 */
import { app, BrowserWindow } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { join } from 'node:path'
import {
  runChromeTest,
  runGoogleGateTest,
  runImageGenTest,
  runImageTest,
  runSessionDump
} from './dev/imageTest'
import { runScriptAiTest } from './dev/scriptAiTest'
import { runFootageTest } from './dev/footageTest'
import { runSmokeTest } from './dev/smoke'
import { runTtsTest } from './dev/ttsTest'
import { disconnectChrome } from './images/browser/chrome'
import { destroyAllWorkers, UA_CHROME_WIN } from './images/browser/session'
import { registerIpcHandlers } from './ipc'
import { cancelPipeline, runningProjectIds } from './pipeline/cancellation'
import { createWindow } from './window'

/**
 * The network-level user agent. The per-session override covers pages loaded after the
 * session is created; this covers everything else, including the very first request — the
 * one Google's sign-in gate inspects. Both carry the same Chrome string, so they agree.
 */
app.commandLine.appendSwitch('user-agent', UA_CHROME_WIN)

/**
 * Occlusion and backgrounding switches.
 *
 * The image workers are `WebContentsView`s in a window of their own, and that window ends
 * up behind other windows on a busy desktop. Chromium marks a page it decides it cannot
 * see as `visibilityState: 'hidden'` — and Meta AI's app then renders nothing at all,
 * leaving a run staring at an empty body until it times out looking for the composer.
 * These switches turn occlusion detection and renderer backgrounding off, so a covered
 * worker is always a 'visible' page that keeps rendering no matter what is on top of it.
 */
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')

// The Script AI test writes throwaway keys and skills into settings — keep them out of
// the real profile. Must run before app ready for the redirect to take effect.
if (process.env['ZBOT_SCRIPTAI']) {
  app.setPath('userData', join(app.getPath('temp'), 'zbot-scriptai-test'))
}

/** A quit must not leave ffmpeg or a browser provider running in the background. */
function stopRunningPipelines(): void {
  for (const projectId of runningProjectIds()) cancelPipeline(projectId)
  // The image providers park up to `imageConcurrency` off-screen Chromium windows; without
  // this they outlive the app and keep the whole process alive.
  destroyAllWorkers()
  // Real Chrome is deliberately left running: it holds the Gemini sign-in, and closing it on
  // every quit would make the user sign in again. Only the DevTools socket is dropped.
  disconnectChrome()
}

app.whenReady().then(async () => {
  // Development checks. Both exercise real work and exit; neither is reachable from the UI.
  if (process.env['ZBOT_TTS']) {
    await runTtsTest()
    return
  }

  if (process.env['ZBOT_IMAGE_GEN']) {
    await runImageGenTest()
    return
  }

  if (process.env['ZBOT_IMAGE']) {
    await runImageTest()
    return
  }

  if (process.env['ZBOT_IMAGE_SESSION']) {
    await runSessionDump(process.env['ZBOT_IMAGE_SESSION'].trim() as 'metaai' | 'gemini')
    return
  }

  if (process.env['ZBOT_GOOGLE_GATE']) {
    await runGoogleGateTest()
    return
  }

  if (process.env['ZBOT_CHROME']) {
    await runChromeTest()
    return
  }

  if (process.env['ZBOT_SMOKE']) {
    await runSmokeTest()
    return
  }

  if (process.env['ZBOT_SCRIPTAI']) {
    await runScriptAiTest()
    return
  }

  if (process.env['ZBOT_FOOTAGE']) {
    await runFootageTest()
    return
  }

  electronApp.setAppUserModelId('com.zbot.app')

  app.on('browser-window-created', (_event, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerIpcHandlers()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', stopRunningPipelines)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
