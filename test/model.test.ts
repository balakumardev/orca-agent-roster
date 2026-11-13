import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildModel,
  cleanTitle,
  DEFAULT_SETTINGS,
  deriveStatus,
  groupByStatus,
  groupByWorktree,
  isGenericTitle,
  normalize,
  orderByActivity,
  orderByProjects,
  pickTitle,
  readSettings,
  STALE_AFTER_MS,
  STATUS_IDS,
  STATUS_LABEL,
  STATUS_RANK,
  statusBarSummary,
  truncate,
  withActiveWorktree
} from '../src/model.ts'
import type { Row, StatusId } from '../src/model.ts'
import { agent, MIN, NOW, psOf, terminal, terminalsOf, verdict, worktree } from './fixtures.ts'

// ---- titles --------------------------------------------------------------------------------

test('cleanTitle strips leading spinner and status glyphs', () => {
  assert.equal(cleanTitle('\u2733 Tune the zebra cache'), 'Tune the zebra cache') // eight-spoked asterisk
  assert.equal(cleanTitle('\u273B Tune the zebra cache'), 'Tune the zebra cache') // teardrop asterisk
  assert.equal(cleanTitle('\u2802 Tune the zebra cache'), 'Tune the zebra cache') // braille spinner
  assert.equal(cleanTitle('\u2810\u2802  Tune the zebra cache'), 'Tune the zebra cache') // two braille cells
  assert.equal(cleanTitle('\u00B7 Tune the zebra cache'), 'Tune the zebra cache') // middle dot
  assert.equal(cleanTitle('* Tune the zebra cache'), 'Tune the zebra cache')
  assert.equal(cleanTitle('\u23FA Tune the zebra cache'), 'Tune the zebra cache')
  assert.equal(cleanTitle('  \u2733\u00A0\u2733 Tune   the\tzebra\ncache  '), 'Tune the zebra cache')
})

test('cleanTitle keeps glyphs that are inside the title and tolerates non-strings', () => {
  assert.equal(cleanTitle('Fix the \u2733 star bug'), 'Fix the \u2733 star bug')
  assert.equal(cleanTitle('..keeps leading dots'), '..keeps leading dots')
  assert.equal(cleanTitle(null), '')
  assert.equal(cleanTitle(42), '')
  assert.equal(cleanTitle(undefined), '')
  assert.equal(cleanTitle('\u2733 '), '')
})

test('cleanTitle removes bidi overrides and zero-width characters a title could hide behind', () => {
  assert.equal(cleanTitle('Fix \u202Egnp.exe\u202C now'), 'Fix gnp.exe now')
  assert.equal(cleanTitle('Re\u200Bname\u2066 it\u2069'), 'Rename it') // invisible characters are deleted, not turned into spaces
})

test('isGenericTitle: product names, empty strings and shell names', () => {
  for (const t of ['', '   ', 'Claude Code', 'claude', 'Codex', 'codex', 'CODEX CLI', 'claude --resume', 'zsh', 'bash', '-zsh', 'fish', 'Terminal', 'Terminal 3']) {
    assert.equal(isGenericTitle(t), true, `"${t}" should be generic`)
  }
})

test('isGenericTitle: truncated path stubs and paths', () => {
  for (const t of ['..lpha/src', '../up/one', '\u2026/deep/dir', '/work/alpha/src', '~/projects/alpha', './src/lib', 'src/app/lib', '~', 'user@host: ~/alpha', 'C:\\work\\alpha']) {
    assert.equal(isGenericTitle(t), true, `"${t}" should be generic`)
  }
})

test('isGenericTitle: a title equal to the worktree or folder name', () => {
  assert.equal(isGenericTitle('alpha-3', ['alpha-3']), true)
  assert.equal(isGenericTitle('Alpha-3', ['alpha-3']), true) // case-insensitive
  assert.equal(isGenericTitle('alpha-repo', ['alpha-3', 'alpha-repo']), true)
  assert.equal(isGenericTitle('alpha-3 cleanup', ['alpha-3']), false)
})

test('isGenericTitle: real titles are not generic', () => {
  for (const t of ['Tune the zebra widget cache', 'Rename quokka module', 'Draft the mango release notes', '/review the diff', 'bash tips for the build']) {
    assert.equal(isGenericTitle(t, ['alpha-3']), false, `"${t}" should be a real title`)
  }
})

