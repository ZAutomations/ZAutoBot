/**
 * Project store.
 *
 * One project = one video run, living in `userData/projects/<uuid>/` with `project.json`,
 * `story.json` and the `images/ audio/ clips/ subtitles/ exports/` subfolders.
 */
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { defaultProjectConfig } from '@shared/constants'
import { PIPELINE_STAGES } from '@shared/types'
import type {
  JobMode,
  Project,
  ProjectConfig,
  ProjectStatus,
  StageState,
  Story
} from '@shared/types'
import { fileExists, readJson, writeJson } from './jsonStore'
import { PROJECT_SUBDIRS, paths, type ProjectSubdir } from './paths'

export function assetPath(id: string, sub: ProjectSubdir, filename: string): string {
  return join(paths.projectSub(id, sub), filename)
}

export async function ensureProjectDirs(id: string): Promise<void> {
  await fs.mkdir(paths.projectDir(id), { recursive: true })
  for (const sub of PROJECT_SUBDIRS) {
    await fs.mkdir(paths.projectSub(id, sub), { recursive: true })
  }
}

function freshStages(): Record<string, StageState> {
  const stages: Record<string, StageState> = {}
  for (const stage of PIPELINE_STAGES) stages[stage] = { status: 'pending' }
  return stages
}

export async function createProject(input: {
  title: string
  mode: JobMode
  config?: Partial<ProjectConfig>
}): Promise<Project> {
  const id = randomUUID()
  const now = Date.now()

  const project: Project = {
    id,
    createdAt: now,
    updatedAt: now,
    title: input.title,
    mode: input.mode,
    status: 'idle',
    config: { ...defaultProjectConfig(input.mode), ...input.config, mode: input.mode },
    stages: freshStages(),
    assets: {}
  }

  await ensureProjectDirs(id)
  await writeJson(paths.projectFile(id), project)
  return project
}

export async function getProject(id: string): Promise<Project | null> {
  const file = paths.projectFile(id)
  if (!(await fileExists(file))) return null
  return readJson<Project | null>(file, null)
}

export async function listProjects(): Promise<Project[]> {
  const dir = paths.projectsDir()
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return []
  }

  const projects: Project[] = []
  for (const entry of entries) {
    const file = paths.projectFile(entry)
    if (!(await fileExists(file))) continue
    // Tolerant read: one corrupt project must not blank the whole list.
    const project = await readJson<Project | null>(file, null)
    if (project) projects.push(project)
  }

  return projects.sort((a, b) => b.createdAt - a.createdAt)
}

export async function saveProject(project: Project): Promise<void> {
  const next: Project = { ...project, updatedAt: Date.now() }
  await writeJson(paths.projectFile(next.id), next)
}

/**
 * Read-modify-write inside one lock, so a concurrent progress update cannot be clobbered
 * by a stage transition.
 */
export async function updateProject(
  id: string,
  mutate: (project: Project) => Project | Promise<Project>
): Promise<Project | null> {
  const current = await getProject(id)
  if (!current) return null
  const next = await mutate(current)
  next.updatedAt = Date.now()
  await writeJson(paths.projectFile(id), next)
  return next
}

export async function setProjectStatus(id: string, status: ProjectStatus): Promise<void> {
  await updateProject(id, (p) => ({ ...p, status }))
}

export async function setStageState(
  id: string,
  stage: string,
  state: Partial<StageState>
): Promise<void> {
  await updateProject(id, (project) => ({
    ...project,
    stages: {
      ...project.stages,
      [stage]: { ...project.stages[stage], ...state }
    }
  }))
}

export async function deleteProject(id: string): Promise<void> {
  await fs.rm(paths.projectDir(id), { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// Story
// ---------------------------------------------------------------------------

export async function saveStory(id: string, story: Story): Promise<void> {
  await ensureProjectDirs(id)
  await writeJson(paths.storyFile(id), story)
  await updateProject(id, (project) => ({ ...project, title: story.title || project.title }))
}

export async function loadStory(id: string): Promise<Story | null> {
  const file = paths.storyFile(id)
  if (!(await fileExists(file))) return null
  return readJson<Story | null>(file, null)
}

// ---------------------------------------------------------------------------
// Channel migration
// ---------------------------------------------------------------------------

/**
 * Channel rename must carry its projects along. Comparison is case-insensitive because
 * the stored name is free text typed by the user.
 */
export async function migrateChannelName(
  fromName: string,
  toName: string
): Promise<number> {
  const projects = await listProjects()
  const target = fromName.trim().toLowerCase()
  let migrated = 0

  for (const project of projects) {
    const current = (project.config.channelName ?? '').trim().toLowerCase()
    if (current !== target) continue
    await updateProject(project.id, (p) => ({
      ...p,
      config: { ...p.config, channelName: toName }
    }))
    migrated++
  }

  return migrated
}
