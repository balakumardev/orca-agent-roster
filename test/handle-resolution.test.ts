// A shortcut press or a panel click finds its terminal when it is pressed, not from the model the
// last refresh left behind: a poll can run before Orca has registered a terminal, and the same
// press a moment later works. Everything here runs against the fake CLI; nothing can reach Orca.

import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import * as worker from '../src/worker.ts'
import type { Roster } from '../src/worker.ts'
import type { RosterModel } from '../src/model.ts'
import { NOW, agent, psOf, terminal, terminalsOf, verdict, worktree } from './fixtures.ts'
import { drive, newRig, newWorld, sampleWorld, settle } from './rig.ts'
import type { Rig, World } from './rig.ts'

const T = { timeout: 8000 }

let started: Roster | null = null
afterEach(async () => {
  started?.stop()
  started = null
  await worker.deactivate()
  worker.resetDeps()
})

async function boot(rig: Rig): Promise<Roster> {
  started = worker.createRoster(rig.fake.orca, rig.deps)
  await settle()
  return started
}

/** Lets the one quick re-poll a handle-less row schedules run now, so a test's own counts start clean. */
async function flushQuickRepoll(rig: Rig): Promise<void> {
  rig.clock.tick(1000)
  await settle()
}

const press = (rig: Rig, id = 'agent-roster.next', signal?: AbortSignal) =>
  rig.fake.commands.get(id)!(undefined, { signal: signal ?? new AbortController().signal }) as Promise<string | undefined>
const pressDriven = (rig: Rig, id = 'agent-roster.next') => drive(rig, press(rig, id))
const focus = (rig: Rig, paneKey: string) =>
  drive(rig, Promise.resolve(rig.fake.handlers.get('roster.focus')!({ paneKey }))) as Promise<{ ok: boolean; reason?: string }>

// ---- worlds ------------------------------------------------------------------------------------

const P1 = 'tab0123456789:leaf9876543210'
const P2 = 'tab2222222222:leaf2222222222'

const claude = (paneKey: string, ago: number, over: Record<string, unknown> = {}) =>
  agent({ paneKey, agentType: 'claude', activity: verdict({ status: 'working', sortAt: NOW - ago }), ...over })
const term = (paneKey: string, handle: string, over: Record<string, unknown> = {}) =>
  terminal(paneKey, { handle, worktreeId: 'wa', agentIdentity: 'claude', title: 'SECRET-TITLE-do-not-log', ...over })

/** One worktree, two claude agents; p1 is newer so `next` from a fresh start lands on it. */
function pair(): { world: World; full: Record<string, unknown>[] } {
  const full = [term(P1, 'h-1'), term(P2, 'h-2')]
  const world = newWorld(
    psOf(worktree({ worktreeId: 'wa', displayName: 'alpha', isActive: true }, [claude(P1, 60_000, { prompt: 'SECRET-PROMPT-do-not-log' }), claude(P2, 120_000)])),
    terminalsOf(...full)
  )
  return { world, full }
}

/** The fresh list answers `partial` until action-time call number `nth` and `full` from then on. */
function appearsOnCall(world: World, nth: number, full: Record<string, unknown>[], partial: Record<string, unknown>[]): void {
  const base = world.listCalls
  world.terminals = terminalsOf(...partial)
  world.onList = (n) => {
    if (n - base >= nth) world.terminals = terminalsOf(...full)
  }
}

const listsSince = (world: World, base: number) => world.listCalls - base
const diagLines = (rig: Rig) => rig.fake.logs.filter((l) => l.includes('handle lookup'))

// ---- the fresh list is the truth -------------------------------------------------------------

test('a press asks Orca for the terminal list when it is pressed, and the fresh handle wins over the cached one', T, async () => {
  const { world, full } = pair()
  const rig = newRig({ world })
  await boot(rig)
  const base = world.listCalls
  world.terminals = terminalsOf(term(P1, 'h-1-new'), full[1]!) // the same pane, a new terminal behind it
  assert.equal(await pressDriven(rig), undefined)
  assert.deepEqual(world.switched, ['h-1-new'])
  assert.equal(listsSince(world, base), 1, 'one fresh list, found at once')
  assert.deepEqual(diagLines(rig), [], 'a first-try hit logs nothing')
})

test('a click on a row also looks the terminal up when it is clicked', T, async () => {
  const { world, full } = pair()
  const rig = newRig({ world })
  await boot(rig)
  world.terminals = terminalsOf(term(P2, 'h-2-new'), full[0]!)
  assert.deepEqual(await focus(rig, P2), { ok: true })
  assert.deepEqual(world.switched, ['h-2-new'])
})

