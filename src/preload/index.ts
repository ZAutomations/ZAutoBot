/**
 * The preload bridge.
 *
 * `contextIsolation` is on, so this file is the only thing the renderer can reach. It does
 * two jobs: unwrap the `IpcResult` envelope into a real `Error`, and turn the push channels
 * into subscriptions that hand back their own unsubscribe.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC_CHANNELS } from '@shared/ipc'
import type { ZBotApi, Unsubscribe } from '@shared/api'
import type { IpcResult } from '@shared/types'

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = (await ipcRenderer.invoke(channel, ...args)) as IpcResult<T>
  if (!result.ok) throw new Error(result.error)
  return result.data
}

function subscribe<T>(channel: string, listener: (payload: T) => void): Unsubscribe {
  const handler = (_event: IpcRendererEvent, payload: T): void => listener(payload)
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.removeListener(channel, handler)
  }
}

const api: ZBotApi = {
  app: {
    info: () => call(IPC_CHANNELS.APP_GET_INFO),
    openPath: (target) => call(IPC_CHANNELS.APP_OPEN_PATH, target),
    pickFile: (options) => call(IPC_CHANNELS.APP_PICK_FILE, options),
    pickDir: (options) => call(IPC_CHANNELS.APP_PICK_DIR, options)
  },

  settings: {
    get: () => call(IPC_CHANNELS.SETTINGS_GET),
    set: (patch) => call(IPC_CHANNELS.SETTINGS_SET, patch),
    testEngine: (engineId, pending) =>
      call(IPC_CHANNELS.SETTINGS_TEST_ENGINE, engineId, pending)
  },

  script: {
    pick: (mode) => call(IPC_CHANNELS.SCRIPT_PICK, mode),
    parseText: (text, mode, filename) =>
      call(IPC_CHANNELS.SCRIPT_PARSE_TEXT, text, filename, mode),
    parseFiles: (input) => call(IPC_CHANNELS.SCRIPT_PARSE_FILES, input)
  },

  scriptai: {
    generate: (input) => call(IPC_CHANNELS.SCRIPT_AI_GENERATE, input),
    cancel: () => call(IPC_CHANNELS.SCRIPT_AI_CANCEL),
    onProgress: (listener) => subscribe(IPC_CHANNELS.SCRIPT_AI_PROGRESS, listener),
    test: (pending) => call(IPC_CHANNELS.SCRIPT_AI_TEST, pending)
  },

  skills: {
    list: () => call(IPC_CHANNELS.SKILL_LIST),
    save: (input) => call(IPC_CHANNELS.SKILL_SAVE, input),
    remove: (id) => call(IPC_CHANNELS.SKILL_DELETE, id),
    pick: () => call(IPC_CHANNELS.SKILL_PICK)
  },

  channels: {
    list: () => call(IPC_CHANNELS.CHANNEL_LIST),
    save: (input) => call(IPC_CHANNELS.CHANNEL_SAVE, input),
    update: (id, patch) => call(IPC_CHANNELS.CHANNEL_UPDATE, id, patch),
    remove: (id) => call(IPC_CHANNELS.CHANNEL_DELETE, id)
  },

  projects: {
    list: () => call(IPC_CHANNELS.PROJECT_LIST),
    get: (id) => call(IPC_CHANNELS.PROJECT_GET, id),
    story: (id) => call(IPC_CHANNELS.PROJECT_STORY_GET, id),
    create: (input) => call(IPC_CHANNELS.PROJECT_CREATE, input),
    remove: (id) => call(IPC_CHANNELS.PROJECT_DELETE, id),
    updateConfig: (id, patch) => call(IPC_CHANNELS.PROJECT_UPDATE_CONFIG, id, patch),
    resetToReview: (id) => call(IPC_CHANNELS.PROJECT_RESET_TO_REVIEW, id),
    openFolder: (id, subPath) => call(IPC_CHANNELS.PROJECT_OPEN_FOLDER, id, subPath),
    export: (id) => call(IPC_CHANNELS.PROJECT_EXPORT, id)
  },

  pipeline: {
    start: (projectId) => call(IPC_CHANNELS.PIPELINE_START, projectId),
    retry: (projectId) => call(IPC_CHANNELS.PIPELINE_RETRY, projectId),
    cancel: (projectId) => call(IPC_CHANNELS.PIPELINE_CANCEL, projectId),
    pause: (projectId) => call(IPC_CHANNELS.PIPELINE_PAUSE, projectId),
    resume: (projectId) => call(IPC_CHANNELS.PIPELINE_RESUME, projectId),

    onProgress: (listener) => subscribe(IPC_CHANNELS.PIPELINE_PROGRESS, listener),
    onComplete: (listener) => subscribe(IPC_CHANNELS.PIPELINE_COMPLETE, listener),
    onError: (listener) => subscribe(IPC_CHANNELS.PIPELINE_ERROR, listener),
    onSceneUpdated: (listener) => subscribe(IPC_CHANNELS.PIPELINE_SCENE_UPDATED, listener),
    onLog: (listener) => subscribe(IPC_CHANNELS.PIPELINE_LOG, listener)
  },

  tts: {
    listEngines: () => call(IPC_CHANNELS.TTS_LIST_ENGINES),
    listVoices: (engineId, force) => call(IPC_CHANNELS.TTS_LIST_VOICES, engineId, force),
    testKey: (engineId, pending) => call(IPC_CHANNELS.TTS_TEST_KEY, engineId, pending),
    preview: (input) => call(IPC_CHANNELS.TTS_PREVIEW, input),
    regenerate: (input) => call(IPC_CHANNELS.TTS_REGENERATE, input)
  },

  images: {
    listProviders: () => call(IPC_CHANNELS.IMAGE_LIST_PROVIDERS),
    regenerate: (input) => call(IPC_CHANNELS.IMAGE_REGENERATE, input),
    connect: (providerId) => call(IPC_CHANNELS.IMAGE_CONNECT, providerId),
    disconnect: (providerId) => call(IPC_CHANNELS.IMAGE_DISCONNECT, providerId),
    probe: (providerId) => call(IPC_CHANNELS.IMAGE_PROBE, providerId),
    test: (providerId) => call(IPC_CHANNELS.IMAGE_TEST, providerId),
    debug: (providerId) => call(IPC_CHANNELS.IMAGE_DEBUG, providerId)
  },

  music: {
    list: (dir) => call(IPC_CHANNELS.MUSIC_LIST, dir)
  }
}

contextBridge.exposeInMainWorld('api', api)
