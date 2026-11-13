// Agent Roster: the plugin worker.
//
// It keeps a model of every running agent (Orca's own Activity verdicts joined with the terminal
// titles), pushes it to the panel when it changes, and answers the two shortcuts that cycle
// between agents. All process and timer access goes through `Deps`, so `activate` itself only
// registers handlers and starts the poller, and tests inject fakes.
//
// Nothing in here may throw out of an event, command or timer: an uncaught exception or an
// unhandled rejection kills the worker. Every async entry point catches and logs.

import type { JsonValue, OrcaWorkerApi } from 'orca/worker'
import { commitCycle, emptyCycleState, nextTarget, orderForCursor, planCycle } from './cycle.ts'
import type { Direction } from './cycle.ts'
import { CLI_TIMEOUT_MS, createCli, fetchSnapshot, fetchTerminals, switchTerminal } from './cli.ts'
import type { CliRunner } from './cli.ts'
import {
  buildModel,
  DEFAULT_SETTINGS,
  errMsg,
  fitModel,
  isGroupMode,
  listTerminals,
  normalize,
  readSettings,
  statusBarSummary,
  withActiveWorktree
} from './model.ts'
import type { ModelError, Normalized, Row, RosterModel, StatusBarSummary, TerminalRecord } from './model.ts'
import { createPoller } from './poller.ts'
import type { Poller, Timers } from './poller.ts'
import { describeList, findExact, findFallback, RESOLVE_BACKOFF_MS } from './resolve.ts'
import type { Found, Target } from './resolve.ts'

export const REFRESH_INTERVAL_MS = 30_000
export const DEBOUNCE_MS = 400
export const MAX_WAIT_MS = 2_000
/** A press refreshes first when the last good refresh is older than this (and no burst is on). */
export const STALE_PRESS_MS = 5_000
/** How long a press or a panel load waits for a refresh before using the cached model. */
export const REFRESH_WAIT_MS = 2_500
/** Presses queued behind a running one; more are dropped (a held key must not pile up). */
export const PRESS_QUEUE_MAX = 3
/**
 * The whole life of one shortcut press, from the moment it is queued: waiting behind earlier
 * presses, the refresh, and every switch attempt share it. Kept under 25 s so one press never ends
 * (or hangs the ones queued behind it) later than that, however stuck the Orca CLI is.
 */
export const PRESS_BUDGET_MS = 24_000
/** The same for a click in the panel, which the panel itself gives up on after 20 s. */
export const FOCUS_BUDGET_MS = 18_000
/** The refresh button waits this long for fresh data before answering with what it has. */
export const REFRESH_BUTTON_WAIT_MS = 8_000
/** A switch started with less budget than this left cannot finish: it is not started. */
const MIN_SWITCH_MS = 500
/** The same for a terminal-list call. */
const MIN_LIST_MS = 500
/**
 * After a refresh that leaves an agent row without a terminal, the terminal list alone is read once
 * more after this long: the terminal is usually registered a moment after the agent shows up.
 */
export const QUICK_REPOLL_MS = 700

export const STATUS_ITEM_ID = 'summary'
export const NO_AGENTS_MESSAGE = 'Agent Roster: no agents to switch to'
export const SWITCH_FAILED_MESSAGE = 'Agent Roster: could not switch (see the plugin log)'
export const TIMED_OUT_MESSAGE = 'Agent Roster: Orca did not answer in time'
/** A press where no agent in the walk had a terminal Orca would list, even after looking again. */
export const NO_TERMINAL_MESSAGE = 'Agent Roster: no switchable agent, Orca lists no terminal for them right now. Try again.'
/** The same for a click on one row; the panel shows it as it is. */
export const NO_TERMINAL_REASON = 'Orca lists no terminal for this agent right now. It may still be starting, so try again in a moment.'

export interface Deps extends Timers {
  cli: CliRunner
  now(): number
}

export function realDeps(): Deps {
  return {
    cli: createCli(),
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>)
  }
}

let depsOverride: Deps | null = null
let current: Roster | null = null

