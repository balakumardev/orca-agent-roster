import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fetchSnapshot, fetchTerminals, interpretRun, PS_ARGS, scrubbedEnv, switchTerminal, TERMINAL_LIST_ARGS } from '../src/cli.ts'
import * as cliModule from '../src/cli.ts'
import type { CliReply, CliRunner } from '../src/cli.ts'

// ---- environment -----------------------------------------------------------------------------

test('scrubbedEnv drops the variables that name a target or change how the CLI starts', () => {
  const base = {
    HOME: '/home/x',
    PATH: '/custom/bin',
    ELECTRON_RUN_AS_NODE: '1',
    NODE_OPTIONS: '--inspect',
    ORCA_WORKTREE_ID: 'w',
    ORCA_WORKSPACE_ID: 'w',
    ORCA_TERMINAL_HANDLE: 'term_1',
    ORCA_PANE_KEY: 'a:b',
    ORCA_TAB_ID: 'a',
    ORCA_ENVIRONMENT: 'remote',
    ORCA_PAIRING_CODE: 'orca://pair?x',
    ORCA_CLI_CWD: '/somewhere',
    ORCA_AGENT_HOOK_PORT: '1234',
    ORCA_AGENT_HOOK_TOKEN: 'secret',
    ORCA_USER_DATA_PATH: '/data/orca'
  }
  const env = scrubbedEnv(base)
  for (const gone of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ORCA_WORKTREE_ID', 'ORCA_WORKSPACE_ID', 'ORCA_TERMINAL_HANDLE', 'ORCA_PANE_KEY', 'ORCA_TAB_ID', 'ORCA_ENVIRONMENT', 'ORCA_PAIRING_CODE', 'ORCA_CLI_CWD', 'ORCA_AGENT_HOOK_PORT', 'ORCA_AGENT_HOOK_TOKEN']) {
    assert.equal(gone in env, false, `${gone} should be dropped`)
  }
  assert.equal(env.ORCA_USER_DATA_PATH, '/data/orca', 'the CLI needs this to find the running app')
  assert.equal(env.HOME, '/home/x')
  assert.ok(base.ELECTRON_RUN_AS_NODE === '1', 'the input is not mutated')
})

test('scrubbedEnv puts the system tool directories on PATH once, keeping the caller first', () => {
  const env = scrubbedEnv({ PATH: '/custom/bin:/usr/bin' })
  const parts = (env.PATH ?? '').split(':')
  assert.equal(parts[0], '/custom/bin')
  for (const need of ['/usr/bin', '/bin', '/usr/sbin', '/sbin', '/opt/homebrew/bin']) assert.ok(parts.includes(need), need)
  assert.equal(parts.filter((p) => p === '/usr/bin').length, 1)
  assert.ok((scrubbedEnv({}).PATH ?? '').includes('/usr/bin'))
})

// ---- interpreting a finished process ---------------------------------------------------------

const done = (over: Partial<{ stdout: string; stderr: string; code: number | string | null; timedOut: boolean }> = {}) => ({
  stdout: '',
  stderr: '',
  code: 0 as number | string | null,
  timedOut: false,
  ...over
})

test('interpretRun parses the JSON reply, including an ok:false reply', () => {
  assert.deepEqual(interpretRun('orca x y', 1000, done({ stdout: '{"ok":true,"result":{"a":1}}\n' })), { ok: true, result: { a: 1 } })
  assert.equal(interpretRun('orca x y', 1000, done({ stdout: '{"ok":false,"error":{"code":"nope"}}' })).ok, false)
})

test('interpretRun reports a timeout, non-JSON output and a missing binary as plain messages', () => {
  assert.throws(() => interpretRun('orca worktree ps', 12_000, done({ timedOut: true })), /timed out after 12s/)
  assert.throws(() => interpretRun('orca worktree ps', 1000, done({ stdout: 'not json', stderr: 'boom', code: 1 })), /orca worktree ps failed \(1\): boom/)
  assert.throws(() => interpretRun('orca worktree ps', 1000, done({ stdout: '', stderr: 'spawn orca ENOENT', code: 'spawn' })), /ENOENT/)
  assert.throws(() => interpretRun('orca worktree ps', 1000, done({ stdout: '{"ok":"yes"}' })), /failed/)
  const long = 'x'.repeat(5000)
  assert.ok(((): string => { try { interpretRun('l', 1, done({ stdout: long, code: 2 })) } catch (e) { return (e as Error).message } return '' })().length < 300)
})

// ---- the snapshot and the switch -------------------------------------------------------------

function runner(replies: Record<string, CliReply | Error>, seen: string[][] = []): CliRunner {
  return async (args) => {
    seen.push(args)
    const hit = replies[`${args[0]} ${args[1]}`]
    if (hit instanceof Error) throw hit
    if (!hit) throw new Error(`unexpected ${args.join(' ')}`)
    return hit
  }
}

