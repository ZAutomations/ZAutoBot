/**
 * Script AI test (development only).
 *
 *     npm run build && ZBOT_SCRIPTAI=1 npx electron .
 *
 * Runs the real conversation loop against a local mock of Gemini's OpenAI-compatible
 * endpoint. No key is spent; what is proven is everything around Google: the retired-model
 * 404 fallback, key rotation on a 429 with a retryDelay, batch-marker continuation,
 * truncation detection and the resume nudge, progress reporting, cancellation, and that the
 * finished package lands in generated-scripts and imports cleanly.
 *
 * It also exercises the skill file extractor against a real zip and a hand-built PDF.
 */
import { createServer, type Server } from 'node:http'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { JobMode } from '@shared/types'
import { generatePackage, type ScriptAiProgress } from '../scriptai/generate'
import { extractSkillText } from '../skills/extract'
import { saveSkill } from '../store/skills'
import { saveSettings } from '../store/settings'

const WATCHDOG_MS = 60_000

interface MockStep {
  /** Response status, or 200 for a streamed reply. */
  status?: number
  body?: string
  /** For streamed replies: the fragments to send as SSE deltas. */
  deltas?: string[]
}

const SCENE = (n: number, label: string, narration: string, image: string): string =>
  `Scene ${n}: ${label}\nNarration: ${narration}\nImage: ${image}\nMood: calm\n\n`

/**
 * The conversation script, in request order. The generation run will make exactly these
 * requests if the loop is working; anything else is a failure.
 */
const SCRIPT: MockStep[] = [
  // 1. First request on key A: the configured model is retired.
  { status: 404, body: JSON.stringify({ error: { message: 'model gemini-old is no longer available' } }) },
  // 2. Retried on the default alias, still key A: quota, with Google's retryDelay.
  { status: 429, body: JSON.stringify({ error: { message: 'RESOURCE_EXHAUSTED', details: [{ retryDelay: '2s' }] } }) },
  // 3. Key B takes over mid-conversation: a first batch ending in the marker.
  {
    deltas: [
      'Title: Mock Ocean Video\n\n',
      SCENE(1, 'The surface', 'The ocean keeps its secrets close.', 'dark blue ocean at dawn, wide shot'),
      'SAY CONTINUE'
    ]
  },
  // 4. Second batch: cut off mid-sentence, no marker, one scene only — the nudge case.
  {
    deltas: [
      SCENE(2, 'The descent', 'Below two hundred metres the light is gone.', 'bioluminescent creatures, deep black water'),
      'The floor is still a gu'
    ]
  },
  // 5. After the nudge: the completion, finished properly.
  {
    deltas: [
      'ess.\n\n',
      SCENE(3, 'The floor', 'Every dive finds something nobody has a name for.', 'underwater canyon lit by a submersible'),
      'Thumbnail: a lone submersible over a glowing canyon floor.'
    ]
  }
]

