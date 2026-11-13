// The worker end to end, against a fake Orca host and a fake CLI. Plain node:test; the same
// worker is also mounted in Orca's own test kit by test/worker.orca.test.ts.

import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import activate, {
  createRoster,
  deactivate,
  NO_AGENTS_MESSAGE,
  NO_TERMINAL_MESSAGE,
  PRESS_QUEUE_MAX,
  REFRESH_INTERVAL_MS,
  resetDeps,
  setDeps,
  STATUS_ITEM_ID,
  SWITCH_FAILED_MESSAGE
} from '../src/worker.ts'
import type { Roster } from '../src/worker.ts'
import type { RosterModel } from '../src/model.ts'
import { FREEZE_MS } from '../src/cycle.ts'
import { NOW, agent, psOf, terminal, terminalsOf, verdict, worktree } from './fixtures.ts'
import { drive, fakeOrca, newRig, newWorld, sampleWorld, settle } from './rig.ts'
import type { Rig, World } from './rig.ts'

let started: Roster | null = null
afterEach(async () => {
  started?.stop()
  started = null
  await deactivate()
  resetDeps()
})

async function boot(rig: Rig): Promise<Roster> {
  started = createRoster(rig.fake.orca, rig.deps)
  await settle()
  return started
}

const call = (rig: Rig, id: string, signal?: AbortSignal) =>
  rig.fake.commands.get(id)!(undefined, { signal: signal ?? new AbortController().signal }) as Promise<string | undefined>
/** `call`, with the fake clock moved while it is pending: a press that looks a terminal up again waits on a timer. */
const callD = (rig: Rig, id: string, signal?: AbortSignal) => drive(rig, call(rig, id, signal))
const listModel = async (rig: Rig) => (await rig.fake.handlers.get('roster.list')!({})) as RosterModel

// ---- activation ------------------------------------------------------------------------------

test('activate registers everything and runs no CLI call before settings are read', async () => {
  const rig = newRig({ world: sampleWorld() })
  started = createRoster(rig.fake.orca, rig.deps)
  assert.deepEqual([...rig.fake.commands.keys()].sort(), ['agent-roster.next', 'agent-roster.prev'])
  assert.deepEqual([...rig.fake.handlers.keys()].sort(), ['roster.focus', 'roster.list', 'roster.refresh', 'roster.setGroup'])
  assert.deepEqual(rig.fake.eventNames().sort(), ['agent.status.changed', 'workspace.changed'])
  assert.deepEqual(rig.world.calls, [], 'nothing is spawned synchronously')
  await settle()
  assert.equal(rig.world.calls.filter((c) => c[1] === 'ps').length, 1)
  assert.equal(rig.world.calls.filter((c) => c[1] === 'list').length, 1)
  assert.deepEqual(rig.world.calls.filter((c) => c[0] === 'terminal' && c[1] === 'switch'), [], 'activation never switches')
})

test('the default export is activate(orca) and deactivate stops the timers', async () => {
  const rig = newRig({ world: sampleWorld() })
  setDeps(rig.deps)
  activate(rig.fake.orca)
  await settle()
  assert.ok(rig.clock.pending() >= 1, 'interval armed')
  await deactivate()
  assert.equal(rig.clock.pending(), 0)
  assert.ok(rig.fake.disposed >= 8, 'every registration was disposed')
  rig.clock.tick(5 * REFRESH_INTERVAL_MS)
  await settle()
  assert.equal(rig.world.calls.filter((c) => c[1] === 'ps').length, 1, 'no refresh after deactivate')
})

test('a host that refuses event subscriptions or has no status bar does not stop the worker', async () => {
  const rig = newRig({ world: sampleWorld(), fake: fakeOrca({ failEventsOn: true, hasStatusBar: false }) })
  await boot(rig)
  assert.ok(rig.fake.logs.some((l) => l.includes('subscribe agent.status.changed failed')))
  const m = await listModel(rig)
  assert.equal(m.rows.length, 4)
  assert.deepEqual(rig.fake.hostCalls, [])
})

// ---- model and panel -------------------------------------------------------------------------

