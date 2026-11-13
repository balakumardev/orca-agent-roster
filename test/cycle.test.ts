import { test } from 'node:test'
import assert from 'node:assert/strict'
import { commitCycle, cycleOrder, emptyCycleState, FREEZE_MS, nextTarget, orderWithFreeze, planCycle } from '../src/cycle.ts'
import * as cycleModule from '../src/cycle.ts'
import { STATUS_LABEL } from '../src/model.ts'
import type { Row, StatusId } from '../src/model.ts'

function row(key: string, over: Partial<Row> = {}): Row {
  const status: StatusId = over.status ?? 'working'
  return {
    paneKey: key,
    handle: `h-${key}`,
    worktreeId: 'w1',
    worktreeName: 'one',
    repo: 'repo',
    branch: 'main',
    agentType: 'claude',
    title: key,
    titleSource: 'terminal',
    status,
    statusLabel: STATUS_LABEL[status],
    unread: false,
    sortAt: 1000,
    isCurrentWorktree: false,
    hasLivePty: true,
    isChild: false,
    isFolded: false,
    worktreeActivityAt: 10,
    indexInWorktree: 0,
    ...over
  }
}

const keys = (rows: readonly Row[]) => rows.map((r) => r.paneKey)
const OFF = { skipFinished: false }
const ON = { skipFinished: true }

// ---- nextTarget ----------------------------------------------------------------------------

test('nextTarget: steps forward and backward from the cursor and wraps at both ends', () => {
  const rows = [row('a'), row('b'), row('c')]
  assert.equal(nextTarget(rows, 'a', null, 'next', OFF)?.paneKey, 'b')
  assert.equal(nextTarget(rows, 'b', null, 'next', OFF)?.paneKey, 'c')
  assert.equal(nextTarget(rows, 'c', null, 'next', OFF)?.paneKey, 'a') // wrap forward
  assert.equal(nextTarget(rows, 'c', null, 'prev', OFF)?.paneKey, 'b')
  assert.equal(nextTarget(rows, 'a', null, 'prev', OFF)?.paneKey, 'c') // wrap backward
})

test('nextTarget: empty list gives null', () => {
  assert.equal(nextTarget([], null, null, 'next', OFF), null)
  assert.equal(nextTarget([], 'a', 'w1', 'prev', OFF), null)
})

test('nextTarget: a single row is returned every time', () => {
  const rows = [row('only')]
  assert.equal(nextTarget(rows, null, null, 'next', OFF)?.paneKey, 'only')
  assert.equal(nextTarget(rows, 'only', null, 'next', OFF)?.paneKey, 'only')
  assert.equal(nextTarget(rows, 'only', null, 'prev', OFF)?.paneKey, 'only')
})

test('nextTarget: a row with no cached handle is a candidate like any other; an excluded row is passed over', () => {
  const rows = [row('a'), row('b', { handle: null }), row('c')]
  assert.equal(nextTarget(rows, 'a', null, 'next', OFF)?.paneKey, 'b', 'the worker looks the terminal up when it gets there')
  assert.equal(nextTarget(rows, 'c', null, 'prev', OFF)?.paneKey, 'b')
  // a row whose terminal could not be found is excluded and the walk goes on
  const skipB = { ...OFF, exclude: new Set(['b']) }
  assert.equal(nextTarget(rows, 'a', null, 'next', skipB)?.paneKey, 'c')
  assert.equal(nextTarget(rows, 'c', null, 'prev', skipB)?.paneKey, 'a')
  assert.equal(nextTarget([row('x', { handle: null }), row('y', { handle: null })], null, null, 'next', { ...OFF, exclude: new Set(['x', 'y']) }), null)
  // the cursor itself may be handle-less (its terminal vanished): stepping still starts from its place
  assert.equal(nextTarget(rows, 'b', null, 'next', OFF)?.paneKey, 'c')
})

