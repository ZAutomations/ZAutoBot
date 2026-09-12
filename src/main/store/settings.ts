/**
 * Settings persistence with the secrets pattern from the spec.
 *
 * On disk every secret is stored as `<name>Enc` (Electron `safeStorage`). The plain field
 * exists **in memory only**, and `*Enc` fields are NEVER returned to the renderer.
 */
import { safeStorage } from 'electron'
import { DEFAULT_SETTINGS } from '@shared/constants'
import type { AppSettings } from '@shared/types'
import { fileExists, readJson, readJsonStrict, writeJson } from './jsonStore'
import { paths } from './paths'

/** Fields that must never be written to disk in the clear. */
const SECRET_FIELDS = ['azureKey', 'ai33Key', 'fameSpeakKey', 'geminiKey', 'pexelsApiKey'] as const
type SecretField = (typeof SECRET_FIELDS)[number]

/** Raw on-disk shape: known settings plus their encrypted counterparts. */
type RawSettings = Record<string, unknown>

const KNOWN_KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof AppSettings)[]

function isSecretField(key: string): key is SecretField {
  return (SECRET_FIELDS as readonly string[]).includes(key)
}

/**
 * Copy only keys we actually know about. This is what keeps `*Enc` blobs out of anything
 * the renderer can see — they are not in DEFAULT_SETTINGS, so they are never picked.
 */
function pickKnown(raw: RawSettings): Partial<AppSettings> {
  const out: Record<string, unknown> = {}
  for (const key of KNOWN_KEYS) {
    const value = raw[key]
    if (value !== undefined) out[key] = value
  }
  return out as Partial<AppSettings>
}

function encrypt(plain: string): string | null {
  if (!plain) return null
  if (!safeStorage.isEncryptionAvailable()) {
    // Only reachable on a non-Windows dev machine. The product is Windows-only, so this
    // degrades rather than failing — but it is loud about it.
    console.warn('[settings] safeStorage unavailable — storing secret in the clear')
    return null
  }
  return safeStorage.encryptString(plain).toString('base64')
}

function decrypt(encoded: string): string | null {
  try {
    return safeStorage.decryptString(Buffer.from(encoded, 'base64'))
  } catch (err) {
    // Happens when the OS master key is gone — e.g. a profile rename that did not carry
    // `Local State` over. The key is unrecoverable; the user must re-enter it.
    console.error('[settings] could not decrypt a stored secret:', (err as Error).message)
    return null
  }
}

/**
 * Strict read for the read-modify-write path. A missing file is a legitimate first run;
 * a corrupt one throws rather than silently becoming defaults on the next save.
 */
async function readRawForWrite(): Promise<RawSettings> {
  const file = paths.settings()
  if (!(await fileExists(file))) return {}
  return readJsonStrict<RawSettings>(file)
}

/** Load settings with secrets decrypted into memory. Safe to hand to the renderer. */
export async function loadSettings(): Promise<AppSettings> {
  const raw = await readJson<RawSettings>(paths.settings(), {})
  const settings: AppSettings = { ...DEFAULT_SETTINGS, ...pickKnown(raw) }

  for (const field of SECRET_FIELDS) {
    const encoded = raw[`${field}Enc`]
    if (typeof encoded === 'string' && encoded) {
      const plain = decrypt(encoded)
      if (plain !== null) settings[field] = plain
    }
  }

  // The Script AI key pool is an array in memory but one blob on disk: the secrets
  // pattern encrypts strings, so the lines are joined before encrypting and split again
  // here. An unencrypted array (hand-edited settings) still loads.
  const keysEnc = raw['scriptAiKeysEnc']
  if (typeof keysEnc === 'string' && keysEnc) {
    const plain = decrypt(keysEnc)
    if (plain !== null) {
      settings.scriptAiKeys = plain
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
    }
  }

  return settings
}

/**
 * Merge a patch and persist. Encrypted fields already on disk are preserved untouched, so
 * a partial save never drops a key it did not know about.
 */
export async function saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const next: RawSettings = { ...(await readRawForWrite()) }

  for (const [key, value] of Object.entries(patch)) {
    if (key.endsWith('Enc')) continue // renderer may never write these
    if (!KNOWN_KEYS.includes(key as keyof AppSettings)) continue

    // The key pool joins into one blob — see the mirror-image note in loadSettings.
    if (key === 'scriptAiKeys') {
      const plain = Array.isArray(value) ? value.map((k) => String(k).trim()).filter(Boolean).join('\n') : ''
      const encoded = encrypt(plain)
      if (encoded === null) {
        if (plain) next[key] = plain.split('\n')
        else delete next[key]
        delete next['scriptAiKeysEnc']
      } else {
        next['scriptAiKeysEnc'] = encoded
        delete next[key]
      }
      continue
    }

    if (isSecretField(key)) {
      const plain = value == null ? '' : String(value)
      const encoded = encrypt(plain)
      if (encoded === null) {
        // No OS encryption available — keep it usable in the clear rather than losing it.
        if (plain) next[key] = plain
        else delete next[key]
        delete next[`${key}Enc`]
      } else {
        next[`${key}Enc`] = encoded
        delete next[key]
      }
      continue
    }

    next[key] = value
  }

  await writeJson(paths.settings(), next)
  return loadSettings()
}