test('a pane missing from the first fresh list and present on the second: the press succeeds', T, async () => {
  const { world, full } = pair()
  const rig = newRig({ world })
  await boot(rig)
  appearsOnCall(world, 2, full, [full[1]!]) // p2's terminal is listed (so it is not a stray), p1's is not yet
  assert.equal(await pressDriven(rig), undefined)
  assert.deepEqual(world.switched, ['h-1'])
  const lines = diagLines(rig)
  assert.equal(lines.length, 1, 'one line for the whole action')
  assert.match(lines[0]!, /attempt 2/)
})

test('the first retry waits about 250 ms, the next 500 ms and the last 800 ms', T, async () => {
  const { world, full } = pair()
  const rig = newRig({ world })
  await boot(rig)
  const base = world.listCalls
  appearsOnCall(world, 4, full, [full[1]!])
  await pressDriven(rig)
  const lists = world.timing.filter((c) => c.kind === 'list').slice(base)
  assert.equal(lists.length, 4)
  const gaps = lists.slice(1).map((c, i) => c.at - lists[i]!.at)
  // the fake list answers at once, so each gap is its backoff, rounded up to the 50 ms test step
  assert.ok(gaps[0]! >= 250 && gaps[0]! <= 350, `first gap ${gaps[0]}`)
  assert.ok(gaps[1]! >= 500 && gaps[1]! <= 600, `second gap ${gaps[1]}`)
  assert.ok(gaps[2]! >= 800 && gaps[2]! <= 900, `third gap ${gaps[2]}`)
  assert.deepEqual(world.switched, ['h-1'])
  assert.match(diagLines(rig)[0]!, /attempt 4/)
})

test('a click retries the same way', T, async () => {
  const { world, full } = pair()
  const rig = newRig({ world })
  await boot(rig)
  const base = world.listCalls
  appearsOnCall(world, 3, full, [full[1]!])
  assert.deepEqual(await focus(rig, P1), { ok: true })
  assert.deepEqual(world.switched, ['h-1'])
  assert.equal(listsSince(world, base), 3, 'found on the third look')
})

// ---- fallbacks -----------------------------------------------------------------------------------

test('never appears: the only unclaimed terminal of the same agent type in the same worktree is used (fallback a)', T, async () => {
  const { world, full } = pair()
  const rig = newRig({ world })
  await boot(rig)
  world.terminals = terminalsOf(full[1]!, term('tabzzzz:leafzzzz', 'h-z'))
  assert.equal(await pressDriven(rig), undefined)
  assert.deepEqual(world.switched, ['h-z'])
  assert.match(diagLines(rig)[0]!, /same agent type/)
})

test('two candidates in the worktree: no guess, and the press skips to the next resolvable row', T, async () => {
  const { world, full } = pair()
  const rig = newRig({ world })
  await boot(rig)
  world.terminals = terminalsOf(full[1]!, term('tabyyyy:leafyyyy', 'h-y'), term('tabzzzz:leafzzzz', 'h-z'))
  assert.equal(await pressDriven(rig), undefined)
  assert.deepEqual(world.switched, ['h-2'], 'p1 has two look-alikes, so p2 is next')
  assert.equal(await focus(rig, P1).then((r) => r.ok), false, 'a click on p1 does not guess either')
  assert.deepEqual(world.switched, ['h-2'])
})

test('a terminal that belongs to another agent is never a fallback for this one', T, async () => {
  const { world, full } = pair()
  const rig = newRig({ world })
  await boot(rig)
  world.terminals = terminalsOf(full[1]!) // only p2 has a terminal; it is the only claude terminal in the worktree
  const res = await focus(rig, P1)
  assert.equal(res.ok, false)
  assert.deepEqual(world.switched, [], "p2's terminal is not p1's")
})

test('a terminal of another agent type in the worktree is no fallback by type', T, async () => {
  const { world, full } = pair()
  const rig = newRig({ world })
  await boot(rig)
  world.terminals = terminalsOf(full[1]!, term('tabzzzz:leafzzzz', 'h-z', { agentIdentity: 'codex' }))
  assert.equal((await focus(rig, P1)).ok, false)
  assert.deepEqual(world.switched, [])
})