test('pickTitle: the terminal title is the real session title', () => {
  const r = pickTitle({ terminalTitle: '\u2733 Tune the zebra cache', conversationName: 'conv', taskTitle: 'task', prompt: 'a long prompt', worktreeName: 'alpha-3', names: ['alpha-3'] })
  assert.deepEqual(r, { title: 'Tune the zebra cache', source: 'terminal' })
})

test('pickTitle: "Claude Code" and a ..path stub fall through to the conversation name', () => {
  for (const terminalTitle of ['\u2733 Claude Code', 'Claude Code', '..lpha/src', 'codex', 'zsh', '', null, undefined]) {
    const r = pickTitle({ terminalTitle, conversationName: 'Draft the mango notes', worktreeName: 'alpha-3', names: ['alpha-3'] })
    assert.deepEqual(r, { title: 'Draft the mango notes', source: 'conversation' }, String(terminalTitle))
  }
})

test('pickTitle: a conversation name equal to the project name falls through to the task title', () => {
  const r = pickTitle({ terminalTitle: 'claude', conversationName: 'alpha-repo', taskTitle: 'Port the parser', worktreeName: 'alpha-3', names: ['alpha-3', 'alpha-repo'] })
  assert.deepEqual(r, { title: 'Port the parser', source: 'task' })
})

test('pickTitle: display name, then the prompt truncated to 60 characters, then the worktree', () => {
  assert.deepEqual(pickTitle({ displayName: 'Shown name', worktreeName: 'w', names: [] }), { title: 'Shown name', source: 'display' })
  const long = 'Please investigate why the nightly zebra export drops every third quokka row and then fix it properly'
  const fromPrompt = pickTitle({ conversationName: null, prompt: long, worktreeName: 'w', names: [] })
  assert.equal(fromPrompt.source, 'prompt')
  assert.equal(Array.from(fromPrompt.title).length, 60)
  assert.ok(fromPrompt.title.endsWith('\u2026'))
  assert.ok(long.startsWith(fromPrompt.title.slice(0, -1)))
  // activity.title is preferred over the raw prompt
  assert.equal(pickTitle({ activityTitle: 'from activity', prompt: 'from prompt', worktreeName: 'w', names: [] }).title, 'from activity')
  assert.deepEqual(pickTitle({ terminalTitle: 'zsh', worktreeName: 'alpha-3', names: ['alpha-3'] }), { title: 'alpha-3', source: 'worktree' })
  assert.deepEqual(pickTitle({ worktreeName: '', names: [] }), { title: 'Agent', source: 'fallback' })
})

test('truncate works on code points and leaves short strings alone', () => {
  assert.equal(truncate('short', 60), 'short')
  assert.equal(truncate('abcdefghij', 5), 'abcd\u2026')
  assert.equal(truncate('\u{1F600}\u{1F600}\u{1F600}\u{1F600}', 3), '\u{1F600}\u{1F600}\u2026')
})

// ---- status derivation ---------------------------------------------------------------------

const fresh = (over: Record<string, unknown>) => ({ updatedAt: NOW - 1000, hasLivePty: true, ...over })

test('deriveStatus: each live state', () => {
  assert.equal(deriveStatus(fresh({ state: 'waiting' }), NOW), 'waiting')
  assert.equal(deriveStatus(fresh({ state: 'blocked' }), NOW), 'blocked')
  assert.equal(deriveStatus(fresh({ state: 'working' }), NOW), 'working')
  assert.equal(deriveStatus(fresh({ state: 'done' }), NOW), 'done')
})

test('deriveStatus: monitoring is working with workingMode monitoring; sub-agents stay plain working', () => {
  assert.equal(deriveStatus(fresh({ state: 'working', workingMode: 'monitoring' }), NOW), 'monitoring')
  assert.equal(deriveStatus(fresh({ state: 'working', workingMode: null }), NOW), 'working')
  assert.equal(deriveStatus(fresh({ state: 'working', subagents: [{ id: 's1', state: 'working' }] }), NOW), 'working')
})

test('deriveStatus: failed for failure and interruption outcomes, even while sub-agents keep the row live', () => {
  assert.equal(deriveStatus(fresh({ state: 'done', mainAgent: { state: 'done', outcome: 'failure' } }), NOW), 'failed')
  assert.equal(deriveStatus(fresh({ state: 'done', mainAgent: { state: 'done', outcome: 'interruption' } }), NOW), 'failed')
  assert.equal(deriveStatus(fresh({ state: 'working', mainAgent: { state: 'done', outcome: 'failure' } }), NOW), 'failed')
})

test('deriveStatus: a live lead has no verdict yet', () => {
  assert.equal(deriveStatus(fresh({ state: 'working', mainAgent: { state: 'working', outcome: 'failure' } }), NOW), 'working')
})