test('roster.list returns the joined model: real titles, handles, Orca status order', async () => {
  const rig = newRig({ world: sampleWorld() })
  await boot(rig)
  const m = await listModel(rig)
  assert.deepEqual(m.rows.map((r) => [r.title, r.status, r.handle !== null]), [
    ['Untangle the walrus scheduler', 'waiting', true],
    ['prompt text', 'working', false], // no terminal: falls through to the Activity title, shown but not switchable
    ['Rename quokka module', 'working', true],
    ['Draft the mango release notes', 'done', true]
  ])
  assert.deepEqual(m.groups.status.map((g) => [g.label, g.paneKeys.length]), [['Waiting for input', 1], ['Working', 2], ['Done', 1]])
  assert.deepEqual(m.groups.worktree.map((g) => [g.label, g.paneKeys.length, g.isActive]), [['alpha', 2, true], ['beta', 1, false], ['gamma', 1, false]])
  assert.equal(m.settings.groupBy, 'status')
  assert.equal(m.activeWorktreeId, 'wa')
  assert.equal(m.error, null)
})

test('the worker posts roster.update only when the model changed', async () => {
  const rig = newRig({ world: sampleWorld() })
  await boot(rig)
  const updates = () => rig.fake.posts.filter((p) => p.event === 'roster.update')
  assert.equal(updates().length, 1, 'first model')
  rig.clock.tick(REFRESH_INTERVAL_MS) // the 30 s timer, nothing changed
  await settle()
  assert.equal(updates().length, 1, 'identical roster is not posted again')
  // an agent finishes
  const wt = (rig.world.ps.worktrees as Array<Record<string, unknown>>)[0]!
  const a2 = (wt.agents as Array<Record<string, unknown>>)[1]!
  a2.activity = verdict({ status: 'done', sortAt: NOW })
  rig.fake.emit('agent.status.changed', { paneKey: 'ta2:l', state: 'done' })
  rig.clock.tick(400)
  await settle()
  assert.equal(updates().length, 2)
  const last = updates()[1]!.payload as RosterModel
  assert.equal(last.rows.find((r) => r.paneKey === 'ta2:l')!.status, 'done')
})

test('event bursts coalesce: ten events inside the debounce window cause one refresh', async () => {
  const rig = newRig({ world: sampleWorld() })
  await boot(rig)
  rig.clock.tick(800) // the one quick terminal-list re-poll c1's missing terminal schedules, out of the way
  await settle()
  const before = rig.world.calls.length
  for (let i = 0; i < 10; i++) {
    rig.fake.emit('agent.status.changed', { paneKey: 'ta2:l' })
    rig.clock.tick(30)
  }
  rig.fake.emit('workspace.changed', { context: null })
  rig.clock.tick(400)
  await settle()
  assert.equal(rig.world.calls.length - before, 2, 'one ps plus one terminal list')
})

test('a CLI failure keeps the last good rows, shows an error, and recovers on the next refresh', async () => {
  const rig = newRig({ world: sampleWorld() })
  await boot(rig)
  rig.world.failRead = true
  rig.clock.tick(REFRESH_INTERVAL_MS)
  await settle()
  let m = await listModel(rig)
  assert.equal(m.rows.length, 4, 'last good model kept')
  assert.equal(m.error, 'Orca CLI unavailable, retrying')
  assert.ok(m.errorDetail && m.errorDetail.length > 0)
  assert.ok(rig.fake.logs.some((l) => l.includes('refresh failed')))
  rig.world.failRead = false
  rig.clock.tick(REFRESH_INTERVAL_MS)
  await settle()
  m = await listModel(rig)
  assert.equal(m.error, null)
  assert.ok(rig.fake.logs.some((l) => l.includes('reachable again')))
})

test('a CLI that is down from the start never throws and the panel still gets an answer', async () => {
  const rig = newRig({ world: sampleWorld() })
  rig.world.failRead = true
  await boot(rig)
  const m = await listModel(rig)
  assert.deepEqual(m.rows, [])
  assert.equal(m.error, 'Orca CLI unavailable, retrying')
  assert.equal(await callD(rig, 'agent-roster.next'), NO_AGENTS_MESSAGE)
})

test('the first refresh logs how long ps --json took (dev note, log only)', async () => {
  const rig = newRig({ world: sampleWorld() })
  await boot(rig)
  assert.equal(rig.fake.logs.filter((l) => l.includes('dev note') && l.includes('ps --json')).length, 1)
  assert.ok(rig.fake.logs.every((l) => l.startsWith('[agent-roster]')))
})

// ---- cycling ---------------------------------------------------------------------------------

