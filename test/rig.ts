// A fake Orca worker host and a fake CLI, so the worker runs end to end in plain Node.

import type { OrcaWorkerApi } from 'orca/worker'
import type { CliReply, CliRunner } from '../src/cli.ts'
import type { Deps } from '../src/worker.ts'
import { fakeClock } from './clock.ts'
import type { Timers } from '../src/poller.ts'
import { NOW, agent, psOf, terminal, terminalsOf, verdict, worktree } from './fixtures.ts'

type Obj = Record<string, unknown>

export const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise<void>((r) => setImmediate(r))
}

export interface World {
  /** What `worktree ps` answers; replace it to change the roster. */
  ps: Obj
  terminals: Obj
  /** Every CLI call, in order. */
  calls: string[][]
  /** Handles `terminal switch` was asked for and accepted. */
  switched: string[]
  failSwitch: Set<string>
  failRead: boolean
  /** Call kinds (`ps`, `list`, `switch`) that never answer: they fail only when their timeout or abort signal fires. */
  hung: Set<string>
  /** While true every `worktree ps` waits in `held` until a test releases it. */
  holdPs: boolean
  held: Array<() => void>
  /** The `timeoutMs` each `terminal switch` was started with. */
  switchTimeouts: number[]
  /** How many `terminal switch` calls were cancelled through their abort signal. */
  cancelled: number
  /** How many `terminal list` calls started, counting the one in flight. */
  listCalls: number
  /** Runs at the start of every `terminal list` with its 1-based number, before the answer is read: a test changes `terminals` here. */
  onList?: (n: number) => void
  /** Each `terminal list` answers only after this long on the fake clock (needs the fake timers). */
  listDelayMs: number
  /** Every CLI call's kind, start time and timeout: tests check none of them could outlive a deadline. */
  timing: Array<{ kind: 'ps' | 'list' | 'switch'; at: number; timeoutMs: number }>
}

