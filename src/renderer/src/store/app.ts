/**
 * Application data: settings, channels, projects.
 *
 * The API is pulled off `window.api` on every call rather than captured at module load —
 * that keeps the store importable in a plain node test, where no preload bridge exists.
 */
import { create } from 'zustand'
import type { AppInfo, AppSettings, Channel, Project } from '@shared/types'

interface AppState {
  info: AppInfo | null
  settings: AppSettings | null
  channels: Channel[]
  projects: Project[]
  ready: boolean
  error: string | null

  load: () => Promise<void>
  refreshSettings: () => Promise<void>
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>
  refreshChannels: () => Promise<void>
  refreshProjects: () => Promise<void>
  setError: (message: string | null) => void
}

export const useApp = create<AppState>((set) => ({
  info: null,
  settings: null,
  channels: [],
  projects: [],
  ready: false,
  error: null,

  async load() {
    try {
      const [info, settings, channels, projects] = await Promise.all([
        window.api.app.info(),
        window.api.settings.get(),
        window.api.channels.list(),
        window.api.projects.list()
      ])
      set({ info, settings, channels, projects, ready: true, error: null })
    } catch (err) {
      set({ ready: true, error: (err as Error).message })
    }
  },

  async refreshSettings() {
    set({ settings: await window.api.settings.get() })
  },

  async saveSettings(patch) {
    const settings = await window.api.settings.set(patch)
    set({ settings })
  },

  async refreshChannels() {
    set({ channels: await window.api.channels.list() })
  },

  async refreshProjects() {
    set({ projects: await window.api.projects.list() })
  },

  setError(message) {
    set({ error: message })
  }
}))