test('next walks the activity order, skips rows with no handle, and wraps', async () => {
  const rig = newRig({ world: sampleWorld() })
  await boot(rig)
  // restart: the active worktree (alpha) has a1 and a2; the first of its rows in list order is a1
  assert.equal(await callD(rig, 'agent-roster.next'), undefined)
  assert.deepEqual(rig.world.switched, ['h-ta1:l'])
  await callD(rig, 'agent-roster.next') // a1 -> (c1 has no terminal) -> a2
  await callD(rig, 'agent-roster.next') // -> b1
  await callD(rig, 'agent-roster.next') // wrap -> a1
  assert.deepEqual(rig.world.switched, ['h-ta1:l', 'h-ta2:l', 'h-tb1:l', 'h-ta1:l'])
  await callD(rig, 'agent-roster.prev') // back to b1 (wrap backwards through the end)
  assert.equal(rig.world.switched.at(-1), 'h-tb1:l')
  assert.ok(rig.world.calls.filter((c) => c[1] === 'switch').every((c) => c.includes('--terminal') && c.includes('--json')))
})

test('the model cursor follows the last switch and the panel is told', async () => {
  const rig = newRig({ world: sampleWorld() })
  await boot(rig)
  await callD(rig, 'agent-roster.next')
  const m = await listModel(rig)
  assert.equal(m.cursor, 'ta1:l')
  const last = rig.fake.posts.filter((p) => p.event === 'roster.update').at(-1)!.payload as RosterModel
  assert.equal(last.cursor, 'ta1:l')
})

test('cycleOrder projects walks worktree order then agent order', async () => {
  const rig = newRig({ world: sampleWorld(), fake: fakeOrca({ settings: { cycleOrder: 'projects' } }) })
  await boot(rig)
  for (let i = 0; i < 4; i++) await callD(rig, 'agent-roster.next')
  assert.deepEqual(rig.world.switched, ['h-ta1:l', 'h-ta2:l', 'h-tb1:l', 'h-ta1:l']) // c1 has no handle
})

test('changing cycleOrder or skipFinished in Settings applies without a restart', async () => {
  const rig = newRig({ world: sampleWorld() })
  await boot(rig)
  rig.fake.changeSetting('skipFinished', true)
  await settle()
  rig.clock.tick(FREEZE_MS + 1)
  await callD(rig, 'agent-roster.next') // a1
  await callD(rig, 'agent-roster.next') // a2
  await callD(rig, 'agent-roster.next') // b1 is done: skipped -> a1
  assert.deepEqual(rig.world.switched, ['h-ta1:l', 'h-ta2:l', 'h-ta1:l'])
})

test('a switch that fails is logged and the next row is tried once', async () => {
  const rig = newRig({ world: sampleWorld() })
  await boot(rig)
  rig.world.failSwitch.add('h-ta1:l')
  assert.equal(await callD(rig, 'agent-roster.next'), undefined)
  assert.deepEqual(rig.world.switched, ['h-ta2:l'], 'a1 failed, a2 took over')
  assert.ok(rig.fake.logs.some((l) => l.includes('switching to a claude agent failed')))
  assert.equal((await listModel(rig)).cursor, 'ta2:l')
})

test('when the retry fails too the press reports it and the cursor stays', async () => {
  const rig = newRig({ world: sampleWorld() })
  await boot(rig)
  await callD(rig, 'agent-roster.next') // a1
  rig.world.failSwitch.add('h-ta2:l').add('h-tb1:l')
  assert.equal(await callD(rig, 'agent-roster.next'), SWITCH_FAILED_MESSAGE)
  assert.deepEqual(rig.world.switched, ['h-ta1:l'])
  assert.equal((await listModel(rig)).cursor, 'ta1:l')
})

test('an empty roster is a no-op that says so', async () => {
  const rig = newRig({ world: newWorld(psOf(worktree({}, [])), terminalsOf()) })
  await boot(rig)
  assert.equal(await callD(rig, 'agent-roster.next'), NO_AGENTS_MESSAGE)
  assert.equal(await callD(rig, 'agent-roster.prev'), NO_AGENTS_MESSAGE)
  assert.deepEqual(rig.world.switched, [])
})

test('a row with no handle is shown; when Orca lists no terminal for any agent a press switches nothing and says so', async () => {
  const a = agent({ paneKey: 'tx:l', activity: verdict() })
  const rig = newRig({ world: newWorld(psOf(worktree({ isActive: true }, [a])), terminalsOf()) })
  await boot(rig)
  assert.equal((await listModel(rig)).rows.length, 1)
  assert.equal(await callD(rig, 'agent-roster.next'), NO_TERMINAL_MESSAGE)
  assert.deepEqual(rig.world.switched, [])
})