test('deriveStatus: unconfirmed, interrupted and success on a finished turn', () => {
  assert.equal(deriveStatus(fresh({ state: 'done', mainAgent: { state: 'done', outcome: 'unconfirmed' } }), NOW), 'unconfirmed')
  assert.equal(deriveStatus(fresh({ state: 'done', mainAgent: { state: 'done', outcome: 'cancellation' } }), NOW), 'interrupted')
  assert.equal(deriveStatus(fresh({ state: 'done', mainAgent: { state: 'done', outcome: 'superseded' } }), NOW), 'interrupted')
  assert.equal(deriveStatus(fresh({ state: 'done', mainAgent: { state: 'done', outcome: 'success' } }), NOW), 'done')
  // legacy flag on a finished turn means the person pressed Stop
  assert.equal(deriveStatus(fresh({ state: 'done', interrupted: true }), NOW), 'interrupted')
  // cancellation and unconfirmed only apply once the combined state is done
  assert.equal(deriveStatus(fresh({ state: 'working', mainAgent: { state: 'done', outcome: 'cancellation' } }), NOW), 'working')
  assert.equal(deriveStatus(fresh({ state: 'working', interrupted: true }), NOW), 'working')
})

test('deriveStatus: the 30-minute decay boundary', () => {
  assert.equal(STALE_AFTER_MS, 30 * MIN)
  const at = (age: number, over: Record<string, unknown> = {}) => deriveStatus({ state: 'working', hasLivePty: true, updatedAt: NOW - age, ...over }, NOW)
  assert.equal(at(30 * MIN - 1), 'working')
  assert.equal(at(30 * MIN), 'working') // exactly 30 minutes is still fresh
  assert.equal(at(30 * MIN + 1), 'unverifiable') // one millisecond older decays
  assert.equal(at(30 * MIN + 1, { hasLivePty: false }), 'idle')
  assert.equal(at(3 * 60 * MIN), 'unverifiable')
})

test('deriveStatus: decay covers blocked and waiting too, never done, and measures updatedAt', () => {
  const stale = NOW - 31 * MIN
  assert.equal(deriveStatus({ state: 'blocked', hasLivePty: true, updatedAt: stale }, NOW), 'unverifiable')
  assert.equal(deriveStatus({ state: 'waiting', hasLivePty: true, updatedAt: stale }, NOW), 'unverifiable')
  assert.equal(deriveStatus({ state: 'done', hasLivePty: true, updatedAt: stale }, NOW), 'done')
  // stateStartedAt is old but updatedAt is fresh: the row is alive
  assert.equal(deriveStatus({ state: 'working', hasLivePty: true, stateStartedAt: stale, updatedAt: NOW - 100 }, NOW), 'working')
  // no updatedAt at all: nothing to decay by
  assert.equal(deriveStatus({ state: 'working', hasLivePty: true }, NOW), 'working')
})

test('deriveStatus: unknown or malformed input never throws', () => {
  assert.equal(deriveStatus(null, NOW), 'idle')
  assert.equal(deriveStatus('x', NOW), 'idle')
  assert.equal(deriveStatus({ state: 'mystery' }, NOW), 'idle')
  assert.equal(deriveStatus({ state: 'done', mainAgent: { state: 'done', outcome: 'from-the-future' } }, NOW), 'done')
})

