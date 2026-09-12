/**
 * Skills — the locked "channel rulebook" markdown Script AI writes a package against.
 *
 * Content lives in `userData/skills/<id>.md`; names live in a small index so a skill can
 * be listed without reading every file.
 */
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { basename, extname } from 'node:path'
import type { Skill } from '@shared/types'
import { readJson, updateJson, writeJson } from './jsonStore'
import { paths } from './paths'

interface SkillIndex {
  skills: Array<Omit<Skill, 'content'>>
}

const EMPTY: SkillIndex = { skills: [] }

export async function listSkills(): Promise<Skill[]> {
  const index = await readJson<SkillIndex>(paths.cacheFile('skills.json'), EMPTY)
  const entries = Array.isArray(index.skills) ? index.skills : []

  const skills: Skill[] = []
  for (const entry of entries) {
    try {
      const content = await fs.readFile(paths.skillFile(entry.id), 'utf8')
      skills.push({ ...entry, content })
    } catch {
      // Index entry with no file — skip it rather than failing the whole list.
      console.warn(`[skills] missing file for skill ${entry.id}`)
    }
  }
  return skills
}

export async function getSkill(id: string): Promise<Skill | null> {
  const index = await readJson<SkillIndex>(paths.cacheFile('skills.json'), EMPTY)
  const entry = (index.skills ?? []).find((s) => s.id === id)
  if (!entry) return null
  try {
    const content = await fs.readFile(paths.skillFile(id), 'utf8')
    return { ...entry, content }
  } catch {
    return null
  }
}

/**
 * Name resolution order: explicit name -> YAML frontmatter `name:` -> first markdown
 * heading -> filename. Never a bare uuid, which is useless in a dropdown.
 */
export function deriveSkillName(content: string, filename?: string): string {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)
  if (frontmatter) {
    const match = /^name:\s*(.+)$/m.exec(frontmatter[1])
    if (match) return match[1].trim().replace(/^["']|["']$/g, '')
  }

  const heading = /^#{1,3}\s+(.+)$/m.exec(content)
  if (heading) return heading[1].trim()

  if (filename) return basename(filename, extname(filename))
  return 'Untitled skill'
}

export async function saveSkill(input: {
  id?: string
  name: string
  content: string
}): Promise<Skill> {
  const id = input.id ?? randomUUID()
  const skill: Skill = {
    id,
    name: input.name.trim() || 'Untitled skill',
    content: input.content,
    updatedAt: Date.now()
  }

  await fs.mkdir(paths.skillsDir(), { recursive: true })
  await fs.writeFile(paths.skillFile(id), skill.content, 'utf8')

  await updateJson<SkillIndex>(paths.cacheFile('skills.json'), EMPTY, (index) => {
    const skills = (index.skills ?? []).filter((s) => s.id !== id)
    skills.push({ id, name: skill.name, updatedAt: skill.updatedAt })
    return { skills }
  })

  return skill
}

export async function deleteSkill(id: string): Promise<void> {
  await fs.rm(paths.skillFile(id), { force: true }).catch(() => undefined)
  await updateJson<SkillIndex>(paths.cacheFile('skills.json'), EMPTY, (index) => ({
    skills: (index.skills ?? []).filter((s) => s.id !== id)
  }))
}

/** Persist the index explicitly (used by tests and repair paths). */
export async function writeSkillIndex(index: SkillIndex): Promise<void> {
  await writeJson(paths.cacheFile('skills.json'), index)
}