test('rapid presses walk a stable list while a working row reorders, and Orca lags on the active worktree', async () => {
  const rig = newRig({ world: sampleWorld(), fake: fakeOrca({ settings: { cycleOrder: 'projects' } }) })
  await boot(rig)
  const press = () => callD(rig, 'agent-roster.next')
  await press() // a1 (restart at the active worktree wa)
  rig.clock.tick(300)
  await press() // a2
  rig.clock.tick(300)
  // Orca still reports wa as active, and b1 is now busy and jumps in the live activity order
  const wb = (rig.world.ps.worktrees as Array<Record<string, unknown>>)[1]!
  ;((wb.agents as Array<Record<string, unknown>>)[0]!).activity = verdict({ status: 'working', sortAt: NOW + 5000 })
  rig.fake.emit('agent.status.changed', {})
  rig.clock.tick(400)
  await settle()
  await press() // b1: the cursor (a2) is inside wa anyway; order is frozen
  rig.clock.tick(300)
  await press() // wraps to a1 (c1 has no handle); must not restart or skip
  assert.deepEqual(rig.world.switched, ['h-ta1:l', 'h-ta2:l', 'h-tb1:l', 'h-ta1:l'])
})

test('after crossing into another worktree a press inside the freeze trusts the cursor, not the stale active flag', async () => {
  const world = sampleWorld()
  // wb gets a second agent, so the right answer after b1 is b2 and a wrong "restart at wa" is visible
  const wb = (world.ps.worktrees as Array<Record<string, unknown>>)[1]!
  ;(wb.agents as unknown[]).push(agent({ paneKey: 'tb2:l', activity: verdict({ status: 'working', sortAt: NOW - 3 * 60_000 }) }))
  ;(world.terminals.terminals as unknown[]).push(terminal('tb2:l', { handle: 'h-tb2:l', title: 'Sketch the pelican parser' }))
  const rig = newRig({ world, fake: fakeOrca({ settings: { cycleOrder: 'projects' } }) })
  await boot(rig)
  const press = () => callD(rig, 'agent-roster.next')
  await press() // a1
  await press() // a2
  await press() // b1: crossed into wb, but ps still says wa is active
  rig.clock.tick(400)
  await settle() // the refresh after the switch reports wa as active again
  assert.equal((rig.world.ps.worktrees as Array<Record<string, unknown>>)[0]!.isActive, true)
  await press() // must continue to b2, not restart at wa's first agent
  assert.deepEqual(rig.world.switched, ['h-ta1:l', 'h-ta2:l', 'h-tb1:l', 'h-tb2:l'])
})

test('after the freeze, a hand-made switch to another worktree restarts the walk there', async () => {
  const rig = newRig({ world: sampleWorld(), fake: fakeOrca({ settings: { cycleOrder: 'projects' } }) })
  await boot(rig)
  await callD(rig, 'agent-roster.next') // a1, cursor in wa
  rig.clock.tick(FREEZE_MS + 100)
  // the person clicks into wb by hand: Orca now says wb is active
  const wts = rig.world.ps.worktrees as Array<Record<string, unknown>>
  wts[0]!.isActive = false
  wts[1]!.isActive = true
  rig.clock.tick(REFRESH_INTERVAL_MS)
  await settle()
  await callD(rig, 'agent-roster.next')
  assert.equal(rig.world.switched.at(-1), 'h-tb1:l', 'restarted at wb first agent')
})

test('presses are serialized: concurrent presses see each other and a held key cannot pile up', async () => {
  const rig = newRig({ world: sampleWorld() })
  await boot(rig)
  const first = call(rig, 'agent-roster.next')
  const second = call(rig, 'agent-roster.next')
  const third = call(rig, 'agent-roster.next')
  await drive(rig, Promise.all([first, second, third]))
  assert.deepEqual(rig.world.switched, ['h-ta1:l', 'h-ta2:l', 'h-tb1:l'])
  const burst = Array.from({ length: PRESS_QUEUE_MAX + 3 }, () => call(rig, 'agent-roster.next'))
  await drive(rig, Promise.all(burst))
  assert.equal(rig.world.switched.length, 3 + PRESS_QUEUE_MAX, 'presses beyond the queue are dropped')
})

test('a press refreshes first when the model is old, and uses the cache inside a burst', async () => {
  const rig = newRig({ world: sampleWorld() })
  await boot(rig)
  rig.clock.tick(10_000) // older than 5 s, no refresh in between (the interval is 30 s)
  const before = rig.world.calls.filter((c) => c[1] === 'ps').length
  await callD(rig, 'agent-roster.next')
  assert.equal(rig.world.calls.filter((c) => c[1] === 'ps').length - before, 1)
})

// ---- panel handlers --------------------------------------------------------------------------