/** Tests inject fake deps before `activate` runs. */
export function setDeps(deps: Deps): void {
  depsOverride = deps
}

export function resetDeps(): void {
  depsOverride = null
}

export interface Roster {
  poller: Poller
  /** The model as posted to the panel (capped when it is too large for one post). */
  getModel(): RosterModel
  /** One shortcut press, queued like the command. Resolves with a message to show, or undefined when it switched. */
  press(direction: Direction, signal?: AbortSignal): Promise<string | undefined>
  stop(): void
}

/** What one queued press or click may still spend: until `deadline`, and not after `signal` aborts. */
interface Budget {
  signal: AbortSignal | undefined
  deadline: number
}

function asObject(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

export function createRoster(orca: OrcaWorkerApi, deps: Deps): Roster {
  const log = (message: string): void => {
    try {
      orca.log(`[agent-roster] ${message}`)
    } catch {
      // the log must never throw
    }
  }
  const disposables: Array<{ dispose(): void }> = []
  const safely = (what: string, fn: () => void): void => {
    try {
      fn()
    } catch (e) {
      log(`${what} failed: ${errMsg(e)}`)
    }
  }

  let stopped = false
  let settings = DEFAULT_SETTINGS
  let norm: Normalized = { rows: [], activeWorktreeId: null }
  let loaded = false
  let lastOkAt = 0
  let error: ModelError | null = null
  let cycle = emptyCycleState()
  /** Every visible row: what the shortcuts walk. */
  let full: RosterModel = buildModel(norm, settings, cycle.cursor, error)
  /** What the panel gets: `full`, capped when it is too large for one post. */
  let model: RosterModel = fitModel(full)
  /** The model the panel last received. It moves only after a post went through, so a refused post is retried. */
  let postedSig = JSON.stringify(model)
  let postErrorLogged = false
  let firstTimingLogged = false
  /** The `worktree ps` answer behind `norm`, kept so a terminal-list-only re-poll can rebuild the rows. */
  let lastPs: unknown = null
  /** Full refreshes completed so far; a quick re-poll that started before the latest one is dropped. */
  let fullRuns = 0

  // ---- model, panel and status bar ------------------------------------------------------------

  let barSig = JSON.stringify(statusBarSummary([]))
  let barErrorLogged = false

  async function pushStatusBar(s: StatusBarSummary): Promise<void> {
    try {
      if (!orca.host.has('statusBar.update')) return
      if (s.visible) {
        await orca.host.call('statusBar.update', {
          id: STATUS_ITEM_ID,
          text: s.text,
          icon: 'agent',
          tone: s.tone,
          tooltip: s.tooltip,
          visible: true
        })
      } else {
        await orca.host.call('statusBar.update', { id: STATUS_ITEM_ID, visible: false })
      }
    } catch (e) {
      barSig = '' // try again on the next change
      if (!barErrorLogged) {
        barErrorLogged = true
        log(`statusBar.update failed: ${errMsg(e)}`)
      }
    }
  }

  function updateStatusBar(): void {
    const s = statusBarSummary(full.rows)
    const sig = JSON.stringify(s)
    if (sig === barSig) return
    barSig = sig
    void pushStatusBar(s)
  }

  /**
   * Rebuilds the model and posts it to the panel when it differs from the last one that arrived.
   * A post that throws leaves that record alone, so the next rebuild (every refresh runs one)
   * tries again instead of leaving the panel on an old roster.
   */
  function rebuild(): void {
    full = buildModel(norm, settings, cycle.cursor, error)
    model = fitModel(full)
    const sig = JSON.stringify(model)
    if (sig !== postedSig) {
      try {
        orca.panels.post('roster.update', model as unknown as JsonValue)
        postedSig = sig
        postErrorLogged = false
      } catch (e) {
        if (!postErrorLogged) log(`panel post failed: ${errMsg(e)}`)
        postErrorLogged = true
      }
    }
    updateStatusBar()
  }

  // ---- refresh --------------------------------------------------------------------------------

  const poller = createPoller<Normalized>({
    run: async () => {
      const snap = await fetchSnapshot(deps.cli, deps.now)
      if (!firstTimingLogged) {
        firstTimingLogged = true
        log(`dev note: first refresh took ps --json ${snap.psMs} ms and terminal list --json ${snap.terminalsMs} ms`)
      }
      const next = normalize(snap.ps, snap.terminals, deps.now())
      lastPs = snap.ps
      fullRuns++
      return next
    },
    onResult: (result) => {
      if (result.ok) {
        norm = result.value
        loaded = true
        lastOkAt = deps.now()
        if (error) log('Orca CLI reachable again')
        error = null
      } else {
        const detail = errMsg(result.error).slice(0, 200)
        if (!error || error.detail !== detail) log(`refresh failed: ${detail}`)
        // Keep the last good rows; the panel shows a small note.
        error = { message: 'Orca CLI unavailable, retrying', detail }
      }
      rebuild()
      if (result.ok) maybeQuickRepoll()
    },
    timers: deps,
    now: () => deps.now(),
    intervalMs: REFRESH_INTERVAL_MS,
    debounceMs: DEBOUNCE_MS,
    maxWaitMs: MAX_WAIT_MS
  })

  // ---- the quick re-poll ----------------------------------------------------------------------

  let quickTimer: unknown = null
  let quickRunning = false
  /** The agents without a terminal that the last quick re-poll was for. */
  let quickCovered = ''

  /**
   * Called after every good full refresh. When a visible agent has no terminal, the terminal list
   * alone is read once more after QUICK_REPOLL_MS. One re-poll per set of missing agents (a burst):
   * the same set after later refreshes schedules nothing, and a re-poll's own result never
   * schedules another, so an agent that never gets a terminal cannot keep it going. Single-flight:
   * nothing is scheduled while one is waiting or running.
   */
  function maybeQuickRepoll(): void {
    const missing = full.rows.filter((r) => r.handle === null).map((r) => r.paneKey).sort()
    if (missing.length === 0) {
      quickCovered = ''
      return
    }
    const sig = missing.join('\n')
    if (stopped || sig === quickCovered || quickTimer !== null || quickRunning) return
    quickCovered = sig
    quickTimer = deps.setTimeout(() => {
      quickTimer = null
      void quickRepoll()
    }, QUICK_REPOLL_MS)
  }

  async function quickRepoll(): Promise<void> {
    if (stopped || lastPs === null) return
    quickRunning = true
    const runs = fullRuns
    try {
      const raw = await fetchTerminals(deps.cli, CLI_TIMEOUT_MS)
      // A full refresh that finished meanwhile is newer than this answer.
      if (stopped || runs !== fullRuns || lastPs === null) return
      const fresh = normalize(lastPs, raw, deps.now())
      norm = norm.activeWorktreeId !== null ? withActiveWorktree(fresh, norm.activeWorktreeId) : fresh
      rebuild()
    } catch {
      // The next full refresh asks again; a failed extra look is not worth a log line.
    } finally {
      quickRunning = false
    }
  }

  /**
   * Waits for the next completed refresh, but never longer than `ms` and not past an abort: a slow
   * or stuck CLI must not hang a press, a click or a panel request.
   */
  function boundedRefresh(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal?.aborted || ms <= 0) {
        resolve()
        return
      }
      let finished = false
      const finish = (): void => {
        if (finished) return
        finished = true
        deps.clearTimeout(timer)
        signal?.removeEventListener('abort', finish)
        resolve()
      }
      const timer = deps.setTimeout(finish, ms)
      signal?.addEventListener('abort', finish, { once: true })
      poller.refreshNow().then(finish, finish)
    })
  }

  // ---- settings -------------------------------------------------------------------------------

  async function loadSettings(): Promise<void> {
    try {
      settings = readSettings(await orca.settings.get())
    } catch (e) {
      log(`could not read settings, using the last known: ${errMsg(e)}`)
    }
  }

  // ---- switching ------------------------------------------------------------------------------

  let chain: Promise<void> = Promise.resolve()
  let pending = 0

  const aborted = (b: Budget): boolean => b.signal?.aborted === true
  const spent = (b: Budget): boolean => aborted(b) || deps.now() >= b.deadline
  const left = (b: Budget): number => b.deadline - deps.now()

  /**
   * Runs `run` after every earlier press or click has finished, so each one sees the committed
   * cursor. The budget starts when the work is queued; work whose budget ran out (or whose caller
   * gave up) while it waited is answered with `expired` and never reaches the CLI.
   */
  function enqueue<T>(budgetMs: number, signal: AbortSignal | undefined, run: (budget: Budget) => Promise<T>, dropped: T, expired: T): Promise<T> {
    if (pending >= PRESS_QUEUE_MAX) return Promise.resolve(dropped)
    const budget: Budget = { signal, deadline: deps.now() + budgetMs }
    pending++
    const result = chain.then(() => (spent(budget) ? expired : run(budget)))
    chain = result.then(
      () => {
        pending--
      },
      () => {
        pending--
      }
    )
    return result
  }

  /** The cursor moves to `row`, the walked order is frozen, and the cached active worktree follows. */
  function commit(ordered: readonly Row[], row: Row | null): void {
    cycle = commitCycle(cycle, ordered, row ? row.paneKey : null, deps.now())
    if (row) norm = withActiveWorktree(norm, row.worktreeId)
    rebuild()
    poller.request()
  }

  // ---- finding the terminal ---------------------------------------------------------------------

  /** What one press or click learned while looking terminals up. It lives for that one action. */
  interface Lookup {
    /** The newest fresh terminal list of this action, null before the first one. */
    terms: TerminalRecord[] | null
    /** A list call failed: no more are made in this action. */
    failed: boolean
    /** The log line for the first row that was not found at the first look; null when none missed. */
    line: string | null
    /** How later rows that missed at the first look were resolved anyway (a fallback, the cached handle). */
    resolvedLater: string[]
    /** Later rows that stayed unresolved. */
    more: number
  }

  const newLookup = (): Lookup => ({ terms: null, failed: false, line: null, resolvedLater: [], more: 0 })

  /** One log line per action that had a miss, however many looks or rows it took. */
  function flushLookup(lk: Lookup, what: string): void {
    if (lk.line === null) return
    const later = lk.resolvedLater.slice(0, 2).map((how) => `; a later agent: ${how}`).join('')
    const unresolved = lk.more > 0 ? `; ${lk.more} more agent${lk.more === 1 ? '' : 's'} had no terminal either` : ''
    log(`handle lookup (${what}): ${lk.line}${later}${unresolved}`)
  }

  /** A fresh `terminal list`, within the budget. False when it could not be had (the caller stops looking). */
  async function freshList(budget: Budget, lk: Lookup): Promise<boolean> {
    const ms = Math.min(CLI_TIMEOUT_MS, left(budget))
    if (aborted(budget) || lk.failed || ms < MIN_LIST_MS) return false
    try {
      lk.terms = listTerminals(await fetchTerminals(deps.cli, ms, budget.signal))
      return true
    } catch {
      // An abort is the caller's to report; any other failure means this CLI is not answering.
      if (!aborted(budget)) lk.failed = true
      return false
    }
  }

  /** Waits `ms`, or less when the budget cannot spare it. False when the wait was cut short or the budget cannot afford another look. */
  function pause(ms: number, budget: Budget): Promise<boolean> {
    const wait = Math.min(ms, left(budget) - MIN_SWITCH_MS - MIN_LIST_MS)
    if (aborted(budget) || wait <= 0) return Promise.resolve(false)
    return new Promise((resolve) => {
      let done = false
      const finish = (ok: boolean): void => {
        if (done) return
        done = true
        deps.clearTimeout(timer)
        budget.signal?.removeEventListener('abort', onAbort)
        resolve(ok)
      }
      const onAbort = (): void => finish(false)
      const timer = deps.setTimeout(() => finish(!aborted(budget)), wait)
      budget.signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  /**
   * The handle to switch to for `row`, or null. The model's handle is only a hint: the terminal
   * list is read now and the pane looked up by its key. A pane that is not listed is looked up
   * again up to three more times (250, 500 and 800 ms apart) when `patient` and its pty is alive;
   * then the two guarded fallbacks of resolve.ts are tried. Only when Orca's list cannot be read at
   * all is the cached handle used. A stale cached handle never beats a list that lacks it.
   * Rows after the first in one press reuse the list already in hand (`patient` false): a lap of
   * unresolvable rows must not cost a backoff per row.
   */
  async function resolveHandle(row: Row, budget: Budget, lk: Lookup, patient: boolean): Promise<string | null> {
    const target: Target = { paneKey: row.paneKey, worktreeId: row.worktreeId, agentType: row.agentType }
    const retries = patient && row.hasLivePty ? RESOLVE_BACKOFF_MS.length : 0
    let looks = 0
    let found: Found | null = null
    let foundAt = 0
    let firstMiss: string | null = null
    let cut = false
    for (let look = 0; look <= retries; look++) {
      if (look > 0 && !(await pause(RESOLVE_BACKOFF_MS[look - 1]!, budget))) {
        cut = true
        break
      }
      if ((look > 0 || lk.terms === null) && !(await freshList(budget, lk))) {
        cut = !lk.failed
        break
      }
      looks++
      found = findExact(lk.terms ?? [], row.paneKey)
      if (found) {
        foundAt = looks
        break
      }
      if (firstMiss === null) firstMiss = describeList(lk.terms, target)
    }
    if (aborted(budget)) return null
    let how = ''
    if (found === null && lk.terms !== null) {
      const claimed = new Set(norm.rows.filter((r) => r.paneKey !== row.paneKey).map((r) => r.paneKey))
      found = findFallback(lk.terms, target, claimed)
      if (found) how = found.via === 'agent type' ? 'used the only unclaimed terminal of the same agent type in the worktree' : 'used the only unclaimed terminal in the same tab'
    }
    if (found === null && lk.terms === null && row.handle) {
      found = { handle: row.handle, via: 'pane' }
      how = 'the terminal list could not be read, used the cached handle'
      firstMiss = firstMiss ?? describeList(null, target)
    }
    if (found !== null && how === '' && foundAt <= 1) return found.handle // found at once: nothing to report
    if (how === '') {
      const n = (k: number): string => `${k} lookup${k === 1 ? '' : 's'}`
      if (found) how = `found on attempt ${foundAt} of ${retries + 1}`
      else if (lk.failed) how = looks === 0 ? 'the terminal list could not be read' : `the terminal list stopped answering after ${n(looks)}`
      else if (cut) how = `gave up after ${looks} of ${n(retries + 1)} (out of time)`
      else how = looks === 1 ? 'the only lookup failed' : `all ${n(looks)} failed`
    }
    const detail = `${firstMiss ?? describeList(lk.terms, target)}, ${how}`
    if (lk.line === null) lk.line = detail
    else if (found) lk.resolvedLater.push(how)
    else lk.more++
    return found ? found.handle : null
  }

  // ---- pressing and clicking ---------------------------------------------------------------------

  async function press(direction: Direction, budget: Budget): Promise<string | undefined> {
    const lk = newLookup()
    try {
      const t0 = deps.now()
      const burst = cycle.frozenKeys !== null && t0 < cycle.frozenUntil
      if (!loaded || (!burst && t0 - lastOkAt > STALE_PRESS_MS)) await boundedRefresh(Math.min(REFRESH_WAIT_MS, left(budget)), budget.signal)
      if (spent(budget)) return TIMED_OUT_MESSAGE
      const opts = { skipFinished: settings.skipFinished }
      const plan = planCycle(cycle, full.rows, full.activeWorktreeId, direction, settings.cycleOrder, opts, deps.now())
      let target: Row | null = plan.target
      if (!target) {
        log('no switchable agents')
        return NO_AGENTS_MESSAGE
      }
      const tried = new Set<string>()
      let switches = 0
      let unresolved = 0
      // The target; then, one row at a time and at most one lap, the next row when Orca lists no
      // terminal for it (skipped) or the switch fails (once), while the budget lasts.
      for (let step = 0; target !== null && step < plan.ordered.length && switches < 2; step++) {
        if (aborted(budget) || left(budget) < MIN_SWITCH_MS) break
        const handle = await resolveHandle(target, budget, lk, step === 0)
        if (aborted(budget)) return TIMED_OUT_MESSAGE
        if (handle === null) {
          unresolved++
          tried.add(target.paneKey)
          target = nextTarget(plan.ordered, target.paneKey, null, direction, { ...opts, exclude: tried })
          continue
        }
        const remaining = left(budget)
        if (remaining < MIN_SWITCH_MS) break
        switches++
        const res = await switchTerminal(deps.cli, handle, Math.min(CLI_TIMEOUT_MS, remaining), budget.signal)
        if (res.ok) {
          commit(plan.ordered, target)
          return undefined
        }
        if (aborted(budget)) return TIMED_OUT_MESSAGE
        log(`switching to a ${target.agentType} agent failed: ${res.reason}`)
        tried.add(target.paneKey)
        target = nextTarget(plan.ordered, target.paneKey, null, direction, { ...opts, exclude: tried })
      }
      if (aborted(budget)) return TIMED_OUT_MESSAGE
      commit(plan.ordered, null) // keep the order (and a vanished cursor's place in it) steady for the burst; this also asks for a refresh
      if (switches > 0) return SWITCH_FAILED_MESSAGE
      // "Orca lists no terminal" is only true when Orca was asked and answered.
      return unresolved > 0 && left(budget) >= MIN_SWITCH_MS && !(lk.failed && lk.terms === null) ? NO_TERMINAL_MESSAGE : TIMED_OUT_MESSAGE
    } catch (e) {
      log(`press failed: ${errMsg(e)}`)
      return `Agent Roster: ${errMsg(e)}`
    } finally {
      flushLookup(lk, 'shortcut')
    }
  }

  const queuedPress = (direction: Direction, signal?: AbortSignal): Promise<string | undefined> =>
    enqueue(PRESS_BUDGET_MS, signal, (budget) => press(direction, budget), undefined, TIMED_OUT_MESSAGE)

  type FocusAnswer = { ok: boolean; reason?: string }

  async function focus(paneKey: string, budget: Budget): Promise<FocusAnswer> {
    const lk = newLookup()
    try {
      const row = norm.rows.find((r) => r.paneKey === paneKey)
      if (!row) return { ok: false, reason: 'That agent is no longer running.' }
      if (aborted(budget) || left(budget) < MIN_SWITCH_MS) return { ok: false, reason: 'Orca did not answer in time.' }
      const handle = await resolveHandle(row, budget, lk, true)
      if (handle === null) {
        if (aborted(budget) || left(budget) < MIN_SWITCH_MS || (lk.failed && lk.terms === null)) return { ok: false, reason: 'Orca did not answer in time.' }
        // Say what happened, and look again right now so the row picks up its terminal once there is one.
        if (!stopped) void poller.refreshNow()
        return { ok: false, reason: NO_TERMINAL_REASON }
      }
      const remaining = left(budget)
      if (aborted(budget) || remaining < MIN_SWITCH_MS) return { ok: false, reason: 'Orca did not answer in time.' }
      const res = await switchTerminal(deps.cli, handle, Math.min(CLI_TIMEOUT_MS, remaining), budget.signal)
      if (!res.ok) {
        log(`focus failed: ${res.reason}`)
        return { ok: false, reason: aborted(budget) ? 'Orca did not answer in time.' : 'Orca could not switch to that terminal.' }
      }
      // A clicked row outside the frozen walk re-seeds it from the live order, so the next press continues from here.
      commit(orderForCursor(cycle, full.rows, settings.cycleOrder, deps.now(), row.paneKey, row), row)
      return { ok: true }
    } catch (e) {
      log(`focus failed: ${errMsg(e)}`)
      return { ok: false, reason: 'Orca could not switch to that terminal.' }
    } finally {
      flushLookup(lk, 'click')
    }
  }

  // ---- registration ---------------------------------------------------------------------------

  const registerCommand = (id: string, direction: Direction): void =>
    safely(`register ${id}`, () => {
      disposables.push(
        orca.commands.register(id, async (_args, context) => {
          try {
            return await queuedPress(direction, context?.signal)
          } catch (e) {
            log(`${id} failed: ${errMsg(e)}`)
            return `Agent Roster: ${errMsg(e)}`
          }
        })
      )
    })
  registerCommand('agent-roster.next', 'next')
  registerCommand('agent-roster.prev', 'prev')

  safely('register roster.list', () => {
    disposables.push(
      orca.panels.handle('roster.list', async (_input, context) => {
        if (!loaded && !error) await boundedRefresh(REFRESH_WAIT_MS, context?.signal)
        else poller.request()
        return model
      })
    )
  })
  safely('register roster.refresh', () => {
    disposables.push(
      orca.panels.handle('roster.refresh', async (_input, context) => {
        await boundedRefresh(REFRESH_BUTTON_WAIT_MS, context?.signal)
        return model
      })
    )
  })
  safely('register roster.focus', () => {
    disposables.push(
      orca.panels.handle('roster.focus', async (input, context) => {
        const paneKey = asObject(input)?.paneKey
        if (typeof paneKey !== 'string' || paneKey === '') return { ok: false, reason: 'No agent was named.' }
        return enqueue(
          FOCUS_BUDGET_MS,
          context?.signal,
          (budget) => focus(paneKey, budget),
          { ok: false, reason: 'Busy switching, try again.' },
          { ok: false, reason: 'Orca did not answer in time.' }
        )
      })
    )
  })
  safely('register roster.setGroup', () => {
    disposables.push(
      orca.panels.handle('roster.setGroup', async (input) => {
        const mode = asObject(input)?.mode
        if (!isGroupMode(mode)) return { ok: false, reason: 'Group by must be status or worktree.' }
        settings = { ...settings, groupBy: mode }
        try {
          await orca.settings.set('groupBy', mode)
        } catch (e) {
          log(`could not save groupBy: ${errMsg(e)}`)
        }
        rebuild()
        return { ok: true, model }
      })
    )
  })

  for (const event of ['agent.status.changed', 'workspace.changed'] as const) {
    safely(`subscribe ${event}`, () => {
      disposables.push(orca.events.on(event, () => poller.request()))
    })
  }
  safely('watch settings', () => {
    disposables.push(
      orca.settings.onDidChange(() => {
        void loadSettings()
          .then(() => rebuild())
          .catch((e) => log(`settings change failed: ${errMsg(e)}`))
      })
    )
  })

  // Hide the item until there is something to count, then start polling once settings are read.
  void pushStatusBar(statusBarSummary([]))
  void loadSettings()
    .then(() => {
      if (stopped) return
      rebuild()
      poller.start()
    })
    .catch((e) => log(`start failed: ${errMsg(e)}`))

  return {
    poller,
    getModel: () => model,
    press: queuedPress,
    stop() {
      stopped = true
      if (quickTimer !== null) deps.clearTimeout(quickTimer)
      quickTimer = null
      poller.stop()
      for (const d of disposables.splice(0)) safely('dispose', () => d.dispose())
    }
  }
}

/** Orca calls this once when the worker starts. It must be the DEFAULT export. */
export default function activate(orca: OrcaWorkerApi): void {
  try {
    current?.stop()
    current = createRoster(orca, depsOverride ?? realDeps())
  } catch (e) {
    try {
      orca.log(`[agent-roster] failed to start: ${errMsg(e)}`)
    } catch {
      // nothing left to do
    }
  }
}

export async function deactivate(): Promise<void> {
  current?.stop()
  current = null
}
