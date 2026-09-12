/**
 * Cancellation and pause for running pipelines.
 *
 * One flag, checked at every loop boundary. The browser providers keep their own static
 * flag and the orchestrator adopts it — but the flag must be READ inside every retry
 * loop, or setting it while a loop reopens browser tabs looks like Stop doing nothing.
 */

export class PipelineCancelledError extends Error {
  constructor() {
    super('Cancelled')
    this.name = 'PipelineCancelledError'
  }
}

export class Cancellation {
  private cancelled = false
  private paused = false
  private pauseWaiters: Array<() => void> = []

  cancel(): void {
    this.cancelled = true
    this.paused = false
    this.releaseWaiters()
  }

  get isCancelled(): boolean {
    return this.cancelled
  }

  get isPaused(): boolean {
    return this.paused
  }

  pause(): void {
    if (!this.cancelled) this.paused = true
  }

  resume(): void {
    this.paused = false
    this.releaseWaiters()
  }

  private releaseWaiters(): void {
    const waiters = this.pauseWaiters.splice(0)
    for (const resolve of waiters) resolve()
  }

  /** Blocks while paused. Returns immediately once cancelled. */
  async waitWhilePaused(): Promise<void> {
    while (this.paused && !this.cancelled) {
      await new Promise<void>((resolve) => this.pauseWaiters.push(resolve))
    }
  }

  /** The checkpoint every loop calls. */
  throwIfCancelled(): void {
    if (this.cancelled) throw new PipelineCancelledError()
  }
}

const active = new Map<string, Cancellation>()

export function createCancellation(projectId: string): Cancellation {
  const token = new Cancellation()
  active.set(projectId, token)
  return token
}

export function getCancellation(projectId: string): Cancellation | undefined {
  return active.get(projectId)
}

export function disposeCancellation(projectId: string): void {
  active.delete(projectId)
}

export function cancelPipeline(projectId: string): boolean {
  const token = active.get(projectId)
  if (!token) return false
  token.cancel()
  return true
}

export function isPipelineRunning(projectId: string): boolean {
  return active.has(projectId)
}

export function runningProjectIds(): string[] {
  return [...active.keys()]
}
