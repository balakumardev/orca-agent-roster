// Mounts the real worker in Orca's own test kit (`orca plugin test .`): the host there refuses what
// Orca refuses, so this catches a call the manifest's capabilities, events or commands do not cover.
// It needs the `orca/testing` module, which only `orca plugin test` provides, so `npm test` skips it.

import { afterEach, assert, mockHost, mountWorker, test } from 'orca/testing'
import type { TestWorker } from 'orca/testing'
import * as main from '../src/worker.ts'
import { drive, newWorld, fakeCli, sampleWorld } from './rig.ts'
import { fakeClock } from './clock.ts'
import { NOW } from './fixtures.ts'

let worker: TestWorker | undefined
afterEach(async () => {
  await worker?.deactivate()
  worker = undefined
  main.resetDeps()
})

const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise<void>((r) => setImmediate(r))
}

function install() {
  const clock = fakeClock(NOW)
  const world = sampleWorld()
  main.setDeps({ cli: fakeCli(world), now: clock.now, ...clock.timers })
  return { clock, world }
}

test('mounts with the manifest as declared and the host refuses nothing the worker does', async () => {
  const { world } = install()
  const host = mockHost({ results: { 'statusBar.update': { ok: true } } })
  worker = await mountWorker(main, { host })
  await settle()
  assert.deepEqual(worker.refusals, [], 'no call was refused')
  assert.ok(worker.logs.some((l) => l.includes('dev note')), 'the first refresh logged its timing')
  assert.ok(host.callsOf('statusBar.update').length >= 1)
  assert.equal(world.switched.length, 0)
})

test('the panel requests are answered through the real request path', async () => {
  install()
  const host = mockHost({ results: { 'statusBar.update': { ok: true } } })
  worker = await mountWorker(main, { host })
  await settle()
  const model = (await worker.request('roster.list', {})) as { rows: unknown[]; groups: { status: unknown[] } }
  assert.equal(model.rows.length, 4)
  assert.ok(model.groups.status.length > 0)
  const set = (await worker.request('roster.setGroup', { mode: 'worktree' })) as { ok: boolean }
  assert.equal(set.ok, true)
  assert.equal((host.data().settings as Record<string, unknown>).groupBy, 'worktree')
  assert.ok(worker.posts.some((p) => p.event === 'roster.update'))
  assert.deepEqual(worker.refusals, [])
})

test('the shortcuts run as the manifest names them', async () => {
  const { clock, world } = install()
  const host = mockHost({ results: { 'statusBar.update': { ok: true } } })
  worker = await mountWorker(main, { host })
  await settle()
  // c1 has no terminal, so the second press looks again (a wait on the fake clock) before it skips c1
  assert.equal(await drive({ clock }, worker.command('agent-roster.next')), undefined)
  assert.equal(await drive({ clock }, worker.command('agent-roster.next')), undefined)
  assert.equal(await drive({ clock }, worker.command('agent-roster.prev')), undefined)
  assert.deepEqual(world.switched, ['h-ta1:l', 'h-ta2:l', 'h-ta1:l'])
  assert.deepEqual(worker.refusals, [])
})

test('agent and workspace events reach the worker', async () => {
  const { clock, world } = install()
  const host = mockHost({ results: { 'statusBar.update': { ok: true } } })
  worker = await mountWorker(main, { host })
  await settle()
  const before = world.calls.length
  await worker.emit('agent.status.changed', { workspaceId: 'wa', paneKey: 'ta1:l', state: 'working', receivedAt: NOW })
  await worker.emit('workspace.changed', { context: null })
  clock.tick(400)
  await settle()
  assert.equal(world.calls.length - before, 2, 'one coalesced refresh: ps and terminal list')
  assert.deepEqual(worker.refusals, [])
})

test('a worker with no agents hides its status bar item and still answers', async () => {
  const clock = fakeClock(NOW)
  const world = newWorld()
  main.setDeps({ cli: fakeCli(world), now: clock.now, ...clock.timers })
  const host = mockHost({ results: { 'statusBar.update': { ok: true } } })
  worker = await mountWorker(main, { host })
  await settle()
  assert.equal(await worker.command('agent-roster.next'), main.NO_AGENTS_MESSAGE)
  assert.deepEqual(worker.refusals, [])
})