test('a terminal in another worktree is no fallback by type', T, async () => {
  const { world, full } = pair()
  const rig = newRig({ world })
  await boot(rig)
  world.terminals = terminalsOf(full[1]!, term('tabzzzz:leafzzzz', 'h-z', { worktreeId: 'other' }))
  assert.equal((await focus(rig, P1)).ok, false)
  assert.deepEqual(world.switched, [])
})

test('tab-only fallback: exactly one terminal with the same tab id is used (fallback b)', T, async () => {
  const { world, full } = pair()
  const rig = newRig({ world })
  await boot(rig)
  // the leaf id changed; the tab did not. The terminal has no agent identity, so only the tab can match.
  world.terminals = terminalsOf(full[1]!, terminal('tab0123456789:leafNEW', { handle: 'h-tab', worktreeId: 'wa' }))
  assert.deepEqual(await focus(rig, P1), { ok: true })
  assert.deepEqual(world.switched, ['h-tab'])
  assert.match(diagLines(rig)[0]!, /same tab/)
})

test('tab-only fallback with two terminals in the tab: no guess', T, async () => {
  const { world, full } = pair()
  const rig = newRig({ world })
  await boot(rig)
  world.terminals = terminalsOf(
    full[1]!,
    terminal('tab0123456789:leafONE', { handle: 'h-t1', worktreeId: 'wa' }),
    terminal('tab0123456789:leafTWO', { handle: 'h-t2', worktreeId: 'wa' })
  )
  assert.equal((await focus(rig, P1)).ok, false)
  assert.deepEqual(world.switched, [])
})

test('an orphaned terminal is never used, not even by its pane key', T, async () => {
  const { world, full } = pair()
  const rig = newRig({ world })
  await boot(rig)
  world.terminals = terminalsOf(full[1]!, term(P1, 'h-dead', { orphaned: true, recordedPaneKey: 'something:else' }))
  assert.equal((await focus(rig, P1)).ok, false)
  assert.deepEqual(world.switched, [])
})

test('a stale cached handle whose terminal is gone from the fresh list is not used', T, async () => {
  const { world, full } = pair()
  const rig = newRig({ world })
  await boot(rig)
  assert.equal(((await rig.fake.handlers.get('roster.list')!({})) as RosterModel).rows.find((r) => r.paneKey === P1)!.handle, 'h-1')
  world.terminals = terminalsOf(full[1]!) // p1's terminal is gone
  assert.equal(await pressDriven(rig), undefined)
  assert.deepEqual(world.switched, ['h-2'], 'the press moved on to p2 and never sent h-1')
  assert.equal((await focus(rig, P1)).ok, false)
  assert.ok(!world.switched.includes('h-1'))
})

test('when Orca cannot list terminals at all, the cached handle is the last resort', T, async () => {
  const { world } = pair()
  const rig = newRig({ world })
  await boot(rig)
  world.failRead = true
  assert.equal(await pressDriven(rig), undefined)
  assert.deepEqual(world.switched, ['h-1'])
  assert.equal(world.calls.filter((c) => c[1] === 'list').length - 1, 1, 'one failed list, no retries against a CLI that is failing')
})

// ---- cycling -------------------------------------------------------------------------------------

test('cycling skips a row it cannot resolve and lands on the next one', T, async () => {
  const rig = newRig({ world: sampleWorld() })
  await boot(rig)
  assert.equal(await pressDriven(rig), undefined) // a1
  assert.equal(await pressDriven(rig), undefined) // c1 has no terminal anywhere: skipped, a2 is next
  assert.deepEqual(rig.world.switched, ['h-ta1:l', 'h-ta2:l'])
  assert.equal(((await rig.fake.handlers.get('roster.list')!({})) as RosterModel).cursor, 'ta2:l')
  assert.equal(diagLines(rig).length, 1, 'one line for the press that skipped')
})

test('a row skipped for want of a terminal does not hide the fallback that found the next one: one line names it', T, async () => {
  // p1 has two same-type look-alikes in its worktree (no guess, skipped). p2 sits in another worktree where exactly one unclaimed same-type terminal exists.
  const p2 = 'tab2222222222:leaf2222222222'
  const world = newWorld(
    psOf(
      worktree({ worktreeId: 'wa', displayName: 'alpha', isActive: true }, [claude(P1, 60_000)]),
      worktree({ worktreeId: 'wb', displayName: 'beta' }, [claude(p2, 120_000)])
    ),
    terminalsOf(term(P1, 'h-1'), term(p2, 'h-2', { worktreeId: 'wb' }))
  )
  const rig = newRig({ world })
  await boot(rig)
  world.terminals = terminalsOf(
    term('tabaaaa:leafaaaa', 'h-a'),
    term('tabbbbb:leafbbbb', 'h-b'),
    term('tabcccc:leafcccc', 'h-c', { worktreeId: 'wb' })
  )
  assert.equal(await pressDriven(rig), undefined)
  assert.deepEqual(world.switched, ['h-c'], "p1 was skipped without a guess; p2 got wb's only free claude terminal")
  const lines = diagLines(rig)
  assert.equal(lines.length, 1)
  assert.match(lines[0]!, /all 4 lookups failed/)
  assert.match(lines[0]!, /a later agent: used the only unclaimed terminal of the same agent type/)
  assert.ok(!/more agent/.test(lines[0]!), 'nothing stayed unresolved, so nothing is counted as unresolved')
})