test('the rank and label tables cover every status and match Orca', () => {
  assert.deepEqual(
    STATUS_IDS.slice().sort((a, b) => STATUS_RANK[a] - STATUS_RANK[b]),
    ['waiting', 'blocked', 'permission', 'failed', 'unconfirmed', 'working', 'monitoring', 'interrupted', 'unverifiable', 'done', 'idle']
  )
  assert.deepEqual(STATUS_IDS.map((s) => STATUS_RANK[s]), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  for (const id of STATUS_IDS) assert.ok(STATUS_LABEL[id].length > 0)
  assert.equal(STATUS_LABEL.waiting, 'Waiting for input')
  assert.equal(STATUS_LABEL.monitoring, 'Monitoring background tasks')
  assert.equal(STATUS_LABEL.unverifiable, 'No recent update')
  assert.equal(STATUS_LABEL.unconfirmed, "Couldn't confirm")
})

// ---- normalize -----------------------------------------------------------------------------

function row(status: StatusId, over: Partial<Row> = {}): Row {
  return {
    paneKey: `p-${Math.random().toString(36).slice(2)}`,
    handle: 'term_x',
    worktreeId: 'wt-1',
    worktreeName: 'one',
    repo: 'repo',
    branch: 'main',
    agentType: 'claude',
    title: 't',
    titleSource: 'terminal',
    status,
    statusLabel: STATUS_LABEL[status],
    unread: false,
    sortAt: NOW,
    isCurrentWorktree: false,
    hasLivePty: true,
    isChild: false,
    isFolded: false,
    worktreeActivityAt: 0,
    indexInWorktree: 0,
    ...over
  }
}

test('normalize: joins agents to terminals by tabId:leafId and takes the terminal title', () => {
  const a = agent({ paneKey: 'tab-9:leaf-4', activity: verdict(), conversationName: 'conv name' })
  const wt = worktree({ isActive: true }, [a])
  const t = terminal('tab-9:leaf-4', { handle: 'term_abc', title: '\u2802 Draft the mango release notes' })
  const { rows, activeWorktreeId } = normalize(psOf(wt), terminalsOf(t), NOW)
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.handle, 'term_abc')
  assert.equal(rows[0]!.title, 'Draft the mango release notes')
  assert.equal(rows[0]!.titleSource, 'terminal')
  assert.equal(rows[0]!.isCurrentWorktree, true)
  assert.equal(activeWorktreeId, wt.worktreeId)
})

test('normalize: join failure keeps the row but it has no handle and falls back to the conversation name', () => {
  const a = agent({ paneKey: 'tab-1:leaf-1', activity: verdict(), conversationName: 'Port the parser' })
  const unrelated = terminal('tab-2:leaf-2')
  const { rows } = normalize(psOf(worktree({}, [a])), terminalsOf(unrelated), NOW)
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.handle, null)
  assert.equal(rows[0]!.title, 'Port the parser')
  assert.equal(rows[0]!.titleSource, 'conversation')
})

test('normalize: an orphaned terminal gives neither a handle nor a title', () => {
  const a = agent({ paneKey: 'tab-1:leaf-1', activity: verdict() })
  const dead = terminal('tab-1:leaf-1', { orphaned: true, title: 'Stale session title' })
  const { rows } = normalize(psOf(worktree({}, [a])), terminalsOf(dead), NOW)
  assert.equal(rows[0]!.handle, null)
  assert.notEqual(rows[0]!.title, 'Stale session title')
})

test('normalize: an unsafe handle is dropped rather than passed to the CLI', () => {
  const a = agent({ paneKey: 'tab-1:leaf-1', activity: verdict() })
  for (const handle of ['--terminal', '-x', 'a b', '', 7, null]) {
    const { rows } = normalize(psOf(worktree({}, [a])), terminalsOf(terminal('tab-1:leaf-1', { handle })), NOW)
    assert.equal(rows[0]!.handle, null, String(handle))
  }
})

test('normalize: uses the Activity verdict when present, and derives the status when it is missing', () => {
  const withActivity = agent({ state: 'working', activity: verdict({ status: 'waiting', unread: true, sortAt: NOW - 9 * MIN }) })
  const noActivity = agent({ state: 'blocked' })
  const nullActivity = agent({ state: 'done', activity: null })
  const { rows } = normalize(psOf(worktree({}, [withActivity, noActivity, nullActivity])), terminalsOf(), NOW)
  const by = Object.fromEntries(rows.map((r) => [r.paneKey, r]))
  assert.equal(by[withActivity.paneKey as string]!.status, 'waiting') // Orca's verdict beats state
  assert.equal(by[withActivity.paneKey as string]!.unread, true)
  assert.equal(by[withActivity.paneKey as string]!.sortAt, NOW - 9 * MIN)
  assert.equal(by[noActivity.paneKey as string]!.status, 'blocked')
  assert.equal(by[nullActivity.paneKey as string]!.status, 'done')
  assert.equal(by[noActivity.paneKey as string]!.sortAt, NOW - 5 * MIN) // falls back to stateStartedAt
})

test('normalize: skips rows the Activity view does not list', () => {
  const listed = agent({ activity: verdict() })
  const hidden = agent({ activity: { listed: false } })
  const { rows } = normalize(psOf(worktree({}, [listed, hidden])), terminalsOf(), NOW)
  assert.deepEqual(rows.map((r) => r.paneKey), [listed.paneKey])
})