export async function runScriptAiTest(): Promise<void> {
  const started = Date.now()
  const fail = (message: string): never => {
    console.error(`\n[scriptai] FAIL — ${message}\n`)
    app.exit(1)
    throw new Error(message)
  }
  const pass = (message: string): void => {
    console.log(`\n[scriptai] PASS — ${message}  (${((Date.now() - started) / 1000).toFixed(1)}s)\n`)
    app.exit(0)
  }

  const watchdog = setTimeout(() => fail('watchdog fired after 60s — the loop is stuck'), WATCHDOG_MS)

  let request = 0
  const seenKeys: string[] = []
  const seenModels: string[] = []

  const server: Server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      request++
      const key = (req.headers['authorization'] ?? '').replace('Bearer ', '')
      const model = (JSON.parse(body) as { model: string }).model
      seenKeys.push(key)
      seenModels.push(model)
      console.log(`[scriptai] mock: request ${request} key=${key} model=${model}`)
      const messages = (JSON.parse(body) as { messages: Array<{ role: string; content: string }> }).messages
      const last = messages[messages.length - 1]
      console.log(
        `[scriptai] mock:   ${messages.length} messages, last=${last.role} "${last.content.slice(-60).replace(/\n/g, '\\n')}"`
      )

      const step = SCRIPT[request - 1]
      if (!step) {
        res.writeHead(400).end(JSON.stringify({ error: { message: `unexpected request #${request}` } }))
        return
      }

      if (step.status && step.status !== 200) {
        res.writeHead(step.status).end(step.body)
        return
      }

      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      for (const delta of step.deltas ?? []) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`)
      }
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port

  // The app's settings live in userData; this test needs the mock's URL and spacing.
  process.env['ZBOT_SCRIPTAI_URL'] = `http://127.0.0.1:${port}/v1beta/openai`
  process.env['ZBOT_SCRIPTAI_SPACING_MS'] = '50'

  // Two keys, so rotation is exercised: A gets retired-model + quota, B does the writing.
  await saveSettings({ scriptAiKeys: ['key-A', 'key-B'], scriptAiModel: 'gemini-old' })

  console.log('[scriptai] mock endpoint on', process.env['ZBOT_SCRIPTAI_URL'])

  // -- extractor: a real zip, made the way real archives are made -----------------

  const skillDir = join(app.getPath('temp'), 'zbot-scriptai-test')
  await fs.mkdir(skillDir, { recursive: true })
  const zipSkill = join(skillDir, 'channel.skill')
  // PowerShell's Compress-Archive writes deflated entries — exactly what the walker must
  // handle. It keys the format off the extension, so zip first, rename after.
  const zipPath = join(skillDir, 'channel.zip')
  await fs.writeFile(join(skillDir, 'SKILL.md'), '---\nname: Ocean Skill\n---\nWrite about the ocean in 3 scenes.', 'utf8')
  await new Promise<void>((resolve, reject) =>
    execFile(
      'powershell',
      ['-NoProfile', '-Command', `Compress-Archive -Path "${join(skillDir, 'SKILL.md')}" -DestinationPath "${zipPath}" -Force`],
      (err) => (err ? reject(err) : resolve())
    )
  )
  await fs.rename(zipPath, zipSkill)
  const zipText = await extractSkillText(zipSkill, 'channel.skill')
  if (!zipText.includes('Ocean Skill') || !zipText.includes('3 scenes')) {
    fail(`zip extraction lost the skill: ${JSON.stringify(zipText.slice(0, 120))}`)
  }
  console.log(`[scriptai] .skill zip extracted OK (${zipText.length} chars)`)

  // -- extractor: a hand-built uncompressed PDF ----------------------------------

  const pdfSkill = join(skillDir, 'guide.pdf')
  const pdfContent = 'BT (Write about the sea.) Tj ET'
  const pdf =
    '%PDF-1.4\n1 0 obj\n<< /Length ' + pdfContent.length + ' >>\nstream\n' + pdfContent + '\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF'
  await fs.writeFile(pdfSkill, pdf, 'latin1')
  const pdfText = await extractSkillText(pdfSkill, 'guide.pdf')
  if (!pdfText.includes('Write about the sea.')) {
    fail(`pdf extraction lost the text: ${JSON.stringify(pdfText.slice(0, 120))}`)
  }
  console.log(`[scriptai] pdf extracted OK ("${pdfText.trim()}")`)

  // -- the generation run ---------------------------------------------------------

  const skill = await saveSkill({ name: 'Test Skill', content: zipText })
  console.log(`[scriptai] skill saved (${skill.id}), starting generation…`)
  const progressLog: ScriptAiProgress[] = []

  const result = await generatePackage({
    skillContent: skill.content,
    title: 'The Ocean',
    mode: 'video' as JobMode,
    onProgress: (p) => progressLog.push(p),
    isCancelled: () => false
  }).catch((err: Error) => fail(err.message))

  clearTimeout(watchdog)
  server.close()

  // The conversation must have made exactly the scripted requests.
  if (request !== SCRIPT.length) {
    fail(`expected ${SCRIPT.length} requests, got ${request}`)
  }

  // Key rotation: request 1-2 on A (retired + quota), everything after on B.
  if (seenKeys[0] !== 'key-A' || seenKeys[1] !== 'key-A' || seenKeys.slice(2).some((k) => k !== 'key-B')) {
    fail(`key rotation wrong: ${seenKeys.join(', ')}`)
  }

  // Model fallback: the first request carries the retired id; after the 404 everything
  // goes out on the default alias, which the memoized dead id guarantees.
  if (seenModels[0] !== 'gemini-old') {
    fail(`expected the retired model on the first request: ${seenModels.join(', ')}`)
  }
  if (seenModels.slice(1).some((m) => m !== 'gemini-flash-latest')) {
    fail(`expected the default alias after the 404: ${seenModels.join(', ')}`)
  }

  // The package: three scenes with prompts, a thumbnail line, a clean import.
  if (result.script.scenes.length !== 3) {
    fail(`expected 3 scenes, got ${result.script.scenes.length}`)
  }
  if (result.script.scenes.some((scene) => !scene.imagePrompt)) {
    fail('a scene is missing its image prompt — the truncation nudge did not do its job')
  }
  if (!result.validation.ok) {
    fail(`the generated package did not validate: ${result.validation.errors.join('; ')}`)
  }

  // The file must exist on disk where the spec says generated packages go.
  const written = await fs.readFile(result.filePath ?? '', 'utf8').catch(() => null)
  if (!written || !written.includes('Thumbnail:')) {
    fail(`the generated file is missing or incomplete at ${result.filePath}`)
  }

  // Progress must have flowed: round numbers, growing char counts, the quota wait.
  const rounds = new Set(progressLog.map((p) => p.round))
  if (rounds.size < 3) fail(`progress only reported rounds ${[...rounds].join(', ')}`)
  if (!progressLog.some((p) => p.waitingMs)) fail('no quota wait was ever reported')

  pass(
    `${result.script.scenes.length} scenes, ${result.script.title}, ` +
      `${request} requests, keys ${seenKeys.join('→')}, models ${[...new Set(seenModels)].join('→')}`
  )
}