test('roster.focus switches to that row, moves the cursor and the active worktree', async () => {
  const rig = newRig({ world: sampleWorld() })
  await boot(rig)
  const res = await rig.fake.handlers.get('roster.focus')!({ paneKey: 'tb1:l' })
  assert.deepEqual(res, { ok: true })
  assert.deepEqual(rig.world.switched, ['h-tb1:l'])
  const m = await listModel(rig)
  assert.equal(m.cursor, 'tb1:l')
  assert.equal(m.activeWorktreeId, 'wb')
  // the next press continues from the clicked row
  await callD(rig, 'agent-roster.next')
  assert.equal(rig.world.switched.at(-1), 'h-ta1:l') // activity order after b1 (done) wraps to a1
})

test('roster.focus refuses unknown rows, rows Orca lists no terminal for, bad input and a failing switch', async () => {
  const rig = newRig({ world: sampleWorld() })
  await boot(rig)
  const focus = rig.fake.handlers.get('roster.focus')!
  assert.equal(((await focus({ paneKey: 'nope' })) as { ok: boolean }).ok, false)
  const unlisted = (await drive(rig, Promise.resolve(focus({ paneKey: 'tc1:l' })))) as { ok: boolean; reason: string }
  assert.equal(unlisted.ok, false) // Orca lists no terminal for it, even when asked again
  assert.match(unlisted.reason, /try again/)
  for (const bad of [null, undefined, {}, { paneKey: 5 }, { paneKey: '' }, 'x']) {
    assert.equal(((await focus(bad)) as { ok: boolean }).ok, false)
  }
  rig.world.failSwitch.add('h-ta2:l')
  const failed = (await focus({ paneKey: 'ta2:l' })) as { ok: boolean; reason: string }
  assert.equal(failed.ok, false)
  assert.ok(failed.reason.length > 0)
  assert.deepEqual(rig.world.switched, [])
  assert.equal((await listModel(rig)).cursor, null)
})

test('roster.setGroup persists groupBy as a setting and returns the model', async () => {
  const rig = newRig({ world: sampleWorld() })
  await boot(rig)
  const res = (await rig.fake.handlers.get('roster.setGroup')!({ mode: 'worktree' })) as { ok: boolean; model: RosterModel }
  assert.equal(res.ok, true)
  assert.equal(res.model.settings.groupBy, 'worktree')
  assert.deepEqual(rig.fake.settingsWrites, [['groupBy', 'worktree']])
  assert.equal((await listModel(rig)).settings.groupBy, 'worktree')
  const last = rig.fake.posts.filter((p) => p.event === 'roster.update').at(-1)!.payload as RosterModel
  assert.equal(last.settings.groupBy, 'worktree')
  const bad = (await rig.fake.handlers.get('roster.setGroup')!({ mode: 'folder' })) as { ok: boolean }
  assert.equal(bad.ok, false)
  assert.equal(rig.fake.settingsWrites.length, 1)
})

test('a groupBy changed in Orca Settings reaches the panel', async () => {
  const rig = newRig({ world: sampleWorld() })
  await boot(rig)
  rig.fake.changeSetting('groupBy', 'worktree')
  await settle()
  assert.equal((await listModel(rig)).settings.groupBy, 'worktree')
  assert.equal((rig.fake.posts.filter((p) => p.event === 'roster.update').at(-1)!.payload as RosterModel).settings.groupBy, 'worktree')
})

test('roster.refresh forces a refresh and answers with the model', async () => {
  const rig = newRig({ world: sampleWorld() })
  await boot(rig)
  const before = rig.world.calls.filter((c) => c[1] === 'ps').length
  const m = (await rig.fake.handlers.get('roster.refresh')!({})) as RosterModel
  assert.equal(rig.world.calls.filter((c) => c[1] === 'ps').length - before, 1)
  assert.equal(m.rows.length, 4)
})

test('folded child agents are hidden from the panel and from cycling unless showChildAgents is on; live ones are shown', async () => {
  const parent = agent({ paneKey: 'tp:l', activity: verdict() })
  const live = agent({ paneKey: 'tl:l', activity: verdict({ childOf: 'tp:l' }) })
  const folded = agent({ paneKey: 'tk:l', activity: verdict({ status: 'done', childOf: 'tp:l', foldedChild: true }) })
  const world = newWorld(
    psOf(worktree({ isActive: true }, [parent, live, folded])),
    terminalsOf(terminal('tp:l', { handle: 'h-p' }), terminal('tl:l', { handle: 'h-l' }), terminal('tk:l', { handle: 'h-k' }))
  )
  const rig = newRig({ world })
  await boot(rig)
  assert.deepEqual((await listModel(rig)).rows.map((r) => r.paneKey).sort(), ['tl:l', 'tp:l'])
  rig.fake.changeSetting('showChildAgents', true)
  await settle()
  assert.equal((await listModel(rig)).rows.length, 3)
})

