// Agent Roster: the data layer. It runs the Orca CLI and nothing else.
//
// The worker has no ORCA_CLI variable and runs with a fixed environment, so the CLI is found at
// the macOS app's install path first and otherwise as `orca` on the PATH. Tested on macOS only: the
// PATH handling is written for Linux and Windows too, but nothing here has run on either.
// Only `node:` modules are imported, so the live smoke test (test/smoke-live.mjs) runs this exact
// code outside Orca.

import { execFile } from 'node:child_process'
import { constants as fsConstants, promises as fsp } from 'node:fs'
import { delimiter, posix } from 'node:path'

export const ORCA_CLI = '/Applications/Orca.app/Contents/Resources/bin/orca'
/** Tried in this order; the first one that exists and is executable is used. */
export const DEFAULT_BINARIES: readonly string[] = [ORCA_CLI]
/** Used when none of the install paths is executable: whatever `orca` the PATH finds. */
export const FALLBACK_BINARY = 'orca'
export const CLI_TIMEOUT_MS = 12_000
const MAX_BUFFER = 32 * 1024 * 1024

export const PS_ARGS = ['worktree', 'ps', '--json', '--limit', '1000']
export const TERMINAL_LIST_ARGS = ['terminal', 'list', '--json', '--limit', '1000']

export interface CliReply {
  ok: boolean
  result?: unknown
  error?: { code?: string; message?: string }
}

/**
 * Runs one CLI call and resolves with its parsed `--json` reply. Rejects with a plain message. The
 * child is killed when `timeoutMs` passes or `signal` aborts (an aborted call rejects "cancelled").
 */
export type CliRunner = (args: string[], timeoutMs: number, signal?: AbortSignal) => Promise<CliReply>

// Variables that name a target workspace, terminal or remote server would send the CLI somewhere
// the caller did not mean; ELECTRON_RUN_AS_NODE and NODE_OPTIONS would change how the wrapper
// script starts Electron (it sets the first one itself). ORCA_USER_DATA_PATH is deliberately
// kept: the CLI reads it to find the running app.
const DROP_EXACT = new Set([
  'ELECTRON_RUN_AS_NODE',
  'NODE_OPTIONS',
  'ORCA_WORKTREE_ID',
  'ORCA_WORKSPACE_ID',
  'ORCA_WORKSPACE_NAME',
  'ORCA_WORKTREE_PATH',
  'ORCA_TERMINAL_HANDLE',
  'ORCA_PANE_KEY',
  'ORCA_TAB_ID',
  'ORCA_ENVIRONMENT',
  'ORCA_PAIRING_CODE',
  'ORCA_REMOTE_PAIRING',
  'ORCA_CLI_CWD'
])

/**
 * A copy of `base` fit for spawning the CLI: targets dropped, and on POSIX the PATH widened with the
 * system tool directories (the app's wrapper script needs `dirname`, `readlink` and friends, and a
 * worker's PATH can be bare). The PATH separator is the platform's (`path.delimiter`); on Windows
 * the PATH is left alone and its key may be spelled `Path`.
 */
export function scrubbedEnv(base: Record<string, string | undefined>, platform: string = process.platform): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base }
  for (const key of Object.keys(env)) {
    if (DROP_EXACT.has(key) || key.startsWith('ORCA_AGENT_')) delete env[key]
  }
  if (platform === 'win32') return env
  const sep = platform === process.platform ? delimiter : posix.delimiter
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  const have = (env[pathKey] ?? '').split(sep).filter(Boolean)
  const extra = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', '/opt/homebrew/bin', '/usr/local/bin']
  env[pathKey] = Array.from(new Set([...have, ...extra])).join(sep)
  return env
}

