/**
 * WAV writing for the engines that hand back raw samples.
 *
 * Edge returns MP3 and needs none of this — but Gemini answers in 16-bit PCM and Kokoro in
 * float samples, and both have to land on disk as a playable file before ffmpeg will touch
 * them.
 */

export interface Pcm {
  data: Buffer
  sampleRate: number
  channels: number
  bitsPerSample: number
}

/** Convert float samples into signed 16-bit little-endian PCM. */
export function encodePcm16(samples: Float32Array): Buffer {
  const out = Buffer.alloc(samples.length * 2)
  for (let i = 0; i < samples.length; i++) {
    // Float samples are nominally -1..1 but a model can overshoot; clamp rather than wrap.
    const clamped = Math.max(-1, Math.min(1, samples[i]))
    out.writeInt16LE(Math.round(clamped * 32767), i * 2)
  }
  return out
}

/** Wrap raw PCM in a 44-byte canonical WAV header. */
export function buildWav(pcm: Pcm): Buffer {
  const { data, sampleRate, channels, bitsPerSample } = pcm
  const blockAlign = (channels * bitsPerSample) / 8
  const header = Buffer.alloc(44)

  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16) // PCM fmt chunk size
  header.writeUInt16LE(1, 20) // format = PCM
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * blockAlign, 28) // byte rate
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(bitsPerSample, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(data.length, 40)

  return Buffer.concat([header, data])
}

/** Join the float samples of several streamed chunks into one mono PCM16 WAV. */
export function wavFromFloatChunks(chunks: Float32Array[], sampleRate: number): Buffer {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const merged = new Float32Array(total)

  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.length
  }

  return buildWav({
    data: encodePcm16(merged),
    sampleRate,
    channels: 1,
    bitsPerSample: 16
  })
}