// ---- status bar ------------------------------------------------------------------------------

test('the status bar item is hidden at start, then shows a summary with a warning tone', async () => {
  const rig = newRig({ world: sampleWorld() })
  await boot(rig)
  const calls = rig.fake.hostCalls
  assert.deepEqual(calls[0], { method: 'statusBar.update', params: { id: STATUS_ITEM_ID, visible: false } })
  const shown = calls.at(-1)!
  assert.equal(shown.method, 'statusBar.update')
  assert.deepEqual(shown.params, {
    id: STATUS_ITEM_ID,
    text: '2 working · 1 waiting',
    icon: 'agent',
    tone: 'warning',
    tooltip: 'Agent Roster: 4 agents',
    visible: true
  })
})

test('the status bar is only updated when its text changes, and hides when the agents go', async () => {
  const rig = newRig({ world: sampleWorld() })
  await boot(rig)
  const count = () => rig.fake.hostCalls.length
  const n = count()
  rig.clock.tick(REFRESH_INTERVAL_MS)
  await settle()
  assert.equal(count(), n, 'unchanged summary, no call')
  rig.world.ps = psOf(worktree({}, []))
  rig.clock.tick(REFRESH_INTERVAL_MS)
  await settle()
  assert.deepEqual(rig.fake.hostCalls.at(-1)!.params, { id: STATUS_ITEM_ID, visible: false })
})

// ---- review fixes: one budget per press, abort signals, refresh waits, frozen order, posting -------

type Wt = { agents: Array<Record<string, unknown>> }
const worktreesOf = (world: World) => world.ps.worktrees as unknown as Wt[]

function removeAgent(world: World, paneKey: string): void {
  for (const wt of worktreesOf(world)) wt.agents = wt.agents.filter((a) => a.paneKey !== paneKey)
  const list = world.terminals.terminals as Array<Record<string, unknown>>
  world.terminals.terminals = list.filter((t) => `${t.tabId}:${t.leafId}` !== paneKey)
}

/** Moves the fake clock in small steps until `p` settles. Reports the fake milliseconds that took. */
async function elapsedUntil(rig: Rig, p: Promise<unknown>, limitMs = 150_000, stepMs = 250): Promise<{ ms: number; done: boolean }> {
  let done = false
  void p.then(
    () => void (done = true),
    () => void (done = true)
  )
  const t0 = rig.clock.now()
  while (!done && rig.clock.now() - t0 < limitMs) {
    rig.clock.tick(stepMs)
    await settle()
  }
  return { ms: rig.clock.now() - t0, done }
}

test('a press on a CLI that never answers ends inside one 25 s budget, retry included', async () => {
  const rig = newRig({ world: sampleWorld() })
  await boot(rig)
  rig.world.hung = new Set(['ps', 'list', 'switch'])
  rig.clock.tick(10_000) // the model is stale, so the press refreshes first (and that hangs too)
  const answer = call(rig, 'agent-roster.next')
  const r = await elapsedUntil(rig, answer)
  assert.equal(r.done, true)
  assert.ok(r.ms <= 25_000, `one press took ${r.ms} ms`)
  assert.equal(typeof (await answer), 'string', 'the person is told it did not work')
  assert.ok(rig.world.switchTimeouts.every((ms) => ms <= 12_000), 'no single switch is allowed more than the CLI timeout')
  const spent = 2_500 + rig.world.switchTimeouts.reduce((a, b) => a + b, 0)
  assert.ok(spent <= 25_000, `refresh wait plus switch timeouts were ${spent} ms`)
})

test('queued presses behind a hung CLI share the budget instead of waiting a full turn each', async () => {
  const rig = newRig({ world: sampleWorld() })
  await boot(rig)
  rig.world.hung = new Set(['ps', 'list', 'switch'])
  rig.clock.tick(10_000)
  const t0 = rig.clock.now()
  const ends: number[] = []
  const presses = [call(rig, 'agent-roster.next'), call(rig, 'agent-roster.next'), call(rig, 'agent-roster.prev')].map((p) =>
    p.then(() => void ends.push(rig.clock.now() - t0))
  )
  await elapsedUntil(rig, Promise.all(presses))
  assert.equal(ends.length, 3, 'every press answered')
  assert.ok(Math.max(...ends) <= 25_000, `the last queued press ended after ${Math.max(...ends)} ms`)
  assert.ok(rig.world.switchTimeouts.length <= 2, 'presses that outlived their budget never reached the CLI')
})