test('when Orca cannot be asked at all, neither message claims that Orca lists no terminal', T, async () => {
  const rig = newRig({ world: sampleWorld() })
  await boot(rig)
  rig.world.failRead = true
  const res = await focus(rig, 'tc1:l')
  assert.equal(res.ok, false)
  assert.doesNotMatch(res.reason!, /lists no terminal/)
})

test('a whole lap of unresolvable rows ends with one plain message, no switch and no loop', T, async () => {
  const world = newWorld(
    psOf(worktree({ worktreeId: 'wa', isActive: true }, [claude(P1, 60_000), claude(P2, 120_000), claude('tab3333333333:leaf3333333333', 180_000)])),
    terminalsOf()
  )
  const rig = newRig({ world })
  await boot(rig)
  await flushQuickRepoll(rig)
  const base = world.listCalls
  const t0 = rig.clock.now()
  assert.equal(await pressDriven(rig), worker.NO_TERMINAL_MESSAGE)
  assert.equal(world.switched.length, 0)
  assert.equal(world.calls.filter((c) => c[1] === 'switch').length, 0)
  assert.equal(listsSince(world, base), 4, 'the first row is looked up four times; the rest of the lap reuses that list')
  assert.ok(rig.clock.now() - t0 < 3000, 'a fraction of the budget')
  assert.equal(diagLines(rig).length, 1)
  assert.match(diagLines(rig)[0]!, /all 4 lookups failed/)
  assert.match(worker.NO_TERMINAL_MESSAGE, /no switchable agent/)
})

test('a press that cannot resolve any row asks for a refresh through the normal debounced path, not a loop', T, async () => {
  const world = newWorld(psOf(worktree({ worktreeId: 'wa', isActive: true }, [claude(P1, 60_000)])), terminalsOf())
  const rig = newRig({ world })
  await boot(rig)
  await flushQuickRepoll(rig)
  await pressDriven(rig)
  const ps0 = world.calls.filter((c) => c[1] === 'ps').length
  rig.clock.tick(3000)
  await settle()
  assert.equal(world.calls.filter((c) => c[1] === 'ps').length - ps0, 1, 'one refresh follows, then it is quiet')
})

test('rows whose pane is gone for good (no live pty) are looked up once, without the backoff', T, async () => {
  const dead = agent({ paneKey: P1, agentType: 'claude', hasLivePty: false, activity: verdict({ status: 'done', sortAt: NOW - 60_000 }) })
  const world = newWorld(psOf(worktree({ worktreeId: 'wa', isActive: true }, [dead])), terminalsOf())
  const rig = newRig({ world })
  await boot(rig)
  await flushQuickRepoll(rig)
  const base = world.listCalls
  assert.equal(await pressDriven(rig), worker.NO_TERMINAL_MESSAGE)
  assert.equal(listsSince(world, base), 1)
})

// ---- budget and abort ----------------------------------------------------------------------------

test('a slow Orca cannot stretch a press past its budget', T, async () => {
  const { world, full } = pair()
  const rig = newRig({ world })
  await boot(rig)
  world.terminals = terminalsOf(full[1]!)
  world.listDelayMs = 8000
  const t0 = rig.clock.now()
  const res = await drive(rig, press(rig), 50, 1200)
  assert.ok(res === worker.TIMED_OUT_MESSAGE || res === worker.NO_TERMINAL_MESSAGE || res === worker.SWITCH_FAILED_MESSAGE, `message: ${res}`)
  const deadline = t0 + worker.PRESS_BUDGET_MS
  for (const call of world.timing.filter((c) => c.at >= t0)) {
    assert.ok(call.at + call.timeoutMs <= deadline, `a ${call.kind} call started at +${call.at - t0} with ${call.timeoutMs} ms would outlive the budget`)
  }
  assert.ok(world.timing.some((c) => c.kind === 'list' && c.timeoutMs < 12_000), 'the last list was cut short by the budget, not the CLI timeout')
})