test('nextTarget: skipFinished passes over done, idle, interrupted and failed only', () => {
  const rows = [
    row('w', { status: 'working' }),
    row('d', { status: 'done' }),
    row('i', { status: 'idle' }),
    row('x', { status: 'interrupted' }),
    row('f', { status: 'failed' }),
    row('q', { status: 'waiting' }),
    row('u', { status: 'unverifiable' }),
    row('c', { status: 'unconfirmed' })
  ]
  const walk: string[] = []
  let cursor: string | null = 'w'
  for (let i = 0; i < 4; i++) {
    const t: Row = nextTarget(rows, cursor, null, 'next', ON)!
    walk.push(t.paneKey)
    cursor = t.paneKey
  }
  assert.deepEqual(walk, ['q', 'u', 'c', 'w'])
  // off: every row is visited
  assert.equal(nextTarget(rows, 'w', null, 'next', OFF)?.paneKey, 'd')
})

test('nextTarget: skipFinished with only finished rows gives null; a finished cursor still steps from its place', () => {
  assert.equal(nextTarget([row('a', { status: 'done' }), row('b', { status: 'failed' })], null, null, 'next', ON), null)
  const rows = [row('a'), row('b', { status: 'done' }), row('c')]
  assert.equal(nextTarget(rows, 'b', null, 'next', ON)?.paneKey, 'c')
  assert.equal(nextTarget(rows, 'b', null, 'prev', ON)?.paneKey, 'a')
})

test('nextTarget: excluded rows are passed over', () => {
  const rows = [row('a'), row('b'), row('c')]
  assert.equal(nextTarget(rows, 'a', null, 'next', { skipFinished: false, exclude: new Set(['b']) })?.paneKey, 'c')
})

test('nextTarget: restarts from the active worktree when the cursor is elsewhere', () => {
  const rows = [
    row('a1', { worktreeId: 'wa' }),
    row('a2', { worktreeId: 'wa' }),
    row('b1', { worktreeId: 'wb' }),
    row('b2', { worktreeId: 'wb' })
  ]
  // cursor on a2, but the person is now in wb: next goes to wb's first agent, prev to its last
  assert.equal(nextTarget(rows, 'a2', 'wb', 'next', OFF)?.paneKey, 'b1')
  assert.equal(nextTarget(rows, 'a2', 'wb', 'prev', OFF)?.paneKey, 'b2')
  // no cursor at all behaves the same
  assert.equal(nextTarget(rows, null, 'wb', 'next', OFF)?.paneKey, 'b1')
  // the cursor is inside the active worktree: simply continue
  assert.equal(nextTarget(rows, 'b1', 'wb', 'next', OFF)?.paneKey, 'b2')
  assert.equal(nextTarget(rows, 'b2', 'wb', 'next', OFF)?.paneKey, 'a1') // and leave it by wrapping on
})

test('nextTarget: the active worktree has no agent (or only excluded ones): first or last row of the list', () => {
  const rows = [row('a1', { worktreeId: 'wa' }), row('b1', { worktreeId: 'wb' }), row('c1', { worktreeId: 'wc', handle: null })]
  assert.equal(nextTarget(rows, 'a1', 'wz', 'next', OFF)?.paneKey, 'a1')
  assert.equal(nextTarget(rows, 'a1', 'wz', 'prev', OFF)?.paneKey, 'c1', 'a row with no cached handle can be the last one')
  assert.equal(nextTarget(rows, null, 'wc', 'next', OFF)?.paneKey, 'c1', 'wc has only that row: the restart lands on it')
  const skipC = { ...OFF, exclude: new Set(['c1']) }
  assert.equal(nextTarget(rows, null, 'wc', 'next', skipC)?.paneKey, 'a1', 'wc has only an excluded row')
  assert.equal(nextTarget(rows, 'a1', 'wz', 'prev', skipC)?.paneKey, 'b1')
  assert.equal(nextTarget(rows, null, null, 'next', OFF)?.paneKey, 'a1')
})

test('nextTarget: restart honours skipFinished inside the active worktree', () => {
  const rows = [
    row('b1', { worktreeId: 'wb', status: 'done' }),
    row('b2', { worktreeId: 'wb', status: 'working' }),
    row('a1', { worktreeId: 'wa' })
  ]
  assert.equal(nextTarget(rows, 'a1', 'wb', 'next', ON)?.paneKey, 'b2')
})

// ---- cycleOrder ----------------------------------------------------------------------------

test('cycleOrder activity: status rank, then newest first', () => {
  const rows = [
    row('done1', { status: 'done', sortAt: 900 }),
    row('work-old', { status: 'working', sortAt: 100 }),
    row('wait', { status: 'waiting', sortAt: 50 }),
    row('work-new', { status: 'working', sortAt: 500 })
  ]
  assert.deepEqual(keys(cycleOrder(rows, 'activity')), ['wait', 'work-new', 'work-old', 'done1'])
})

