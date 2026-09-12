/**
 * Every IPC channel name in one place.
 *
 * `invoke` channels are renderer -> main request/response. `event` channels are main ->
 * renderer pushes (`on`, never `invoke`). Keeping them in one shared map means a typo is a
 * compile error instead of a silently dead handler.
 */
export const IPC_CHANNELS = {
  // -- app / settings ------------------------------------------------------
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  SETTINGS_TEST_ENGINE: 'settings:test-engine',
  APP_GET_INFO: 'app:get-info',
  APP_OPEN_PATH: 'app:open-path',
  APP_PICK_FILE: 'app:pick-file',
  APP_PICK_DIR: 'app:pick-dir',

  // -- script --------------------------------------------------------------
  SCRIPT_PICK: 'script:pick',
  SCRIPT_PARSE_TEXT: 'script:parse-text',
  SCRIPT_PARSE_FILES: 'script:parse-files',

  // -- script ai -----------------------------------------------------------
  /** Run a skill + title through Gemini and return an imported script package. */
  SCRIPT_AI_GENERATE: 'scriptai:generate',
  SCRIPT_AI_CANCEL: 'scriptai:cancel',
  /** Progress pushes while `scriptai:generate` is in flight. */
  SCRIPT_AI_PROGRESS: 'scriptai:progress',
  SCRIPT_AI_TEST: 'scriptai:test',

  // -- skills --------------------------------------------------------------
  SKILL_LIST: 'skill:list',
  SKILL_SAVE: 'skill:save',
  SKILL_DELETE: 'skill:delete',
  /** Opens a picker, extracts the file (md/txt/pdf/skill/zip) and saves it as a skill. */
  SKILL_PICK: 'skill:pick',

  // -- channels ------------------------------------------------------------
  CHANNEL_LIST: 'channel:list',
  CHANNEL_SAVE: 'channel:save',
  CHANNEL_UPDATE: 'channel:update',
  CHANNEL_DELETE: 'channel:delete',

  // -- projects ------------------------------------------------------------
  PROJECT_LIST: 'project:list',
  PROJECT_GET: 'project:get',
  PROJECT_CREATE: 'project:create',
  PROJECT_STORY_GET: 'project:story-get',
  PROJECT_DELETE: 'project:delete',
  PROJECT_UPDATE_CONFIG: 'project:update-config',
  PROJECT_RESET_TO_REVIEW: 'project:reset-to-review',
  PROJECT_OPEN_FOLDER: 'project:open-folder',
  PROJECT_EXPORT: 'project:export',

  // -- pipeline ------------------------------------------------------------
  PIPELINE_START: 'pipeline:start',
  PIPELINE_CANCEL: 'pipeline:cancel',
  PIPELINE_PAUSE: 'pipeline:pause',
  PIPELINE_RESUME: 'pipeline:resume',
  PIPELINE_RETRY: 'pipeline:retry',
  PIPELINE_PROGRESS: 'pipeline:progress',
  PIPELINE_COMPLETE: 'pipeline:complete',
  PIPELINE_ERROR: 'pipeline:error',
  PIPELINE_SCENE_UPDATED: 'pipeline:scene-updated',
  PIPELINE_LOG: 'pipeline:log',

  // -- tts -----------------------------------------------------------------
  TTS_LIST_ENGINES: 'tts:list-engines',
  TTS_LIST_VOICES: 'tts:list-voices',
  TTS_TEST_KEY: 'tts:test-key',
  TTS_PREVIEW: 'tts:preview',
  TTS_REGENERATE: 'tts:regenerate',

  // -- images --------------------------------------------------------------
  IMAGE_LIST_PROVIDERS: 'image:list-providers',
  IMAGE_REGENERATE: 'image:regenerate',
  /** Open a visible window so the user can sign the provider into its persistent partition. */
  IMAGE_CONNECT: 'image:connect',
  /** Forget a provider's saved session, so a wrong or expired login can be replaced. */
  IMAGE_DISCONNECT: 'image:disconnect',
  /** Check sign-in state for real, by loading the page and looking for the prompt box. */
  IMAGE_PROBE: 'image:probe',
  /** Generate one actual image, which is the only unambiguous proof the provider works. */
  IMAGE_TEST: 'image:test',
  /** Write a page ground-truth report to the preview folder, for diagnosing a failed probe. */
  IMAGE_DEBUG: 'image:debug',

  // -- music ---------------------------------------------------------------
  MUSIC_LIST: 'music:list'
} as const

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS]