test('a hung terminal list is not retried: once the CLI gives up the press falls back to the cached handle', T, async () => {
  const { world } = pair()
  const rig = newRig({ world })
  await boot(rig)
  world.hung.add('list')
  const t0 = rig.clock.now()
  assert.equal(await drive(rig, press(rig), 100, 1200), undefined)
  assert.deepEqual(world.switched, ['h-1'])
  assert.equal(world.calls.filter((c) => c[1] === 'list').length - 1, 1, 'a list that hangs is asked for once')
  const elapsed = rig.clock.now() - t0
  assert.ok(elapsed >= 12_000 && elapsed < worker.PRESS_BUDGET_MS, `took ${elapsed} ms`)
})

test('aborting during a retry wait stops the press: no more lists, no switch', T, async () => {
  const { world, full } = pair()
  const rig = newRig({ world })
  await boot(rig)
  world.terminals = terminalsOf(full[1]!)
  const ac = new AbortController()
  const pending = press(rig, 'agent-roster.next', ac.signal)
  await settle() // the first list is answered; the press is now waiting out its first backoff
  const lists = world.listCalls
  ac.abort()
  assert.equal(await pending, worker.TIMED_OUT_MESSAGE)
  rig.clock.tick(5000)
  await settle()
  assert.equal(world.listCalls, lists, 'nothing asks Orca after the abort')
  assert.equal(world.switched.length, 0)
})

test('aborting while the list call is hanging cancels it', T, async () => {
  const { world } = pair()
  const rig = newRig({ world })
  await boot(rig)
  world.hung.add('list')
  const ac = new AbortController()
  const pending = press(rig, 'agent-roster.next', ac.signal)
  await settle()
  ac.abort()
  assert.equal(await pending, worker.TIMED_OUT_MESSAGE)
  assert.equal(world.switched.length, 0)
})

test('a click aborted during the backoff answers at once', T, async () => {
  const { world, full } = pair()
  const rig = newRig({ world })
  await boot(rig)
  world.terminals = terminalsOf(full[1]!)
  const ac = new AbortController()
  const pending = Promise.resolve(rig.fake.handlers.get('roster.focus')!({ paneKey: P1 }, { signal: ac.signal })) as Promise<{ ok: boolean }>
  await settle()
  ac.abort()
  assert.equal((await pending).ok, false)
  assert.equal(world.switched.length, 0)
})

// ---- clicks that cannot be resolved -----------------------------------------------------------------

test('a click that cannot be resolved says so in plain words, suggests trying again, and refreshes once at once', T, async () => {
  const rig = newRig({ world: sampleWorld() })
  await boot(rig)
  await flushQuickRepoll(rig)
  const ps0 = rig.world.calls.filter((c) => c[1] === 'ps').length
  const res = await focus(rig, 'tc1:l')
  assert.equal(res.ok, false)
  assert.match(res.reason!, /no terminal/i)
  assert.match(res.reason!, /try again/i)
  assert.equal(rig.world.calls.filter((c) => c[1] === 'switch').length, 0)
  assert.equal(rig.world.calls.filter((c) => c[1] === 'ps').length - ps0, 1, 'one immediate refresh, so the row can pick up its handle')
})

test('a click on a row the model does not have is still refused as before', T, async () => {
  const rig = newRig({ world: sampleWorld() })
  await boot(rig)
  assert.deepEqual(await focus(rig, 'nope'), { ok: false, reason: 'That agent is no longer running.' })
})

// ---- the quick re-poll -------------------------------------------------------------------------------

test('a refresh that leaves an agent without a handle schedules one quick terminal-list-only re-poll', T, async () => {
  const rig = newRig({ world: sampleWorld() })
  await boot(rig)
  const world = rig.world
  const lists = world.listCalls
  const ps = world.calls.filter((c) => c[1] === 'ps').length
  rig.clock.tick(699)
  await settle()
  assert.equal(world.listCalls, lists, 'not before about 700 ms')
  rig.clock.tick(2)
  await settle()
  assert.equal(world.listCalls - lists, 1)
  assert.equal(world.calls.filter((c) => c[1] === 'ps').length, ps, 'it never runs worktree ps')
})