test('fetchSnapshot runs ps and terminal list together with --json and a generous limit', async () => {
  const seen: string[][] = []
  let t = 0
  const snap = await fetchSnapshot(
    runner({ 'worktree ps': { ok: true, result: { worktrees: [] } }, 'terminal list': { ok: true, result: { terminals: [] } } }, seen),
    () => (t += 5)
  )
  assert.deepEqual(seen.map((a) => a.join(' ')).sort(), [PS_ARGS.join(' '), TERMINAL_LIST_ARGS.join(' ')].sort())
  assert.ok(PS_ARGS.includes('--json') && TERMINAL_LIST_ARGS.includes('--json'))
  assert.deepEqual(snap.ps, { worktrees: [] })
  assert.deepEqual(snap.terminals, { terminals: [] })
  assert.ok(snap.psMs > 0 && snap.terminalsMs > 0)
})

test('fetchSnapshot fails when either call fails or says ok:false', async () => {
  const ok = { ok: true, result: {} }
  await assert.rejects(fetchSnapshot(runner({ 'worktree ps': new Error('down'), 'terminal list': ok }), () => 0), /down/)
  await assert.rejects(fetchSnapshot(runner({ 'worktree ps': ok, 'terminal list': new Error('down too') }), () => 0), /down too/)
  await assert.rejects(
    fetchSnapshot(runner({ 'worktree ps': { ok: false, error: { code: 'runtime_unavailable', message: 'start Orca' } }, 'terminal list': ok }), () => 0),
    /runtime_unavailable: start Orca/
  )
})

test('fetchTerminals is one terminal list call: it passes the timeout and the signal on and fails plainly', async () => {
  const seen: string[][] = []
  const calls: Array<{ ms: number; signal: AbortSignal | undefined }> = []
  const ac = new AbortController()
  const cli: CliRunner = async (args, ms, signal) => {
    seen.push(args)
    calls.push({ ms, signal })
    return { ok: true, result: { terminals: [{ handle: 'h' }] } }
  }
  assert.deepEqual(await fetchTerminals(cli, 4321, ac.signal), { terminals: [{ handle: 'h' }] })
  assert.deepEqual(seen, [TERMINAL_LIST_ARGS])
  assert.deepEqual(calls, [{ ms: 4321, signal: ac.signal }])
  await assert.rejects(fetchTerminals(runner({ 'terminal list': new Error('down') }), 1000), /down/)
  await assert.rejects(fetchTerminals(runner({ 'terminal list': { ok: false, error: { code: 'runtime_unavailable', message: 'start Orca' } } }), 1000), /runtime_unavailable: start Orca/)
})

test('switchTerminal sends exactly terminal switch --terminal <handle> and never throws', async () => {
  const seen: string[][] = []
  const ok = await switchTerminal(runner({ 'terminal switch': { ok: true, result: {} } }, seen), 'term_abc')
  assert.deepEqual(ok, { ok: true, reason: '' })
  assert.deepEqual(seen[0], ['terminal', 'switch', '--terminal', 'term_abc', '--json'])
  const refused = await switchTerminal(runner({ 'terminal switch': { ok: false, error: { code: 'gone', message: 'no such terminal' } } }), 'term_abc')
  assert.deepEqual(refused, { ok: false, reason: 'gone: no such terminal' })
  const crashed = await switchTerminal(runner({ 'terminal switch': new Error('spawn failed') }), 'term_abc')
  assert.deepEqual(crashed, { ok: false, reason: 'spawn failed' })
})

// ---- real processes: a fake CLI script written into the temp directory --------------------------------
//
// These start real child processes, but never Orca: every binary here is a tiny shell script the test
// writes itself, and the "missing binary" case points the PATH fallback at a name that cannot exist.
// Every argument list below is made of neutral words on purpose. If a regression ever let one of
// these calls fall through to the real `orca` (an options object read as an environment would do
// it), it can only say "unknown command" and must never be able to run a real one.

const dir = mkdtempSync(join(tmpdir(), 'agent-roster-cli-test-'))
after(() => rmSync(dir, { recursive: true, force: true }))

function script(name: string, body: string, mode = 0o755): string {
  const path = join(dir, name)
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, mode)
  return path
}

const NO_SUCH_BINARY = 'agent-roster-test-no-such-binary'
const baseEnv = { HOME: dir, PATH: '/usr/bin:/bin' }
const runnerFor = (bin: string, extra: Record<string, unknown> = {}): CliRunner =>
  cliModule.createCli({ env: baseEnv, binaries: [bin], fallback: NO_SUCH_BINARY, ...extra } as never)

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
async function until(check: () => boolean, ms = 1500): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (check()) return true
    await new Promise((r) => setTimeout(r, 15))
  }
  return check()
}

