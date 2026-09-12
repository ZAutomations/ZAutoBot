/**
 * The TTS engine contract.
 *
 * Adding an engine later (Piper, Qwen3-TTS, NeuTTS, Gemini…) is: implement this interface
 * in `engines/<id>.ts`, add one metadata entry to `TTS_ENGINES`, and register it in
 * `registry.ts`. Nothing else in the app changes — the fallback chain, the voice
 * resolution, the engine bar and the settings page all read from the registry.
 */
import type {
  AppSettings,
  SynthesizeOptions,
  SynthesizeResult,
  TtsProviderId,
  TtsVoice
} from '@shared/types'

export interface TtsEngine {
  readonly id: TtsProviderId

  /**
   * False when a required dependency or key is missing. An unavailable engine is skipped
   * by the fallback chain rather than throwing mid-pipeline.
   */
  isAvailable(settings: AppSettings): Promise<boolean>

  /**
   * Human-readable reason shown next to the engine when it cannot be used.
   *
   * Only meaningful when `isAvailable` returned false — implementations may assume that and
   * describe the blocking condition rather than re-deriving whether one exists. Callers that
   * show this text must gate it on `isAvailable`, because an available engine can still have
   * a configured-but-unused path to report.
   */
  unavailableReason(settings: AppSettings): string

  listVoices(settings: AppSettings): Promise<TtsVoice[]>

  synthesize(
    text: string,
    voiceId: string,
    options: SynthesizeOptions,
    settings: AppSettings
  ): Promise<SynthesizeResult>

  /** Settings-page "Test" button. */
  test?(settings: AppSettings): Promise<{ ok: boolean; message: string }>
}

/**
 * Thrown when an engine is selected but cannot run. The fallback chain catches this and
 * moves on — a missing key downgrades the voice, it never kills the run.
 */
export class EngineUnavailableError extends Error {
  constructor(
    readonly engineId: TtsProviderId,
    message: string
  ) {
    super(message)
    this.name = 'EngineUnavailableError'
  }
}

/** Helper for engines that are registered but not yet implemented. */
export function createUnavailableEngine(id: TtsProviderId, reason: string): TtsEngine {
  return {
    id,
    async isAvailable() {
      return false
    },
    unavailableReason() {
      return reason
    },
    async listVoices() {
      return []
    },
    async synthesize() {
      throw new EngineUnavailableError(id, reason)
    }
  }
}