test('normalize: flags child agents (childOf, foldedChild, parentPaneKey)', () => {
  const parent = agent({ activity: verdict() })
  const byChildOf = agent({ activity: verdict({ childOf: parent.paneKey }) })
  const byFolded = agent({ activity: verdict({ foldedChild: true }) })
  const byParentKey = agent({ activity: null, parentPaneKey: parent.paneKey })
  const { rows } = normalize(psOf(worktree({}, [parent, byChildOf, byFolded, byParentKey])), terminalsOf(), NOW)
  const child = (a: Record<string, unknown>) => rows.find((r) => r.paneKey === a.paneKey)!.isChild
  const folded = (a: Record<string, unknown>) => rows.find((r) => r.paneKey === a.paneKey)!.isFolded
  assert.equal(child(parent), false)
  assert.equal(child(byChildOf), true)
  assert.equal(child(byFolded), true)
  assert.equal(child(byParentKey), true)
  // only Orca's own fold verdict hides a row
  assert.deepEqual([parent, byChildOf, byFolded, byParentKey].map(folded), [false, false, true, false])
})

test('buildModel hides folded child rows unless showChildAgents is on', () => {
  const parent = agent({ activity: verdict() })
  const kid = agent({ activity: verdict({ status: 'done', childOf: parent.paneKey, foldedChild: true }) })
  const n = normalize(psOf(worktree({}, [parent, kid])), terminalsOf(), NOW)
  assert.equal(buildModel(n, DEFAULT_SETTINGS, null, null).rows.length, 1)
  const shown = buildModel(n, { ...DEFAULT_SETTINGS, showChildAgents: true }, null, null)
  assert.equal(shown.rows.length, 2)
  assert.equal(shown.groups.status.reduce((sum, g) => sum + g.paneKeys.length, 0), 2)
})

test('normalize: archived worktrees keep only their live rows', () => {
  const live = agent({ hasLivePty: true, activity: verdict() })
  const dead = agent({ hasLivePty: false, activity: verdict({ status: 'done' }) })
  const { rows, activeWorktreeId } = normalize(psOf(worktree({ isArchived: true, isActive: true }, [live, dead])), terminalsOf(), NOW)
  assert.deepEqual(rows.map((r) => r.paneKey), [live.paneKey])
  assert.equal(activeWorktreeId, null) // an archived worktree is never the active one
})

test('normalize: every optional field missing, and garbage input, never throws', () => {
  const bare = { paneKey: 'tab-1:leaf-1' } // no state, no activity, no subagents, no mainAgent, no workingMode
  const { rows } = normalize(psOf(worktree({ displayName: undefined, path: undefined, repo: undefined, branch: undefined, sortOrder: undefined }, [bare as never])), terminalsOf(), NOW)
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.status, 'idle')
  assert.equal(rows[0]!.agentType, 'agent')
  for (const junk of [null, undefined, 'x', 7, [], {}, { worktrees: 'no' }, { worktrees: [null, 1, 'a', {}, { agents: 'no' }, { agents: [null, 3, {}] }] }]) {
    assert.deepEqual(normalize(junk, junk, NOW).rows, [])
  }
  assert.equal(normalize(psOf(worktree({}, [agent()])), null, NOW).rows.length, 1) // no terminals at all
})

test('normalize: strips refs/heads/, keeps the worktree activity stamp and de-duplicates pane keys', () => {
  const a1 = agent({ paneKey: 'tab-1:leaf-1', activity: verdict() })
  const dup = agent({ paneKey: 'tab-1:leaf-1', activity: verdict() })
  const a2 = agent({ paneKey: 'tab-2:leaf-1', activity: verdict() })
  const { rows } = normalize(psOf(worktree({ branch: 'refs/heads/feature/x', lastActivityAt: 77 }, [a1, dup, a2])), terminalsOf(), NOW)
  assert.equal(rows.length, 2)
  assert.equal(rows[0]!.branch, 'feature/x')
  assert.equal(rows[0]!.worktreeActivityAt, 77)
  assert.deepEqual(rows.map((r) => r.indexInWorktree).sort(), [0, 2]) // positions as ps listed them
})

test('withActiveWorktree marks one worktree active on its rows', () => {
  const a = agent({ activity: verdict() })
  const b = agent({ activity: verdict() })
  const w1 = worktree({ worktreeId: 'w1', isActive: true }, [a])
  const w2 = worktree({ worktreeId: 'w2' }, [b])
  const n = withActiveWorktree(normalize(psOf(w1, w2), terminalsOf(), NOW), 'w2')
  assert.equal(n.activeWorktreeId, 'w2')
  assert.deepEqual(n.rows.map((r) => [r.worktreeId, r.isCurrentWorktree]).sort(), [['w1', false], ['w2', true]])
})