test('a real process: JSON on stdout is parsed, the args arrive as given, and target variables never reach it', async () => {
  const bin = script('ok', `printf '{"ok":true,"result":{"argv":"%s","leak":"%s","data":"%s"}}' "$*" "\${ORCA_WORKTREE_ID-unset}" "\${ORCA_USER_DATA_PATH-unset}"`)
  const cli = cliModule.createCli({
    env: { ...baseEnv, ORCA_WORKTREE_ID: 'wt-secret', ORCA_USER_DATA_PATH: '/data/x' },
    binaries: [bin],
    fallback: NO_SUCH_BINARY
  } as never)
  const reply = await cli(['alpha', 'beta', '--json'], 5000)
  assert.deepEqual(reply, { ok: true, result: { argv: 'alpha beta --json', leak: 'unset', data: '/data/x' } })
})

test('a real process: an ok:false reply on stdout comes through even when the exit code is not 0', async () => {
  const bin = script('refuse', `echo '{"ok":false,"error":{"code":"nope","message":"no such terminal"}}'; exit 1`)
  const reply = await runnerFor(bin)(['gamma', 'delta'], 5000)
  assert.equal(reply.ok, false)
  assert.equal(reply.error?.code, 'nope')
})

test('a real process: stdout that is not JSON, and a non-zero exit with only stderr, are plain short errors', async () => {
  await assert.rejects(runnerFor(script('text', 'echo hello there'))(['a', 'b'], 5000), /orca a b failed \(0\): hello there/)
  await assert.rejects(runnerFor(script('boom', 'echo boom >&2; exit 3'))(['a', 'b'], 5000), /orca a b failed \(3\): boom/)
})

test('a real process: output beyond the buffer is an error, not a hang or a giant message', async () => {
  const bin = script('flood', `head -c 20000 /dev/zero | tr '\\000' x`)
  const err = await runnerFor(bin, { maxBuffer: 1024 })(['a', 'b'], 5000).then(
    () => null,
    (e: Error) => e
  )
  assert.ok(err, 'rejected')
  assert.ok(err.message.length < 300, `message was ${err.message.length} characters`)
})

test('a real process: a hung CLI times out and the child is really killed', async () => {
  const pidFile = join(dir, 'hang.pid')
  const bin = script('hang', `echo $$ > "${pidFile}"\nexec sleep 30`)
  await assert.rejects(runnerFor(bin)(['a', 'b'], 500), /timed out after 1s/)
  const pid = Number(readFileSync(pidFile, 'utf8').trim())
  assert.ok(pid > 1)
  assert.equal(await until(() => !alive(pid)), true, 'the hung process is gone')
})

test('a real process: an abort signal cancels the call and kills the child at once', async () => {
  const pidFile = join(dir, 'abort.pid')
  const bin = script('abort', `echo $$ > "${pidFile}"\nexec sleep 30`)
  const stop = new AbortController()
  const started = Date.now()
  const pending = runnerFor(bin)(['a', 'b'], 20_000, stop.signal)
  assert.equal(await until(() => existsSync(pidFile)), true, 'the child started')
  stop.abort()
  await assert.rejects(pending, /cancelled/)
  assert.ok(Date.now() - started < 5000, 'it did not wait for the timeout')
  const pid = Number(readFileSync(pidFile, 'utf8').trim())
  assert.equal(await until(() => !alive(pid)), true, 'the cancelled process is gone')
  // an already-aborted signal never starts anything
  const gone = new AbortController()
  gone.abort()
  await assert.rejects(runnerFor(bin)(['a', 'b'], 20_000, gone.signal), /cancelled/)
})

test('a real process: a missing binary is a clear error', async () => {
  await assert.rejects(runnerFor(join(dir, 'does-not-exist'))(['a', 'b'], 5000), /orca a b failed \(ENOENT\)/)
})

test('binary lookup: the first executable candidate wins, a file without the execute bit is skipped, then the PATH name', async () => {
  const plain = script('plain', `echo '{"ok":true,"result":"plain"}'`, 0o644)
  const good = script('good', `echo '{"ok":true,"result":"good"}'`)
  const cli = cliModule.createCli({ env: baseEnv, binaries: [join(dir, 'missing'), plain, good], fallback: NO_SUCH_BINARY } as never)
  assert.deepEqual(await cli(['a', 'b'], 5000), { ok: true, result: 'good' })
  // the shipped defaults: the macOS app path first, then plain `orca` on the PATH
  assert.deepEqual(cliModule.DEFAULT_BINARIES, ['/Applications/Orca.app/Contents/Resources/bin/orca'])
  assert.equal(cliModule.FALLBACK_BINARY, 'orca')
})

test('scrubbedEnv uses the platform path delimiter, finds a differently cased PATH key, and adds POSIX tool directories only on POSIX', () => {
  const posix = scrubbedEnv({ PATH: '/a:/b' }, 'linux')
  assert.ok((posix.PATH ?? '').startsWith('/a:/b:'))
  const win = scrubbedEnv({ Path: 'C:\\tools;C:\\more' }, 'win32')
  assert.equal(win.Path, 'C:\\tools;C:\\more', 'nothing added, ";" kept as the separator')
  assert.equal('PATH' in win, false)
})