test('cycleOrder projects: most recently active worktree first, then agent order inside the worktree', () => {
  const rows = [
    row('b-late', { worktreeId: 'wb', worktreeName: 'b', worktreeActivityAt: 10, indexInWorktree: 1, status: 'waiting' }),
    row('a-1', { worktreeId: 'wa', worktreeName: 'a', worktreeActivityAt: 20, indexInWorktree: 1, status: 'done' }),
    row('b-first', { worktreeId: 'wb', worktreeName: 'b', worktreeActivityAt: 10, indexInWorktree: 0, status: 'done' }),
    row('a-0', { worktreeId: 'wa', worktreeName: 'a', worktreeActivityAt: 20, indexInWorktree: 0, status: 'working' })
  ]
  const order = cycleOrder(rows, 'projects')
  assert.deepEqual(keys(order), ['a-0', 'a-1', 'b-first', 'b-late'])
  // repeated presses walk every agent of a worktree before leaving it
  const walk: string[] = []
  let cursor: string | null = null
  for (let i = 0; i < 5; i++) {
    const t: Row = nextTarget(order, cursor, null, 'next', OFF)!
    walk.push(t.paneKey)
    cursor = t.paneKey
  }
  assert.deepEqual(walk, ['a-0', 'a-1', 'b-first', 'b-late', 'a-0'])
})

// ---- freeze --------------------------------------------------------------------------------

test('orderWithFreeze: within the window the last order is kept even as rows reorder', () => {
  const t0 = 10_000
  const before = [row('a', { sortAt: 300 }), row('b', { sortAt: 200 }), row('c', { sortAt: 100 })]
  const state = commitCycle(emptyCycleState(), cycleOrder(before, 'activity'), 'a', t0)
  assert.deepEqual(keys(before), ['a', 'b', 'c'])
  // c just became the newest working row, and a new row d appeared
  const after = [row('c', { sortAt: 900 }), row('a', { sortAt: 300 }), row('b', { sortAt: 200 }), row('d', { sortAt: 1000 })]
  assert.deepEqual(keys(cycleOrder(after, 'activity')), ['d', 'c', 'a', 'b'])
  const frozen = orderWithFreeze(state, after, 'activity', t0 + FREEZE_MS - 1)
  assert.equal(frozen.frozen, true)
  assert.deepEqual(keys(frozen.ordered), ['a', 'b', 'c']) // old order; the new row d waits
})

test('orderWithFreeze: after the window, or with an empty freeze, the fresh order is used', () => {
  const t0 = 10_000
  const rows = [row('a', { sortAt: 1 }), row('b', { sortAt: 2 })]
  const state = commitCycle(emptyCycleState(), [row('a'), row('b')], 'a', t0)
  const expired = orderWithFreeze(state, rows, 'activity', t0 + FREEZE_MS)
  assert.equal(expired.frozen, false)
  assert.deepEqual(keys(expired.ordered), ['b', 'a'])
  assert.equal(orderWithFreeze(emptyCycleState(), rows, 'activity', t0).frozen, false)
})

test('orderWithFreeze: rows that vanished drop out and fresh handles are used', () => {
  const t0 = 10_000
  const state = commitCycle(emptyCycleState(), [row('a'), row('b'), row('c')], 'a', t0)
  const rows = [row('c'), row('a', { handle: 'new-handle' })]
  const r = orderWithFreeze(state, rows, 'activity', t0 + 100)
  assert.deepEqual(keys(r.ordered), ['a', 'c'])
  assert.equal(r.ordered[0]!.handle, 'new-handle')
  // everything vanished: fall back to the fresh order rather than an empty list
  const none = orderWithFreeze(state, [row('z')], 'activity', t0 + 100)
  assert.deepEqual(keys(none.ordered), ['z'])
  assert.equal(none.frozen, false)
})

