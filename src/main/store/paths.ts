/**
 * Every path the app reads or writes, derived from Electron's userData dir.
 *
 * Nothing else in the codebase should build a path by hand — that is how a stray
 * `userData` folder ends up in the wrong place after a rename.
 */
import { app } from 'electron'
import { join } from 'node:path'

export function userDataDir(): string {
  return app.getPath('userData')
}

export const paths = {
  root: userDataDir,
  settings: (): string => join(userDataDir(), 'settings.json'),
  channels: (): string => join(userDataDir(), 'channels.json'),

  projectsDir: (): string => join(userDataDir(), 'projects'),
  projectDir: (id: string): string => join(userDataDir(), 'projects', id),
  projectFile: (id: string): string => join(userDataDir(), 'projects', id, 'project.json'),
  storyFile: (id: string): string => join(userDataDir(), 'projects', id, 'story.json'),
  projectSub: (id: string, sub: string): string =>
    join(userDataDir(), 'projects', id, sub),

  skillsDir: (): string => join(userDataDir(), 'skills'),
  skillFile: (id: string): string => join(userDataDir(), 'skills', `${id}.md`),

  generatedScriptsDir: (): string => join(userDataDir(), 'generated-scripts'),

  /** Cache file for a remote list, e.g. the FameSpeak voice walk. */
  cacheFile: (name: string): string => join(userDataDir(), name)
}

export const PROJECT_SUBDIRS = [
  'images',
  'audio',
  'clips',
  'subtitles',
  'exports'
] as const

export type ProjectSubdir = (typeof PROJECT_SUBDIRS)[number]
