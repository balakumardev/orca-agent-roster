// Agent Roster: the refresh scheduler.
//
// Single-flight: a refresh never starts while another is running. A trigger that arrives meanwhile
// is coalesced into exactly one more run after the current one. Event triggers are debounced with
// a ceiling, so a steady stream of agent events still refreshes every `maxWaitMs`. A timer
// refreshes every `intervalMs` regardless (needed for the 30-minute decay and the time text).
// Every timer comes in through `deps`, so tests drive it with a fake clock.

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  setInterval(fn: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}

export type PollResult<T> = { ok: true; value: T } | { ok: false; error: unknown }

export interface PollerOptions<T> {
  /** One refresh. May throw or reject: that becomes `{ ok: false }`. */
  run(): Promise<T>
  /** Receives every outcome. A throw here is swallowed. */
  onResult(result: PollResult<T>): void
  timers: Timers
  now(): number
  intervalMs: number
  debounceMs: number
  maxWaitMs: number
}

export interface Poller {
  /** Starts the interval timer and runs the first refresh. */
  start(): void
  /** Clears every timer and stops further runs. */
  stop(): void
  /** Debounced trigger for events. Never throws. */
  request(): void
  /**
   * Resolves once the next refresh that STARTS after this call has completed: the run it starts
   * itself, or, when one is already in flight, the coalesced re-run behind it (the run in flight
   * began before the call, so its data may be older than the caller's reason to ask). It does not
   * wait for the whole merged loop, so a steady stream of triggers cannot keep it pending. `stop()`
   * releases it. Never rejects.
   */
  refreshNow(): Promise<void>
  isRunning(): boolean
}

export function createPoller<T>(opts: PollerOptions<T>): Poller {
  let stopped = true
  let inflight: Promise<void> | null = null
  let rerun = false
  let interval: unknown = null
  let debounce: unknown = null
  let firstRequestAt: number | null = null
  /** Runs started and finished so far; a waiter wants run number `target` to be finished. */
  let started = 0
  let finished = 0
  let waiters: Array<{ target: number; release: () => void }> = []

  function release(all: boolean): void {
    const ready = waiters.filter((w) => all || w.target <= finished)
    waiters = waiters.filter((w) => !ready.includes(w))
    for (const w of ready) w.release()
  }

  function deliver(result: PollResult<T>): void {
    try {
      opts.onResult(result)
    } catch {
      // A broken consumer must not stop the poller.
    }
  }

  function refreshNow(): Promise<void> {
    if (stopped) return Promise.resolve()
    const wanted = new Promise<void>((resolve) => waiters.push({ target: started + 1, release: resolve }))
    if (inflight) {
      rerun = true
      return wanted
    }
    inflight = (async () => {
      try {
        do {
          rerun = false
          started++
          try {
            // A synchronous throw becomes a rejected promise, so the `await` below always yields
            // and `inflight` is assigned before this async function's `finally` can clear it.
            let pending: Promise<T>
            try {
              pending = Promise.resolve(opts.run())
            } catch (e) {
              pending = Promise.reject(e)
            }
            deliver({ ok: true, value: await pending })
          } catch (error) {
            deliver({ ok: false, error })
          }
          finished++
          release(false)
        } while (rerun && !stopped)
      } finally {
        inflight = null
      }
    })()
    return wanted
  }

  function clearDebounce(): void {
    if (debounce !== null) opts.timers.clearTimeout(debounce)
    debounce = null
    firstRequestAt = null
  }

  function request(): void {
    if (stopped) return
    try {
      const t = opts.now()
      if (firstRequestAt === null) firstRequestAt = t
      if (debounce !== null) opts.timers.clearTimeout(debounce)
      const wait = Math.max(0, Math.min(opts.debounceMs, firstRequestAt + opts.maxWaitMs - t))
      debounce = opts.timers.setTimeout(() => {
        debounce = null
        firstRequestAt = null
        void refreshNow()
      }, wait)
    } catch {
      // Timers failing must not surface into an event handler.
    }
  }

  return {
    start() {
      if (!stopped) return
      stopped = false
      interval = opts.timers.setInterval(() => void refreshNow(), opts.intervalMs)
      void refreshNow()
    },
    stop() {
      stopped = true
      rerun = false
      if (interval !== null) opts.timers.clearInterval(interval)
      interval = null
      clearDebounce()
      release(true)
    },
    request,
    refreshNow,
    isRunning: () => inflight !== null
  }
}