test('planCycle: rapid presses walk one stable list while working rows reorder', () => {
  let state = emptyCycleState()
  let rows = [row('a', { sortAt: 300 }), row('b', { sortAt: 200 }), row('c', { sortAt: 100 })]
  const press = (now: number, dir: 'next' | 'prev' = 'next') => {
    const plan = planCycle(state, rows, null, dir, 'activity', OFF, now)
    state = commitCycle(state, plan.ordered, plan.target!.paneKey, now)
    return plan.target!.paneKey
  }
  assert.equal(press(1000), 'a')
  // c starts producing output and jumps to the top of the live order
  rows = [row('c', { sortAt: 999 }), row('a', { sortAt: 300 }), row('b', { sortAt: 200 })]
  assert.equal(press(1400), 'b') // stable order a, b, c continues
  assert.equal(press(1800), 'c')
  assert.equal(press(2200), 'a') // wraps inside the frozen list
  // the freeze lapses: the next press uses the fresh order (c, a, b) from the cursor (a)
  assert.equal(press(2200 + FREEZE_MS + 1), 'b')
})

test('planCycle: two quick presses that cross worktrees are not undone by a stale active worktree', () => {
  // Orca still reports wa as active right after the first switch moved us into wb.
  const rows = [
    row('a1', { worktreeId: 'wa', worktreeName: 'a', worktreeActivityAt: 30, indexInWorktree: 0 }),
    row('b1', { worktreeId: 'wb', worktreeName: 'b', worktreeActivityAt: 20, indexInWorktree: 0 }),
    row('b2', { worktreeId: 'wb', worktreeName: 'b', worktreeActivityAt: 20, indexInWorktree: 1 }),
    row('c1', { worktreeId: 'wc', worktreeName: 'c', worktreeActivityAt: 10, indexInWorktree: 0 })
  ]
  let state = emptyCycleState()
  const press = (now: number) => {
    const plan = planCycle(state, rows, 'wa', 'next', 'projects', OFF, now)
    state = commitCycle(state, plan.ordered, plan.target!.paneKey, now)
    return plan.target!.paneKey
  }
  // First press: the person is in wa and the cursor is unset, so it restarts at wa's first agent.
  assert.equal(press(1000), 'a1')
  // Second press 300 ms later crosses into wb. The reported active worktree is still wa.
  assert.equal(press(1300), 'b1')
  // Third press: cursor b1 is outside the stale active worktree wa, but the freeze trusts the cursor.
  assert.equal(press(1600), 'b2')
  assert.equal(press(1900), 'c1')
})

test('planCycle: without a freeze the active-worktree restart applies, then trusts the cursor again', () => {
  const rows = [
    row('a1', { worktreeId: 'wa', worktreeName: 'a', worktreeActivityAt: 30 }),
    row('b1', { worktreeId: 'wb', worktreeName: 'b', worktreeActivityAt: 20, indexInWorktree: 0 }),
    row('b2', { worktreeId: 'wb', worktreeName: 'b', worktreeActivityAt: 20, indexInWorktree: 1 })
  ]
  const state = { cursor: 'a1', frozenKeys: null, frozenUntil: 0 }
  const plan = planCycle(state, rows, 'wb', 'next', 'projects', OFF, 50_000)
  assert.equal(plan.frozen, false)
  assert.equal(plan.target?.paneKey, 'b1') // the person moved to wb by hand
})

test('commitCycle keeps the cursor when no row is given and extends the freeze on every press', () => {
  const s1 = commitCycle(emptyCycleState(), [row('a'), row('b')], 'a', 1000)
  assert.equal(s1.cursor, 'a')
  assert.equal(s1.frozenUntil, 1000 + FREEZE_MS)
  const s2 = commitCycle(s1, [row('a'), row('b')], null, 2000)
  assert.equal(s2.cursor, 'a')
  assert.equal(s2.frozenUntil, 2000 + FREEZE_MS)
  assert.deepEqual(s2.frozenKeys, ['a', 'b'])
})

// ---- review fixes: the frozen order keeps its place when the cursor row disappears ------------------

test('planCycle: the cursor row vanishes mid-burst: next takes the first survivor after its old place, prev the nearest before', () => {
  const t0 = 10_000
  const before = [row('a'), row('b'), row('c'), row('d')]
  const state = commitCycle(emptyCycleState(), before, 'b', t0)
  const after = [row('a'), row('c'), row('d')] // b is gone
  const next = planCycle(state, after, null, 'next', 'activity', OFF, t0 + 300)
  const prev = planCycle(state, after, null, 'prev', 'activity', OFF, t0 + 300)
  assert.equal(next.frozen, true)
  assert.equal(next.target?.paneKey, 'c')
  assert.equal(prev.target?.paneKey, 'a')
})

