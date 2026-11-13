// A fake clock for tests: timers fire only when the test advances time.

export function fakeClock(start = 0) {
  let now = start
  let nextId = 1
  const timeouts = new Map<number, { at: number; fn: () => void }>()
  const intervals = new Map<number, { every: number; next: number; fn: () => void }>()
  return {
    now: () => now,
    timers: {
      setTimeout(fn: () => void, ms: number) {
        const id = nextId++
        timeouts.set(id, { at: now + ms, fn })
        return id
      },
      clearTimeout(h: unknown) {
        timeouts.delete(h as number)
      },
      setInterval(fn: () => void, ms: number) {
        const id = nextId++
        intervals.set(id, { every: ms, next: now + ms, fn })
        return id
      },
      clearInterval(h: unknown) {
        intervals.delete(h as number)
      }
    },
    /** Moves time forward, firing due timers in order (async work is awaited by the caller). */
    tick(ms: number) {
      const end = now + ms
      for (;;) {
        let best: { at: number; fire: () => void } | null = null
        for (const [id, t] of timeouts) if (t.at <= end && (!best || t.at < best.at)) best = { at: t.at, fire: () => { timeouts.delete(id); t.fn() } }
        for (const t of intervals.values()) if (t.next <= end && (!best || t.next < best.at)) best = { at: t.next, fire: () => { t.next += t.every; t.fn() } }
        if (!best) break
        now = best.at
        best.fire()
      }
      now = end
    },
    pending: () => timeouts.size + intervals.size
  }
}