// ---- ordering and grouping -----------------------------------------------------------------

test('orderByActivity: status rank first, then sortAt newest first, then pane key', () => {
  const rows = [
    row('done', { paneKey: 'a', sortAt: 300 }),
    row('working', { paneKey: 'b', sortAt: 100 }),
    row('working', { paneKey: 'c', sortAt: 200 }),
    row('waiting', { paneKey: 'd', sortAt: 1 }),
    row('working', { paneKey: 'e', sortAt: 200 })
  ]
  assert.deepEqual(orderByActivity(rows).map((r) => r.paneKey), ['d', 'c', 'e', 'b', 'a'])
})

test('groupByStatus: one group per status in rank order, label and rows inside', () => {
  const rows = [
    row('done', { paneKey: 'a' }),
    row('waiting', { paneKey: 'b' }),
    row('working', { paneKey: 'c', sortAt: 5 }),
    row('working', { paneKey: 'd', sortAt: 9 }),
    row('monitoring', { paneKey: 'e' })
  ]
  const groups = groupByStatus(rows)
  assert.deepEqual(groups.map((g) => [g.label, g.paneKeys]), [
    ['Waiting for input', ['b']],
    ['Working', ['d', 'c']],
    ['Monitoring background tasks', ['e']],
    ['Done', ['a']]
  ])
  assert.deepEqual(groups.map((g) => g.status), ['waiting', 'working', 'monitoring', 'done'])
})

test('groupByWorktree: every agent is listed under its worktree, the most recently active worktree first', () => {
  const rows = [
    row('done', { paneKey: 'a', worktreeId: 'w2', worktreeName: 'second', worktreeActivityAt: 10, indexInWorktree: 0 }),
    row('working', { paneKey: 'b', worktreeId: 'w1', worktreeName: 'first', worktreeActivityAt: 20, indexInWorktree: 1, isCurrentWorktree: true, repo: 'r', branch: 'main' }),
    row('waiting', { paneKey: 'c', worktreeId: 'w1', worktreeName: 'first', worktreeActivityAt: 20, indexInWorktree: 0, isCurrentWorktree: true, repo: 'r', branch: 'main' })
  ]
  const groups = groupByWorktree(rows)
  assert.deepEqual(groups.map((g) => [g.label, g.paneKeys, g.isActive]), [
    ['first', ['c', 'b'], true],
    ['second', ['a'], false]
  ])
  assert.equal(groups[0]!.subtitle, 'r / main')
  assert.equal(groups[0]!.kind, 'worktree')
})

test('buildModel: cursor only when that row exists, both groupings present, no clock-dependent fields', () => {
  const a = agent({ paneKey: 'tab-1:leaf-1', activity: verdict() })
  const n = normalize(psOf(worktree({}, [a])), terminalsOf(), NOW)
  const m = buildModel(n, DEFAULT_SETTINGS, 'tab-1:leaf-1', null)
  assert.equal(m.cursor, 'tab-1:leaf-1')
  assert.equal(buildModel(n, DEFAULT_SETTINGS, 'gone', null).cursor, null)
  assert.equal(m.groups.status.length, 1)
  assert.equal(m.groups.worktree.length, 1)
  assert.equal(m.error, null)
  assert.equal(buildModel(n, DEFAULT_SETTINGS, null, { message: 'down', detail: 'why' }).error, 'down')
  // same input twice gives byte-identical JSON, so "post only when changed" holds
  assert.equal(JSON.stringify(buildModel(n, DEFAULT_SETTINGS, null, null)), JSON.stringify(buildModel(n, DEFAULT_SETTINGS, null, null)))
})

test('readSettings validates every key and falls back to the defaults', () => {
  assert.deepEqual(readSettings(undefined), DEFAULT_SETTINGS)
  assert.deepEqual(readSettings({ groupBy: 'worktree', cycleOrder: 'projects', skipFinished: true, showChildAgents: true }), {
    groupBy: 'worktree',
    cycleOrder: 'projects',
    skipFinished: true,
    showChildAgents: true
  })
  assert.deepEqual(readSettings({ groupBy: 'nope', cycleOrder: 5, skipFinished: 'yes', showChildAgents: null }), DEFAULT_SETTINGS)
})

// ---- status bar ----------------------------------------------------------------------------

test('statusBarSummary: hidden with no agents', () => {
  assert.equal(statusBarSummary([]).visible, false)
})

