// Agent Roster: cycling between agents. Pure functions; the worker owns the state object.
//
// `Mod+Shift+Quote` / `Mod+Shift+Semicolon` walk a list of rows. Which list depends on the
// `cycleOrder` setting. A cursor remembers the last row switched to, so the next press continues
// from it, and the order is frozen for a short time after each press so a burst of presses walks
// one stable list even while working rows reorder underneath it.

import { orderByActivity, orderByProjects } from './model.ts'
import type { CycleOrder, Row, StatusId } from './model.ts'

export type Direction = 'next' | 'prev'

/** Rows in these states are skipped when `skipFinished` is on. */
export const FINISHED_STATUSES: ReadonlySet<StatusId> = new Set<StatusId>(['done', 'idle', 'interrupted', 'failed'])

/** How long the computed order stays frozen after a press (sliding: every press extends it). */
export const FREEZE_MS = 2500

export interface CycleOptions {
  skipFinished: boolean
  /** Pane keys to pass over, such as a row whose switch just failed. */
  exclude?: ReadonlySet<string>
}

/** The cycle list for a setting: the panel's activity order, or the sidebar's worktree order then agent order. */
export function cycleOrder(rows: readonly Row[], mode: CycleOrder): Row[] {
  return mode === 'projects' ? orderByProjects(rows) : orderByActivity(rows)
}

/** The stand-ins `vanishedRow` makes: never a target. */
const PLACEHOLDERS = new WeakSet<Row>()

function eligible(row: Row, opts: CycleOptions): boolean {
  if (PLACEHOLDERS.has(row)) return false
  if (opts.exclude?.has(row.paneKey)) return false
  if (opts.skipFinished && FINISHED_STATUSES.has(row.status)) return false
  return true
}

/**
 * The row to switch to, or null when nothing can be switched to.
 *
 * `ordered` is the list to walk. An excluded row and, with `skipFinished`, a finished row are
 * passed over. A row with no cached terminal handle is a candidate like any other: the worker looks
 * the terminal up when it switches, and skips the row (through `exclude`) when that finds nothing. With a usable cursor the walk steps from it and
 * wraps at the ends; a single eligible row is returned every time. The cursor is usable when it is
 * in the list and, if `activeWorktreeId` is given, inside that worktree. Otherwise the walk
 * restarts: `next` lands on the active worktree's first agent, `prev` on its last, and with no
 * agent there on the first (or last) row of the list. Pass `activeWorktreeId: null` to trust the
 * cursor, as the worker does while the order is frozen.
 */
export function nextTarget(
  ordered: readonly Row[],
  cursor: string | null,
  activeWorktreeId: string | null,
  direction: Direction,
  opts: CycleOptions
): Row | null {
  const n = ordered.length
  if (n === 0) return null
  const step = direction === 'next' ? 1 : -1
  const ok = (r: Row) => eligible(r, opts)
  if (!ordered.some(ok)) return null

  const ci = cursor === null ? -1 : ordered.findIndex((r) => r.paneKey === cursor)
  const cursorUsable = ci >= 0 && (activeWorktreeId === null || ordered[ci]!.worktreeId === activeWorktreeId)
  if (cursorUsable) {
    for (let i = 1; i <= n; i++) {
      const row = ordered[(((ci + step * i) % n) + n) % n]!
      if (ok(row)) return row
    }
    return null
  }

  const pickEnd = (list: readonly Row[]): Row | null => {
    const candidates = list.filter(ok)
    if (candidates.length === 0) return null
    return direction === 'next' ? candidates[0]! : candidates[candidates.length - 1]!
  }
  if (activeWorktreeId !== null) {
    const inActive = pickEnd(ordered.filter((r) => r.worktreeId === activeWorktreeId))
    if (inActive) return inActive
  }
  return pickEnd(ordered)
}

// ---------------------------------------------------------------------------------------------
// Cursor and freeze state

export interface CycleState {
  /** The paneKey last switched to. */
  cursor: string | null
  /** The order walked by the last press, kept while `now < frozenUntil`. */
  frozenKeys: string[] | null
  frozenUntil: number
}

export function emptyCycleState(): CycleState {
  return { cursor: null, frozenKeys: null, frozenUntil: 0 }
}

/**
 * The list to walk right now. While the freeze runs it is the last press's order, re-read from the
 * current rows (so handles and statuses are fresh, vanished rows drop out and new rows wait).
 */