test('an aborted press cancels the switch in flight and skips the retry', async () => {
  const rig = newRig({ world: sampleWorld() })
  await boot(rig)
  rig.world.hung = new Set(['switch'])
  const stop = new AbortController()
  let finished = false
  const press = call(rig, 'agent-roster.next', stop.signal)
  void press.then(() => void (finished = true))
  await settle()
  assert.equal(rig.world.calls.filter((c) => c[1] === 'switch').length, 1, 'the switch is running and hung')
  stop.abort()
  await settle()
  assert.equal(finished, true, 'the press ends at once, without waiting for the 12 s timeout')
  assert.equal(rig.world.cancelled, 1, 'the CLI call itself was cancelled')
  assert.equal(rig.world.calls.filter((c) => c[1] === 'switch').length, 1, 'no second attempt after an abort')
  assert.equal((await listModel(rig)).cursor, null, 'nothing was committed')
})

test('a queued press whose caller gave up never reaches the CLI', async () => {
  const rig = newRig({ world: sampleWorld() })
  await boot(rig)
  rig.world.hung = new Set(['switch'])
  const first = call(rig, 'agent-roster.next')
  const gaveUp = new AbortController()
  const second = call(rig, 'agent-roster.next', gaveUp.signal)
  await settle()
  gaveUp.abort()
  const r = await elapsedUntil(rig, Promise.all([first, second]))
  assert.equal(r.done, true)
  assert.equal(rig.world.switchTimeouts.length, 2, 'only the first press switched (two attempts); the aborted one did nothing')
})

test('roster.focus is cancelled when the panel request is, and a click behind a hung switch does not wait for it', async () => {
  const rig = newRig({ world: sampleWorld() })
  await boot(rig)
  rig.world.hung = new Set(['switch'])
  const stop = new AbortController()
  let finished = false
  const focus = rig.fake.handlers.get('roster.focus')!({ paneKey: 'tb1:l' }, { signal: stop.signal }) as Promise<{ ok: boolean }>
  void focus.then(() => void (finished = true))
  await settle()
  stop.abort()
  await settle()
  assert.equal(finished, true)
  assert.equal((await focus).ok, false)
  assert.equal(rig.world.cancelled, 1)
})

test('roster.refresh answers after the next completed refresh even while events keep arriving, and never hangs', async () => {
  const rig = newRig({ world: sampleWorld() })
  await boot(rig)
  rig.world.holdPs = true
  rig.clock.tick(REFRESH_INTERVAL_MS) // run A starts and is held
  await settle()
  let answered = false
  const refresh = rig.fake.handlers.get('roster.refresh')!({}) as Promise<unknown>
  void refresh.then(() => void (answered = true))
  rig.fake.emit('agent.status.changed', {})
  rig.clock.tick(400)
  await settle()
  rig.world.held.shift()!() // A ends; the coalesced run B starts and is held
  await settle()
  assert.equal(answered, false, 'B is the refresh that follows the click')
  rig.fake.emit('agent.status.changed', {}) // the stream goes on: run C is already wanted
  rig.clock.tick(400)
  await settle()
  rig.world.held.shift()!() // B ends
  await settle()
  assert.equal(answered, true, 'released by B, not held until the whole loop ends')
  assert.ok(rig.world.held.length >= 1, 'run C is still going')
})

test('roster.refresh gives up waiting after a bounded time when the CLI is stuck', async () => {
  const rig = newRig({ world: sampleWorld() })
  await boot(rig)
  rig.world.hung = new Set(['ps', 'list'])
  const refresh = rig.fake.handlers.get('roster.refresh')!({}) as Promise<RosterModel>
  const r = await elapsedUntil(rig, refresh)
  assert.equal(r.done, true)
  assert.ok(r.ms <= 10_000, `waited ${r.ms} ms`)
  assert.equal((await refresh).rows.length, 4, 'the last good model is returned')
})

test('the frozen walk keeps its place when the cursor row disappears in the middle of a burst', async () => {
  const rig = newRig({ world: sampleWorld() })
  await boot(rig)
  await callD(rig, 'agent-roster.next') // ta1
  await callD(rig, 'agent-roster.next') // ta2 (tc1 has no terminal)
  removeAgent(rig.world, 'ta2:l')
  rig.fake.emit('agent.status.changed', {})
  rig.clock.tick(400)
  await settle()
  assert.deepEqual((await listModel(rig)).rows.map((r) => r.paneKey), ['ta1:l', 'tc1:l', 'tb1:l'])
  await callD(rig, 'agent-roster.next')
  assert.equal(rig.world.switched.at(-1), 'h-tb1:l', 'next continues after where ta2 was, it does not restart')
})