test('statusBarSummary: counts, order and tone', () => {
  const s = statusBarSummary([row('working'), row('monitoring'), row('waiting'), row('done')])
  assert.equal(s.visible, true)
  assert.equal(s.text, '2 working \u00B7 1 waiting')
  assert.equal(s.tone, 'warning')
  const quiet = statusBarSummary([row('working'), row('working'), row('done')])
  assert.equal(quiet.text, '2 working')
  assert.equal(quiet.tone, 'neutral')
  assert.equal(statusBarSummary([row('blocked')]).tone, 'warning')
  assert.equal(statusBarSummary([row('blocked'), row('permission')]).text, '1 waiting \u00B7 1 blocked')
  assert.equal(statusBarSummary([row('done'), row('idle')]).text, '2 agents')
  assert.equal(statusBarSummary([row('done')]).text, '1 agent')
})

// ---- review fixes: titles, children, decay, worktree order ----------------------------------

test('pickTitle: activity.title and the prompt go through the same clean and generic checks as every other source', () => {
  // The brief's case: the terminal and Orca's own title both say "Claude Code", the prompt is the only real text.
  const r = pickTitle({ terminalTitle: '✳ Claude Code', activityTitle: '✳ Claude Code', prompt: 'Fix the login bug', worktreeName: 'alpha-3', names: ['alpha-3'] })
  assert.deepEqual(r, { title: 'Fix the login bug', source: 'prompt' })
  // generic activity titles (a shell name, a path, the worktree's own name) are skipped, not shown
  for (const activityTitle of ['zsh', 'Terminal 2', '~/projects/alpha', 'src/app/lib', 'alpha-3', '⠂ codex']) {
    assert.equal(pickTitle({ activityTitle, prompt: 'Fix the login bug', worktreeName: 'alpha-3', names: ['alpha-3'] }).title, 'Fix the login bug', activityTitle)
  }
  // a real activity title is cleaned like the others
  assert.deepEqual(pickTitle({ activityTitle: '✳ Tune the zebra cache', prompt: 'p', worktreeName: 'w', names: [] }), { title: 'Tune the zebra cache', source: 'prompt' })
  // the prompt itself is cleaned: control characters, bidi marks and a leading glyph are gone
  assert.equal(pickTitle({ prompt: '✳ Fix\u0007 the‮ bug\n', worktreeName: 'w', names: [] }).title, 'Fix the bug')
  // a generic-only prompt falls through to the worktree name
  assert.deepEqual(pickTitle({ activityTitle: 'claude', prompt: 'zsh', worktreeName: 'alpha-3', names: ['alpha-3'] }), { title: 'alpha-3', source: 'worktree' })
})

test('normalize: a row whose terminal and Activity titles are both generic shows the prompt, end to end', () => {
  const a = agent({ paneKey: 'tab-1:leaf-1', prompt: 'Fix the login bug', activity: verdict({ title: '✳ Claude Code' }) })
  const { rows } = normalize(psOf(worktree({}, [a])), terminalsOf(terminal('tab-1:leaf-1', { title: '✳ Claude Code' })), NOW)
  assert.equal(rows[0]!.title, 'Fix the login bug')
  assert.equal(rows[0]!.titleSource, 'prompt')
})

test('a live child agent stays visible; only a child Orca folds away is hidden (showChildAgents shows those too)', () => {
  const parent = agent({ paneKey: 'tab-p:leaf-p', activity: verdict() })
  const live = agent({ paneKey: 'tab-l:leaf-l', activity: verdict({ status: 'working', childOf: 'tab-p:leaf-p' }) })
  const folded = agent({ paneKey: 'tab-f:leaf-f', activity: verdict({ status: 'done', childOf: 'tab-p:leaf-p', foldedChild: true }) })
  const n = normalize(psOf(worktree({}, [parent, live, folded])), terminalsOf(), NOW)
  const shown = (settings = DEFAULT_SETTINGS) => buildModel(n, settings, null, null).rows.map((r) => r.paneKey).sort()
  assert.deepEqual(shown(), ['tab-l:leaf-l', 'tab-p:leaf-p'], 'the working sub-agent is not hidden')
  assert.deepEqual(shown({ ...DEFAULT_SETTINGS, showChildAgents: true }), ['tab-f:leaf-f', 'tab-l:leaf-l', 'tab-p:leaf-p'])
  // the status bar and groups count what is visible
  assert.equal(buildModel(n, DEFAULT_SETTINGS, null, null).groups.status.reduce((sum, g) => sum + g.paneKeys.length, 0), 2)
})

