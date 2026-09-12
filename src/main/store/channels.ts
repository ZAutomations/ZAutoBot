/**
 * Channel store — channels live in one JSON file, not one file each.
 */
import { randomUUID } from 'node:crypto'
import type { Channel } from '@shared/types'
import { readJson, updateJson } from './jsonStore'
import { paths } from './paths'

interface ChannelFile {
  channels: Channel[]
}

const EMPTY: ChannelFile = { channels: [] }

export async function listChannels(): Promise<Channel[]> {
  const file = await readJson<ChannelFile>(paths.channels(), EMPTY)
  return Array.isArray(file.channels) ? file.channels : []
}

export async function saveChannel(
  input: Partial<Channel> & { name: string }
): Promise<Channel> {
  const now = Date.now()
  const channel: Channel = {
    id: input.id ?? randomUUID(),
    name: input.name.trim(),
    skillId: input.skillId,
    shortsOutputDir: input.shortsOutputDir,
    longsOutputDir: input.longsOutputDir,
    createdAt: input.createdAt ?? now
  }

  await updateJson<ChannelFile>(paths.channels(), EMPTY, (file) => {
    const channels = Array.isArray(file.channels) ? file.channels : []
    const index = channels.findIndex((c) => c.id === channel.id)
    if (index >= 0) channels[index] = { ...channels[index], ...channel }
    else channels.push(channel)
    return { channels }
  })

  return channel
}

export async function updateChannel(
  id: string,
  patch: Partial<Channel>
): Promise<Channel | null> {
  let updated: Channel | null = null
  await updateJson<ChannelFile>(paths.channels(), EMPTY, (file) => {
    const channels = Array.isArray(file.channels) ? file.channels : []
    const index = channels.findIndex((c) => c.id === id)
    if (index >= 0) {
      channels[index] = { ...channels[index], ...patch, id }
      updated = channels[index]
    }
    return { channels }
  })
  return updated
}

export async function deleteChannel(id: string): Promise<void> {
  await updateJson<ChannelFile>(paths.channels(), EMPTY, (file) => ({
    channels: (file.channels ?? []).filter((c) => c.id !== id)
  }))
}

export async function getChannel(id: string): Promise<Channel | null> {
  const channels = await listChannels()
  return channels.find((c) => c.id === id) ?? null
}