export function orderWithFreeze(
  state: CycleState,
  rows: readonly Row[],
  mode: CycleOrder,
  now: number
): { ordered: Row[]; frozen: boolean } {
  if (state.frozenKeys !== null && now < state.frozenUntil) {
    const byKey = new Map(rows.map((r) => [r.paneKey, r] as const))
    const ordered: Row[] = []
    for (const key of state.frozenKeys) {
      const row = byKey.get(key)
      if (row) ordered.push(row)
    }
    if (ordered.length > 0) return { ordered, frozen: true }
  }
  return { ordered: cycleOrder(rows, mode), frozen: false }
}

/** A stand-in for a row that is gone: it is marked in `PLACEHOLDERS`, so no walk ever lands on it. */
function vanishedRow(paneKey: string): Row {
  const row: Row = {
    paneKey,
    handle: null,
    worktreeId: '',
    worktreeName: '',
    repo: '',
    branch: '',
    agentType: 'agent',
    title: '',
    titleSource: 'fallback',
    status: 'idle',
    statusLabel: '',
    unread: false,
    sortAt: 0,
    isCurrentWorktree: false,
    hasLivePty: false,
    isChild: false,
    isFolded: false,
    worktreeActivityAt: 0,
    indexInWorktree: 0
  }
  PLACEHOLDERS.add(row)
  return row
}

/**
 * `ordered` with a stand-in for the vanished cursor row put back at the place it had in the frozen
 * list, so the next step is taken from there: `next` lands on the first survivor after it, `prev`
 * on the nearest one before it, both wrapping.
 */
function keepCursorPlace(ordered: readonly Row[], frozenKeys: readonly string[], cursor: string): Row[] {
  const at = frozenKeys.indexOf(cursor)
  if (at < 0) return ordered.slice()
  const alive = new Set(ordered.map((r) => r.paneKey))
  const before = frozenKeys.slice(0, at).filter((k) => alive.has(k)).length
  return [...ordered.slice(0, before), vanishedRow(cursor), ...ordered.slice(before)]
}

export interface CyclePlan {
  /**
   * The list that was walked. While frozen and the cursor row has vanished it holds one placeholder
   * (never a target) at the cursor's old place; commit this list to keep that place.
   */
  ordered: Row[]
  frozen: boolean
  target: Row | null
}

/** Picks the target for one press. Pure: nothing is committed until the switch succeeds. */
export function planCycle(
  state: CycleState,
  rows: readonly Row[],
  activeWorktreeId: string | null,
  direction: Direction,
  mode: CycleOrder,
  opts: CycleOptions,
  now: number
): CyclePlan {
  const fresh = orderWithFreeze(state, rows, mode, now)
  let ordered = fresh.ordered
  const { frozen } = fresh
  if (frozen && state.cursor !== null && state.frozenKeys !== null && !ordered.some((r) => r.paneKey === state.cursor)) {
    ordered = keepCursorPlace(ordered, state.frozenKeys, state.cursor)
  }
  // While frozen the Orca-reported active worktree may still be the one we just left.
  const target = nextTarget(ordered, state.cursor, frozen ? null : activeWorktreeId, direction, opts)
  return { ordered, frozen, target }
}

/**
 * The list to commit when the cursor is moved by hand (a click on a row). The frozen order is kept
 * when it holds the clicked row; otherwise the walk is re-seeded from the live order, which does,
 * so the next press continues from where the click landed. A clicked row that is in neither list
 * (it is hidden from the panel) is appended so the cursor can still be found.
 */
export function orderForCursor(state: CycleState, rows: readonly Row[], mode: CycleOrder, now: number, cursorKey: string, clicked?: Row): Row[] {
  const { ordered } = orderWithFreeze(state, rows, mode, now)
  if (ordered.some((r) => r.paneKey === cursorKey)) return ordered
  const live = cycleOrder(rows, mode)
  if (live.some((r) => r.paneKey === cursorKey)) return live
  return clicked ? [...live, clicked] : live
}

/** The state after a press: the cursor moves to `cursor` and the walked order is frozen again. */
export function commitCycle(state: CycleState, ordered: readonly Row[], cursor: string | null, now: number): CycleState {
  return {
    cursor: cursor ?? state.cursor,
    frozenKeys: ordered.map((r) => r.paneKey),
    frozenUntil: now + FREEZE_MS
  }
}