test('keeps ZWNJ and ZWJ (emoji sequences and Persian text must survive) and strips the other invisible characters', () => {
  assert.equal(cleanTitle('\u{1F468}‍\u{1F4BB} pairing'), '\u{1F468}‍\u{1F4BB} pairing')
  assert.equal(cleanTitle('می‌خواهم تست'), 'می‌خواهم تست')
  // soft hyphen, ALM, zero-width space, Mongolian vowel separator, word joiner, BOM, LRM/RLM
  for (const hidden of ['­', '؜', '​', '᠎', '⁠', '﻿', '‎', '‏']) {
    assert.equal(cleanTitle(`Re${hidden}name`), 'Rename', `U+${hidden.codePointAt(0)!.toString(16).toUpperCase()} is removed, not turned into a space`)
  }
  // controls (C0, DEL, C1) separate words; every bidi override and isolate is dropped
  assert.equal(cleanTitle('one\u0007two\u0085three\u007Ffour'), 'one two three four')
  assert.equal(cleanTitle('a‪b‫c‬d‭e‮f⁦g⁧h⁨i⁩j'), 'abcdefghij')
  // the same cleaning applies to every title source
  const r = pickTitle({ terminalTitle: '', conversationName: 'Port​ the‮ parser', worktreeName: 'w', names: [] })
  assert.equal(r.title, 'Port the parser')
})

test('truncate cuts by grapheme: an emoji sequence, a flag or a combining mark is never split', () => {
  const family = '\u{1F468}‍\u{1F4BB}'
  assert.equal(truncate(family.repeat(5), 3), `${family}${family}…`)
  assert.equal(truncate('\u{1F1EE}\u{1F1F3}\u{1F1EF}\u{1F1F5}\u{1F1EB}\u{1F1F7}\u{1F1E9}\u{1F1EA}', 3), '\u{1F1EE}\u{1F1F3}\u{1F1EF}\u{1F1F5}…')
  assert.equal(truncate('éééé', 3), 'éé…')
  assert.equal(truncate('x'.repeat(118) + family + 'tail', 120), 'x'.repeat(118) + family + '…')
  // a title of exactly the maximum is untouched, and short strings are returned as they came
  assert.equal(truncate(family.repeat(3), 3), family.repeat(3))
  // the 60-character prompt limit counts graphemes too
  const prompt = 'x'.repeat(58) + family + family + 'tail'
  const picked = pickTitle({ prompt, worktreeName: 'w', names: [] }).title
  assert.equal(picked, 'x'.repeat(58) + family + '…')
})

test('the fallback status does not decay a row owned by the structured host (Orca exempts it)', () => {
  const stale = NOW - 3 * 60 * MIN
  for (const state of ['working', 'blocked', 'waiting']) {
    assert.equal(deriveStatus({ state, hasLivePty: true, updatedAt: stale, structuredHostOwned: true }, NOW), state, state)
    assert.equal(deriveStatus({ state, hasLivePty: false, updatedAt: stale, structuredHostOwned: true }, NOW), state, `${state} without a pty`)
  }
  // only a literal `true` exempts; anything else decays as before
  for (const owned of [false, 'true', 1, null, undefined]) {
    assert.equal(deriveStatus({ state: 'working', hasLivePty: true, updatedAt: stale, structuredHostOwned: owned }, NOW), 'unverifiable', String(owned))
  }
})

test('projects order mirrors the sidebar default: most recently active worktree first, then name, then agent order', () => {
  const mk = (id: string, name: string, lastActivityAt: number | undefined, sortOrder: number) =>
    worktree({ worktreeId: id, displayName: name, lastActivityAt, sortOrder }, [agent({ paneKey: `tab-${id}:leaf-${id}`, activity: verdict() })])
  const n = normalize(
    psOf(
      mk('w-old', 'old', NOW - 60 * MIN, 1), // saved sortOrder says first, the sidebar says third
      mk('w-new', 'new', NOW - MIN, 2),
      mk('w-none', 'none', undefined, 3),
      mk('w-b10', 'wt10', NOW - 10 * MIN, 4),
      mk('w-b2', 'wt2', NOW - 10 * MIN, 5) // same activity as wt10: natural name order puts wt2 first
    ),
    terminalsOf(),
    NOW
  )
  assert.deepEqual(orderByProjects(n.rows).map((r) => r.worktreeId), ['w-new', 'w-b2', 'w-b10', 'w-old', 'w-none'])
  assert.deepEqual(groupByWorktree(n.rows).map((g) => g.worktreeId), ['w-new', 'w-b2', 'w-b10', 'w-old', 'w-none'])
})
