/**
 * A very small Chrome DevTools Protocol client.
 *
 * Written by hand rather than pulled in as a dependency because it only ever needs four
 * verbs — create a tab, attach to it, run a script in it, close it — and Node 22 (which is
 * what Electron 36 ships) has a global `WebSocket`, so the whole thing is a message router.
 *
 * Requests are correlated by an incrementing id; events are pushed by method name and,
 * importantly, by session. One socket carries every tab, so a `Page.loadEventFired` for the
 * wrong tab would resolve the wrong promise if sessions were ignored.
 */

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

type EventHandler = (params: Record<string, unknown>, sessionId?: string) => void

interface CdpMessage {
  id?: number
  method?: string
  params?: Record<string, unknown>
  sessionId?: string
  result?: unknown
  error?: { message: string }
}

/** How long any single protocol call may take before it is treated as a hang. */
const CALL_TIMEOUT_MS = 30_000

export class CdpConnection {
  private readonly socket: WebSocket
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly listeners = new Map<string, Set<EventHandler>>()
  private closed = false

  private constructor(socket: WebSocket) {
    this.socket = socket
    socket.addEventListener('message', (event) => this.receive(String(event.data)))
    socket.addEventListener('close', () => this.failEverything('Chrome closed the connection.'))
    socket.addEventListener('error', () => this.failEverything('Chrome connection errored.'))
  }

  /** Connect to a browser-level DevTools socket. */
  static open(wsUrl: string, timeoutMs = 15_000): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(wsUrl)
      const timer = setTimeout(() => {
        socket.close()
        reject(new Error(`Chrome did not accept a DevTools connection within ${timeoutMs}ms.`))
      }, timeoutMs)

      socket.addEventListener('open', () => {
        clearTimeout(timer)
        resolve(new CdpConnection(socket))
      })
      socket.addEventListener('error', () => {
        clearTimeout(timer)
        reject(new Error('Could not open a DevTools connection to Chrome.'))
      })
    })
  }

  private receive(raw: string): void {
    let message: CdpMessage
    try {
      message = JSON.parse(raw) as CdpMessage
    } catch {
      return
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(message.id)

      if (message.error) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result)
      return
    }

    if (message.method) {
      for (const handler of this.listeners.get(message.method) ?? []) {
        handler(message.params ?? {}, message.sessionId)
      }
    }
  }

  private failEverything(reason: string): void {
    this.closed = true
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error(reason))
    }
    this.pending.clear()
  }

  get isClosed(): boolean {
    return this.closed
  }

  call<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string
  ): Promise<T> {
    if (this.closed) return Promise.reject(new Error('The Chrome connection is closed.'))

    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Chrome did not answer ${method} within ${CALL_TIMEOUT_MS}ms.`))
      }, CALL_TIMEOUT_MS)

      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer
      })

      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }

  /** Subscribe to a protocol event. Pass `sessionId` to only hear one tab's events. */
  on(method: string, handler: EventHandler, sessionId?: string): () => void {
    const wrapped: EventHandler = (params, from) => {
      if (sessionId && from !== sessionId) return
      handler(params, from)
    }

    const set = this.listeners.get(method) ?? new Set<EventHandler>()
    set.add(wrapped)
    this.listeners.set(method, set)

    return () => set.delete(wrapped)
  }

  close(): void {
    this.closed = true
    try {
      this.socket.close()
    } catch {
      // Closing an already-dead socket is not interesting.
    }
    this.failEverything('The Chrome connection was closed.')
  }
}