export function fakeCli(world: World, timers?: Timers, now: () => number = () => 0): CliRunner {
  /** A call that never answers: it ends only by its own timeout or by an abort, as a real hung process does. */
  const hang = (label: string, timeoutMs: number, signal: AbortSignal | undefined, onCancel?: () => void): Promise<never> =>
    new Promise((_, reject) => {
      if (!timers) return
      const handle = timers.setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs)
      signal?.addEventListener(
        'abort',
        () => {
          timers.clearTimeout(handle)
          onCancel?.()
          reject(new Error(`${label} cancelled`))
        },
        { once: true }
      )
    })
  /** A call that answers after `ms` on the fake clock, unless its own timeout or an abort ends it first. */
  const slow = (label: string, ms: number, timeoutMs: number, signal: AbortSignal | undefined): Promise<void> =>
    new Promise((resolve, reject) => {
      if (!timers) return resolve()
      let done = false
      const finish = (fn: () => void) => {
        if (done) return
        done = true
        timers.clearTimeout(answer)
        timers.clearTimeout(limit)
        fn()
      }
      const answer = timers.setTimeout(() => finish(resolve), ms)
      const limit = timers.setTimeout(() => finish(() => reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`))), timeoutMs)
      signal?.addEventListener('abort', () => finish(() => reject(new Error(`${label} cancelled`))), { once: true })
    })
  return async (args, timeoutMs, signal): Promise<CliReply> => {
    world.calls.push(args)
    const [a, b] = args
    const kind = a === 'worktree' ? 'ps' : b === 'list' ? 'list' : 'switch'
    world.timing.push({ kind, at: now(), timeoutMs })
    if (a === 'worktree' && b === 'ps') {
      if (world.hung.has('ps')) return hang('orca worktree ps', timeoutMs, signal)
      if (world.holdPs) await new Promise<void>((release) => world.held.push(release))
      if (world.failRead) throw new Error('orca worktree ps failed (1): not running')
      return { ok: true, result: world.ps }
    }
    if (a === 'terminal' && b === 'list') {
      const n = ++world.listCalls
      world.onList?.(n)
      if (world.hung.has('list')) return hang('orca terminal list', timeoutMs, signal)
      if (world.listDelayMs > 0) await slow('orca terminal list', world.listDelayMs, timeoutMs, signal)
      if (world.failRead) throw new Error('orca terminal list failed (1): not running')
      return { ok: true, result: world.terminals }
    }
    if (a === 'terminal' && b === 'switch') {
      world.switchTimeouts.push(timeoutMs)
      if (world.hung.has('switch')) return hang('orca terminal switch', timeoutMs, signal, () => void world.cancelled++)
      const handle = args[args.indexOf('--terminal') + 1] ?? ''
      if (world.failSwitch.has(handle)) return { ok: false, error: { code: 'terminal_not_found', message: 'gone' } }
      world.switched.push(handle)
      return { ok: true, result: {} }
    }
    throw new Error(`unexpected CLI call: ${args.join(' ')}`)
  }
}

export interface FakeOrca {
  orca: OrcaWorkerApi
  logs: string[]
  posts: Array<{ event: string; payload: unknown }>
  hostCalls: Array<{ method: string; params: Obj }>
  settingsStore: Record<string, unknown>
  settingsWrites: Array<[string, unknown]>
  commands: Map<string, (args?: unknown, ctx?: { signal: AbortSignal }) => unknown>
  handlers: Map<string, (input: unknown, ctx?: { signal: AbortSignal }) => unknown>
  /** Top-level members of the `orca` object the worker read. */
  touched: Set<string>
  eventNames: () => string[]
  emit(event: string, payload?: unknown): void
  changeSetting(key: string, value: unknown): void
  disposed: number
}

export function fakeOrca(opts: { settings?: Obj; hasStatusBar?: boolean; failEventsOn?: boolean; failPosts?: number } = {}): FakeOrca {
  const logs: string[] = []
  const posts: FakeOrca['posts'] = []
  const hostCalls: FakeOrca['hostCalls'] = []
  const commands = new Map<string, (args?: unknown, ctx?: { signal: AbortSignal }) => unknown>()
  const handlers = new Map<string, (input: unknown, ctx?: { signal: AbortSignal }) => unknown>()
  const touched = new Set<string>()
  let postsToFail = opts.failPosts ?? 0
  const listeners = new Map<string, Array<(p: unknown) => void>>()
  const settingsListeners: Array<(c: { key: string }) => void> = []
  const settingsStore: Record<string, unknown> = { groupBy: 'status', cycleOrder: 'activity', skipFinished: false, showChildAgents: false, ...opts.settings }
  const settingsWrites: Array<[string, unknown]> = []
  const f = { disposed: 0 }
  const disposable = (undo: () => void) => ({
    dispose() {
      f.disposed++
      undo()
    }
  })
  const orca = {
    api: { major: 1, minor: 6 },
    log: (m: string) => void logs.push(m),
    commands: {
      register(id: string, fn: (args?: unknown, ctx?: { signal: AbortSignal }) => unknown) {
        commands.set(id, fn)
        return disposable(() => commands.delete(id))
      }
    },
    events: {
      on(event: string, fn: (p: unknown) => void) {
        if (opts.failEventsOn) throw new Error('events unavailable')
        listeners.set(event, [...(listeners.get(event) ?? []), fn])
        return disposable(() => listeners.set(event, (listeners.get(event) ?? []).filter((x) => x !== fn)))
      }
    },
    hooks: { on: () => disposable(() => {}) },
    panels: {
      handle(name: string, fn: (input: unknown, ctx?: { signal: AbortSignal }) => unknown) {
        handlers.set(name, fn)
        return disposable(() => handlers.delete(name))
      },
      post(event: string, payload: unknown) {
        if (postsToFail > 0) {
          postsToFail--
          throw new Error('panel post refused')
        }
        posts.push({ event, payload: JSON.parse(JSON.stringify(payload)) })
      }
    },
    host: {
      has: (m: string) => (opts.hasStatusBar ?? true) && m === 'statusBar.update',
      call: async (method: string, params: Obj) => {
        hostCalls.push({ method, params })
        return { ok: true }
      }
    },
    settings: {
      get: async (key?: string) => (key === undefined ? { ...settingsStore } : settingsStore[key]),
      set: async (key: string, value: unknown) => {
        settingsWrites.push([key, value])
        settingsStore[key] = value
        for (const l of settingsListeners.slice()) l({ key })
      },
      onDidChange(l: (c: { key: string }) => void) {
        settingsListeners.push(l)
        return disposable(() => void settingsListeners.splice(settingsListeners.indexOf(l), 1))
      }
    },
    storage: {},
    secrets: {},
    grantedCapabilities: ['agent:read', 'workspace:read', 'settings:own']
  }
  const watched = new Proxy(orca, {
    get(target, prop, receiver) {
      if (typeof prop === 'string') touched.add(prop)
      return Reflect.get(target, prop, receiver)
    }
  })
  return {
    orca: watched as unknown as OrcaWorkerApi,
    touched,
    logs,
    posts,
    hostCalls,
    settingsStore,
    settingsWrites,
    commands,
    handlers,
    eventNames: () => Array.from(listeners.keys()),
    emit(event, payload) {
      for (const l of listeners.get(event) ?? []) l(payload)
    },
    changeSetting(key, value) {
      settingsStore[key] = value
      for (const l of settingsListeners.slice()) l({ key })
    },
    get disposed() {
      return f.disposed
    }
  } as FakeOrca
}

export interface Rig {
  clock: ReturnType<typeof fakeClock>
  world: World
  deps: Deps
  fake: FakeOrca
}

export function newWorld(ps: Obj = psOf(), terminals: Obj = terminalsOf()): World {
  return {
    ps,
    terminals,
    calls: [],
    switched: [],
    failSwitch: new Set(),
    failRead: false,
    hung: new Set(),
    holdPs: false,
    held: [],
    switchTimeouts: [],
    cancelled: 0,
    listCalls: 0,
    listDelayMs: 0,
    timing: []
  }
}

export function newRig(opts: { world?: World; fake?: FakeOrca } = {}): Rig {
  const clock = fakeClock(NOW)
  const world = opts.world ?? newWorld()
  const deps: Deps = { cli: fakeCli(world, clock.timers, clock.now), now: clock.now, ...clock.timers }
  return { clock, world, deps, fake: opts.fake ?? fakeOrca() }
}

/**
 * Awaits `work` while moving the fake clock in small steps, so waits the code under test makes on
 * its timers (a retry backoff) elapse. The clock moves only while `work` is still pending, and the
 * cap turns a hang into a failure instead of a stuck run.
 */
export async function drive<T>(rig: { clock: { tick(ms: number): void } }, work: Promise<T>, stepMs = 50, maxSteps = 1200): Promise<T> {
  let finished = false
  void work.then(
    () => void (finished = true),
    () => void (finished = true)
  )
  for (let i = 0; i < maxSteps; i++) {
    await settle()
    if (finished) break
    rig.clock.tick(stepMs)
  }
  await settle()
  if (!finished) throw new Error('drive: the work did not finish within the fake-clock cap')
  return work
}

/**
 * Three worktrees. wa (sortOrder 1) holds a1 waiting and a2 working; wb holds b1 done; wc holds c1
 * working with no terminal. Handles are `h-<paneKey>`.
 */
export function sampleWorld(): World {
  const mk = (paneKey: string, status: string, sortAgo: number, title: string, withTerminal = true) => ({
    a: agent({ paneKey, activity: verdict({ status, sortAt: NOW - sortAgo }), state: status === 'waiting' ? 'waiting' : status === 'done' ? 'done' : 'working' }),
    t: withTerminal ? terminal(paneKey, { handle: `h-${paneKey}`, title }) : null
  })
  const a1 = mk('ta1:l', 'waiting', 4 * 60_000, '✳ Untangle the walrus scheduler')
  const a2 = mk('ta2:l', 'working', 2 * 60_000, '⠂ Rename quokka module')
  const b1 = mk('tb1:l', 'done', 9 * 60_000, 'Draft the mango release notes')
  const c1 = mk('tc1:l', 'working', 1 * 60_000, '', false)
  const wa = worktree({ worktreeId: 'wa', displayName: 'alpha', sortOrder: 1, isActive: true }, [a1.a, a2.a])
  const wb = worktree({ worktreeId: 'wb', displayName: 'beta', sortOrder: 2 }, [b1.a])
  const wc = worktree({ worktreeId: 'wc', displayName: 'gamma', sortOrder: 3 }, [c1.a])
  const terminals = [a1.t, a2.t, b1.t].filter((t): t is NonNullable<typeof t> => t !== null)
  return newWorld(psOf(wa, wb, wc), terminalsOf(...terminals))
}