async function isExecutable(p: string): Promise<boolean> {
  try {
    await fsp.access(p, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

export interface RunResult {
  stdout: string
  stderr: string
  code: number | string | null
  timedOut: boolean
  /** The caller's abort signal ended the call. */
  aborted?: boolean
}

function run(
  file: string,
  args: string[],
  timeoutMs: number,
  env: Record<string, string | undefined>,
  maxBuffer: number,
  signal?: AbortSignal
): Promise<RunResult> {
  return new Promise((resolve) => {
    try {
      execFile(
        file,
        args,
        { env, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer, encoding: 'utf8', ...(signal ? { signal } : {}) },
        (err, stdout, stderr) => {
          const aborted = Boolean(signal?.aborted) && Boolean(err)
          resolve({
            stdout: String(stdout ?? ''),
            stderr: String(stderr ?? ''),
            code: err ? (err.code ?? 1) : 0,
            // a kill by `timeout` (not by the abort signal) is a timeout
            timedOut: Boolean(err && err.killed) && !aborted,
            aborted
          })
        }
      )
    } catch (e) {
      resolve({ stdout: '', stderr: e instanceof Error ? e.message : String(e), code: 'spawn', timedOut: false })
    }
  })
}

/** Turns a finished process into the parsed reply, or throws a short plain message. */
export function interpretRun(label: string, timeoutMs: number, run: RunResult): CliReply {
  if (run.aborted) throw new Error(`${label} cancelled`)
  if (run.timedOut) throw new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`)
  try {
    const parsed = JSON.parse(run.stdout.trim()) as CliReply
    if (parsed && typeof parsed.ok === 'boolean') return parsed
  } catch {
    // not JSON: report below
  }
  throw new Error(`${label} failed (${run.code}): ${(run.stderr || run.stdout).trim().slice(0, 200)}`)
}

export interface CliOptions {
  /** The process environment; tests pass their own. */
  env?: Record<string, string | undefined>
  /** Install paths to try in order. */
  binaries?: readonly string[]
  /** The name looked up on the PATH when no install path is executable. */
  fallback?: string
  /** Largest stdout or stderr accepted; more fails the call. */
  maxBuffer?: number
}

/** The real runner. Every option has a production default; tests point it at a fake script. */
export function createCli(opts: CliOptions = {}): CliRunner {
  const env = opts.env ?? process.env
  const binaries = opts.binaries ?? DEFAULT_BINARIES
  const fallback = opts.fallback ?? FALLBACK_BINARY
  const maxBuffer = opts.maxBuffer ?? MAX_BUFFER
  return async (args, timeoutMs, signal) => {
    const label = `orca ${args.slice(0, 2).join(' ')}`
    if (signal?.aborted) throw new Error(`${label} cancelled`)
    let bin = fallback
    for (const candidate of binaries) {
      if (await isExecutable(candidate)) {
        bin = candidate
        break
      }
    }
    const result = await run(bin, args, timeoutMs, scrubbedEnv(env), maxBuffer, signal)
    return interpretRun(label, timeoutMs, result)
  }
}

export interface Snapshot {
  ps: unknown
  terminals: unknown
  psMs: number
  terminalsMs: number
}

function replyResult(reply: CliReply, label: string): unknown {
  if (!reply.ok) throw new Error(`${label}: ${reply.error?.code ?? 'error'}: ${reply.error?.message ?? 'unknown'}`)
  return reply.result
}

/** `ps --json` and `terminal list --json` together. Either failing fails the snapshot. */
export async function fetchSnapshot(cli: CliRunner, now: () => number, timeoutMs: number = CLI_TIMEOUT_MS, signal?: AbortSignal): Promise<Snapshot> {
  const timed = async (args: string[]): Promise<{ reply: CliReply; ms: number }> => {
    const t0 = now()
    const reply = await cli(args, timeoutMs, signal)
    return { reply, ms: now() - t0 }
  }
  const [ps, terminals] = await Promise.all([timed(PS_ARGS), timed(TERMINAL_LIST_ARGS)])
  return {
    ps: replyResult(ps.reply, 'orca worktree ps'),
    terminals: replyResult(terminals.reply, 'orca terminal list'),
    psMs: ps.ms,
    terminalsMs: terminals.ms
  }
}

/** One `terminal list --json` call and nothing else: the worker asks for it when a press or click needs a handle. */
export async function fetchTerminals(cli: CliRunner, timeoutMs: number = CLI_TIMEOUT_MS, signal?: AbortSignal): Promise<unknown> {
  return replyResult(await cli(TERMINAL_LIST_ARGS, timeoutMs, signal), 'orca terminal list')
}

/** Switches Orca's window to a terminal tab. Resolves true on success, false with a log reason. */
export async function switchTerminal(
  cli: CliRunner,
  handle: string,
  timeoutMs: number = CLI_TIMEOUT_MS,
  signal?: AbortSignal
): Promise<{ ok: boolean; reason: string }> {
  try {
    const reply = await cli(['terminal', 'switch', '--terminal', handle, '--json'], timeoutMs, signal)
    if (reply.ok) return { ok: true, reason: '' }
    return { ok: false, reason: `${reply.error?.code ?? 'error'}: ${reply.error?.message ?? 'unknown'}` }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}
