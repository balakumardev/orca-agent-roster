import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPoller } from '../src/poller.ts'
import type { PollResult } from '../src/poller.ts'
import { fakeClock } from './clock.ts'

/** A run() the test resolves by hand, so overlap can be arranged. */
function manualRun() {
  const calls: Array<{ resolve: (v: number) => void; reject: (e: unknown) => void }> = []
  return {
    calls,
    run: () =>
      new Promise<number>((resolve, reject) => {
        calls.push({ resolve, reject })
      })
  }
}

const settle = () => new Promise<void>((r) => setImmediate(r))

function setup(extra: { run?: () => Promise<number>; onResult?: (r: PollResult<number>) => void } = {}) {
  const clock = fakeClock()
  const manual = manualRun()
  const results: Array<PollResult<number>> = []
  const poller = createPoller<number>({
    run: extra.run ?? manual.run,
    onResult: extra.onResult ?? ((r) => void results.push(r)),
    timers: clock.timers,
    now: clock.now,
    intervalMs: 30_000,
    debounceMs: 400,
    maxWaitMs: 2_000
  })
  return { clock, manual, results, poller }
}

test('start runs the first refresh at once and arms the 30 s interval', async () => {
  const { clock, manual, results, poller } = setup()
  poller.start()
  assert.equal(manual.calls.length, 1)
  manual.calls[0]!.resolve(1)
  await settle()
  assert.deepEqual(results, [{ ok: true, value: 1 }])
  clock.tick(29_999)
  assert.equal(manual.calls.length, 1)
  clock.tick(1)
  assert.equal(manual.calls.length, 2) // interval fired
  manual.calls[1]!.resolve(2)
  await settle()
  assert.equal(results.length, 2)
  poller.stop()
})

test('single-flight: triggers during a run coalesce into exactly one more run', async () => {
  const { manual, results, poller } = setup()
  poller.start()
  assert.equal(manual.calls.length, 1)
  const a = poller.refreshNow()
  const b = poller.refreshNow()
  const c = poller.refreshNow()
  assert.equal(manual.calls.length, 1, 'no second refresh while one runs')
  assert.equal(poller.isRunning(), true)
  manual.calls[0]!.resolve(1)
  await settle()
  assert.equal(manual.calls.length, 2, 'one coalesced re-run')
  manual.calls[1]!.resolve(2)
  await Promise.all([a, b, c])
  assert.equal(manual.calls.length, 2)
  assert.deepEqual(results.map((r) => (r.ok ? r.value : null)), [1, 2])
  assert.equal(poller.isRunning(), false)
  poller.stop()
})

test('debounce: a burst of requests runs one refresh 400 ms after the last', async () => {
  const { clock, manual, poller } = setup()
  poller.start()
  manual.calls[0]!.resolve(0)
  await settle()
  poller.request()
  clock.tick(300)
  poller.request()
  clock.tick(300)
  poller.request()
  assert.equal(manual.calls.length, 1)
  clock.tick(399)
  assert.equal(manual.calls.length, 1)
  clock.tick(1)
  assert.equal(manual.calls.length, 2)
  manual.calls[1]!.resolve(1)
  await settle()
  poller.stop()
})

test('debounce ceiling: a steady stream of events still refreshes every 2 s', async () => {
  let runs = 0
  const { clock, poller } = setup({ run: () => Promise.resolve(++runs) })
  poller.start()
  await settle()
  assert.equal(runs, 1)
  for (let i = 0; i < 20; i++) {
    poller.request()
    clock.tick(300)
    await settle()
  }
  // 6 s of requests every 300 ms: the debounce alone would never fire (0 refreshes); the ceiling fires about every 2 s
  assert.ok(runs - 1 >= 2 && runs - 1 <= 3, `expected 2-3 ceiling refreshes after the first, got ${runs - 1}`)
  poller.stop()
})

test('a failing run is reported, not thrown, and the next run still happens', async () => {
  const { clock, manual, results, poller } = setup()
  poller.start()
  manual.calls[0]!.reject(new Error('cli down'))
  await settle()
  assert.equal(results[0]!.ok, false)
  clock.tick(30_000)
  manual.calls[1]!.resolve(7)
  await settle()
  assert.deepEqual(results[1], { ok: true, value: 7 })
  poller.stop()
})

test('a run() that throws synchronously does not wedge the poller', async () => {
  let n = 0
  const { clock, results, poller } = setup({
    run: () => {
      n++
      if (n === 1) throw new Error('sync boom')
      return Promise.resolve(n)
    }
  })
  poller.start()
  await settle()
  assert.equal(results[0]!.ok, false)
  assert.equal(poller.isRunning(), false)
  clock.tick(30_000)
  await settle()
  assert.deepEqual(results[1], { ok: true, value: 2 })
  poller.stop()
})

test('an onResult that throws does not stop the poller', async () => {
  let calls = 0
  const { clock, poller } = setup({
    run: () => Promise.resolve(1),
    onResult: () => {
      calls++
      throw new Error('consumer bug')
    }
  })
  poller.start()
  await settle()
  clock.tick(30_000)
  await settle()
  assert.equal(calls, 2)
  poller.stop()
})

test('stop clears every timer and ignores later triggers', async () => {
  const { clock, manual, poller } = setup()
  poller.start()
  manual.calls[0]!.resolve(0)
  await settle()
  poller.request()
  assert.ok(clock.pending() >= 2)
  poller.stop()
  assert.equal(clock.pending(), 0)
  poller.request()
  await poller.refreshNow()
  clock.tick(120_000)
  assert.equal(manual.calls.length, 1)
  assert.equal(clock.pending(), 0)
})

// ---- review fix: refreshNow resolves after the NEXT completed run, not after the whole merged loop ----

test('refreshNow during a steady stream of triggers resolves after the next completed run, while the loop keeps going', async () => {
  const { manual, poller } = setup()
  poller.start()
  assert.equal(manual.calls.length, 1)
  let joined = false
  void poller.refreshNow().then(() => {
    joined = true
  })
  manual.calls[0]!.resolve(1) // run 1 ends; the coalesced run 2 starts
  await settle()
  assert.equal(manual.calls.length, 2)
  assert.equal(joined, false, 'the caller waits for run 2: its data is newer than the run it joined')
  void poller.refreshNow() // another trigger arrives during run 2: the loop will go on to run 3
  manual.calls[1]!.resolve(2)
  await settle()
  assert.equal(manual.calls.length, 3, 'the steady stream keeps the loop going')
  assert.equal(joined, true, 'but the caller was released by run 2, not held until the loop ends')
  poller.stop()
})

test('refreshNow with no run in flight starts one and resolves when that very run is done', async () => {
  const { manual, poller } = setup()
  poller.start()
  manual.calls[0]!.resolve(1)
  await settle()
  let done = false
  void poller.refreshNow().then(() => {
    done = true
  })
  assert.equal(manual.calls.length, 2)
  await settle()
  assert.equal(done, false)
  manual.calls[1]!.resolve(2)
  await settle()
  assert.equal(done, true)
  poller.stop()
})

test('stop releases every caller still waiting on a refresh', async () => {
  const { manual, poller } = setup()
  poller.start()
  let released = 0
  void poller.refreshNow().then(() => released++)
  void poller.refreshNow().then(() => released++)
  assert.equal(manual.calls.length, 1)
  poller.stop()
  await settle()
  assert.equal(released, 2)
})