test('planCycle: a vanished cursor at either end wraps from its old place', () => {
  const t0 = 10_000
  const all = [row('a'), row('b'), row('c'), row('d')]
  const lastGone = commitCycle(emptyCycleState(), all, 'd', t0)
  const firstGone = commitCycle(emptyCycleState(), all, 'a', t0)
  assert.equal(planCycle(lastGone, [row('a'), row('b'), row('c')], null, 'next', 'activity', OFF, t0 + 1).target?.paneKey, 'a')
  assert.equal(planCycle(lastGone, [row('a'), row('b'), row('c')], null, 'prev', 'activity', OFF, t0 + 1).target?.paneKey, 'c')
  assert.equal(planCycle(firstGone, [row('b'), row('c'), row('d')], null, 'next', 'activity', OFF, t0 + 1).target?.paneKey, 'b')
  assert.equal(planCycle(firstGone, [row('b'), row('c'), row('d')], null, 'prev', 'activity', OFF, t0 + 1).target?.paneKey, 'd')
})

test('planCycle: the place of a vanished cursor survives a failed press and the presses after it', () => {
  const t0 = 10_000
  let state = commitCycle(emptyCycleState(), [row('a'), row('b'), row('c'), row('d')], 'b', t0)
  const rows = [row('a'), row('c'), row('d')]
  // a press whose switches all failed commits no cursor: the order (with b's slot) must stay usable
  const failed = planCycle(state, rows, null, 'next', 'activity', OFF, t0 + 100)
  state = commitCycle(state, failed.ordered, null, t0 + 100)
  assert.equal(state.cursor, 'b')
  const retry = planCycle(state, rows, null, 'next', 'activity', OFF, t0 + 200)
  assert.equal(retry.target?.paneKey, 'c')
  state = commitCycle(state, retry.ordered, 'c', t0 + 200)
  assert.equal(planCycle(state, rows, null, 'next', 'activity', OFF, t0 + 300).target?.paneKey, 'd')
  // the placeholder for the vanished row is never a target
  assert.ok(retry.ordered.some((r) => r.paneKey === 'b'), 'it holds b place')
  assert.notEqual(retry.target?.paneKey, 'b')
})

test('planCycle: a vanished cursor steps to the nearest row, handle-less or not, and its placeholder is never a target', () => {
  const t0 = 10_000
  const state = commitCycle(emptyCycleState(), [row('a'), row('b'), row('c', { handle: null }), row('d')], 'b', t0)
  const rows = [row('a'), row('c', { handle: null }), row('d')]
  assert.equal(planCycle(state, rows, null, 'next', 'activity', OFF, t0 + 1).target?.paneKey, 'c')
  assert.equal(planCycle(state, rows, null, 'prev', 'activity', OFF, t0 + 1).target?.paneKey, 'a')
  // with every survivor excluded nothing is left: the placeholder for b is not a way out
  const allOut = { ...OFF, exclude: new Set(['a', 'c', 'd']) }
  assert.equal(planCycle(state, rows, null, 'next', 'activity', allOut, t0 + 1).target, null)
  assert.equal(planCycle(state, rows, null, 'prev', 'activity', allOut, t0 + 1).target, null)
})

test('orderForCursor: a clicked row that is not in the frozen list re-seeds the walk from the live order', () => {
  const t0 = 10_000
  const state = commitCycle(emptyCycleState(), [row('a', { sortAt: 300 }), row('b', { sortAt: 200 })], 'a', t0)
  const live = [row('a', { sortAt: 300 }), row('n', { sortAt: 250 }), row('b', { sortAt: 200 })] // n appeared meanwhile
  assert.deepEqual(keys(cycleModule.orderForCursor(state, live, 'activity', t0 + 100, 'n')), ['a', 'n', 'b'])
  // a clicked row that is in the frozen list keeps the frozen order
  assert.deepEqual(keys(cycleModule.orderForCursor(state, live, 'activity', t0 + 100, 'b')), ['a', 'b'])
  // a clicked row absent from the live list too (hidden, folded) is appended so the cursor is findable
  assert.deepEqual(keys(cycleModule.orderForCursor(state, live, 'activity', t0 + 100, 'ghost', row('ghost'))), ['a', 'n', 'b', 'ghost'])
})