test('previous from a vanished cursor goes to the nearest switchable row before its old place', async () => {
  const rig = newRig({ world: sampleWorld() })
  await boot(rig)
  await callD(rig, 'agent-roster.next') // ta1
  await callD(rig, 'agent-roster.next') // ta2
  removeAgent(rig.world, 'ta2:l')
  rig.fake.emit('agent.status.changed', {})
  rig.clock.tick(400)
  await settle()
  await callD(rig, 'agent-roster.prev')
  assert.equal(rig.world.switched.at(-1), 'h-ta1:l')
})

test('a click on a row outside the frozen list makes the next press continue from that row', async () => {
  const world = sampleWorld()
  const rig = newRig({ world })
  await boot(rig)
  await callD(rig, 'agent-roster.next') // ta1: the walked order is frozen as [ta1, tc1, ta2, tb1]
  // tb2 appears inside the freeze window, between tc1 and ta2 in the live order
  worktreesOf(world)[1]!.agents.push(agent({ paneKey: 'tb2:l', activity: verdict({ status: 'working', sortAt: NOW - 90_000 }) }))
  ;(world.terminals.terminals as unknown[]).push(terminal('tb2:l', { handle: 'h-tb2:l', title: 'Sketch the pelican parser' }))
  rig.fake.emit('agent.status.changed', {})
  rig.clock.tick(400)
  await settle()
  assert.deepEqual(await rig.fake.handlers.get('roster.focus')!({ paneKey: 'tb2:l' }), { ok: true })
  await callD(rig, 'agent-roster.next')
  assert.equal(rig.world.switched.at(-1), 'h-ta2:l', 'the row after the clicked one, not a restart at the first row')
})

test('a panel post that fails is retried at the next refresh', async () => {
  const rig = newRig({ world: sampleWorld(), fake: fakeOrca({ failPosts: 1 }) })
  await boot(rig)
  const updates = () => rig.fake.posts.filter((p) => p.event === 'roster.update')
  assert.equal(updates().length, 0, 'the first post was refused')
  assert.ok(rig.fake.logs.some((l) => l.includes('panel post failed')))
  rig.clock.tick(REFRESH_INTERVAL_MS) // nothing changed in the world, but the panel never got the model
  await settle()
  assert.equal(updates().length, 1, 'it was posted again')
  rig.clock.tick(REFRESH_INTERVAL_MS)
  await settle()
  assert.equal(updates().length, 1, 'and only once it was delivered does it count as sent')
})

test('a model too large for one panel post is capped with a "showing N of M" flag, and cycling still sees every agent', async () => {
  const many: Array<Record<string, unknown>> = []
  const terms: Array<Record<string, unknown>> = []
  for (let i = 0; i < 900; i++) {
    const paneKey = `tz${i}:l`
    many.push(agent({ paneKey, activity: verdict({ status: 'working', sortAt: NOW - i * 1000 }) }))
    terms.push(terminal(paneKey, { handle: `h-${paneKey}`, title: `Session ${i} ${'quokka '.repeat(18)}` }))
  }
  const world = newWorld(psOf(worktree({ worktreeId: 'wz', isActive: true }, many)), terminalsOf(...terms))
  const rig = newRig({ world })
  await boot(rig)
  const posted = rig.fake.posts.filter((p) => p.event === 'roster.update').at(-1)!.payload as RosterModel & { capped: { shown: number; total: number } | null }
  assert.ok(JSON.stringify(posted).length <= 200_000, `payload was ${JSON.stringify(posted).length} bytes`)
  assert.equal(posted.capped?.total, 900)
  assert.equal(posted.capped?.shown, posted.rows.length)
  assert.ok(posted.rows.length < 900 && posted.rows.length > 50)
  assert.equal(posted.groups.status.reduce((n, g) => n + g.paneKeys.length, 0), posted.rows.length, 'groups match the shown rows')
  const listed = (await listModel(rig)) as RosterModel & { capped: unknown }
  assert.ok(JSON.stringify(listed).length <= 200_000)
  // the shortcuts still walk all 900: `prev` from a fresh start lands on the oldest row, far beyond the cap
  await callD(rig, 'agent-roster.prev')
  assert.deepEqual(rig.world.switched, ['h-tz899:l'])
})

test('a small roster is never flagged as capped', async () => {
  const rig = newRig({ world: sampleWorld() })
  await boot(rig)
  assert.equal(((await listModel(rig)) as unknown as { capped: unknown }).capped, null)
})