test('the quick re-poll gives the row its handle when the terminal has registered by then', T, async () => {
  const rig = newRig({ world: sampleWorld() })
  const roster = await boot(rig)
  assert.equal(roster.getModel().rows.find((r) => r.paneKey === 'tc1:l')!.handle, null) // reading the model asks for nothing
  rig.world.terminals = terminalsOf(...(rig.world.terminals.terminals as Record<string, unknown>[]), terminal('tc1:l', { handle: 'h-tc1:l', worktreeId: 'wc', agentIdentity: 'claude' }))
  rig.clock.tick(800)
  await settle()
  assert.equal(roster.getModel().rows.find((r) => r.paneKey === 'tc1:l')!.handle, 'h-tc1:l')
  assert.equal(rig.world.calls.filter((c) => c[1] === 'ps').length, 1, 'no worktree ps was needed')
  const lastPost = rig.fake.posts.filter((p) => p.event === 'roster.update').at(-1)!.payload as RosterModel
  assert.equal(lastPost.rows.find((r) => r.paneKey === 'tc1:l')!.handle, 'h-tc1:l', 'the panel was told')
})

test('the quick re-poll is single-flight, coalesced and runs once for a burst of refreshes', T, async () => {
  const rig = newRig({ world: sampleWorld() })
  await boot(rig)
  const world = rig.world
  const lists = world.listCalls
  world.listDelayMs = 2000 // keep the re-poll in flight while more refreshes arrive
  for (let i = 0; i < 4; i++) {
    rig.fake.emit('agent.status.changed', { paneKey: 'ta1:l' })
    rig.clock.tick(400)
    await settle()
  }
  rig.clock.tick(900)
  await settle()
  rig.clock.tick(10_000)
  await settle()
  const fullRefreshes = world.calls.filter((c) => c[1] === 'ps').length - 1
  assert.ok(fullRefreshes >= 1)
  // each full refresh asks for the terminal list once; the quick re-poll adds exactly one more list in total
  assert.equal(world.listCalls - lists - fullRefreshes, 1)
})

test('the quick re-poll does not run when every agent has a handle', T, async () => {
  const { world } = pair()
  const rig = newRig({ world })
  await boot(rig)
  const lists = world.listCalls
  rig.clock.tick(5000)
  await settle()
  assert.equal(world.listCalls, lists)
})

test('stop() clears the quick re-poll timer', T, async () => {
  const rig = newRig({ world: sampleWorld() })
  const r = await boot(rig)
  r.stop()
  started = null
  assert.equal(rig.clock.pending(), 0)
})

// ---- the log ------------------------------------------------------------------------------------------

test('the lookup log line names the pane by its first 8 characters and never carries a title or a prompt', T, async () => {
  const { world, full } = pair()
  const rig = newRig({ world })
  await boot(rig)
  appearsOnCall(world, 3, full, [full[1]!, term('tabqqqq:leafqqqq', 'h-q', { agentIdentity: 'we ird\nid' }), term('tabrrrr:leafrrrr', 'h-r', { agentIdentity: 'codex' })])
  // the line describes the first list that missed: 3 terminals in the worktree, p1's tab not among them
  await pressDriven(rig)
  const lines = diagLines(rig)
  assert.equal(lines.length, 1)
  const line = lines[0]!
  assert.ok(line.includes('tab01234:leaf9876'), line)
  assert.ok(!line.includes('tab0123456789'), 'the tab id is cut to 8 characters')
  assert.ok(!line.includes('leaf9876543210'), 'the leaf id is cut to 8 characters')
  assert.match(line, /tab listed: no/)
  assert.match(line, /terminals in worktree: 3/)
  assert.match(line, /agent identities: claude, codex, other/)
  assert.ok(!/we ird|\n/.test(line), 'identity values are cleaned')
  assert.match(line, /attempt 3/)
  assert.ok(rig.fake.logs.every((l) => !/SECRET|do-not-log/.test(l)), 'no title or prompt is ever logged')
  assert.ok(rig.fake.logs.every((l) => !/h-1|h-2|h-q|h-r/.test(l)), 'no terminal handle is logged')
})

test('one failed action logs one lookup line, however many rows it skipped', T, async () => {
  const world = newWorld(psOf(worktree({ worktreeId: 'wa', isActive: true }, [claude(P1, 60_000), claude(P2, 120_000)])), terminalsOf())
  const rig = newRig({ world })
  await boot(rig)
  await flushQuickRepoll(rig)
  await pressDriven(rig)
  assert.equal(diagLines(rig).length, 1)
  await pressDriven(rig)
  assert.equal(diagLines(rig).length, 2, 'the second failed press adds its own single line')
})
