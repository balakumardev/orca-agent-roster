// The pure part of finding a terminal: exact pane key, the two guarded fallbacks, and the
// redacted description that goes in the log. Invented data only.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describeList, findExact, findFallback, RESOLVE_BACKOFF_MS, splitPaneKey } from '../src/resolve.ts'
import { listTerminals } from '../src/model.ts'
import type { TerminalRecord } from '../src/model.ts'
import { terminal, terminalsOf } from './fixtures.ts'

const rec = (paneKey: string, over: Partial<TerminalRecord> = {}): TerminalRecord => {
  const { tabId, leafId } = splitPaneKey(paneKey)
  return { handle: `h-${paneKey}`, tabId, leafId, worktreeId: 'wa', agentIdentity: 'claude', orphaned: false, ...over }
}
const target = { paneKey: 'tabaaaaaaaa:leafbbbbbbbb', worktreeId: 'wa', agentType: 'claude' }
const none: ReadonlySet<string> = new Set()

test('the backoff is about 250, 500 and 800 ms', () => {
  assert.deepEqual([...RESOLVE_BACKOFF_MS], [250, 500, 800])
})

test('splitPaneKey cuts at the first colon', () => {
  assert.deepEqual(splitPaneKey('t1:l1'), { tabId: 't1', leafId: 'l1' })
  assert.deepEqual(splitPaneKey('t1:l1:x'), { tabId: 't1', leafId: 'l1:x' })
  assert.deepEqual(splitPaneKey('lonely'), { tabId: 'lonely', leafId: '' })
})

test('listTerminals reads the live shape and drops what is not an object with a tab and a leaf', () => {
  const raw = terminalsOf(
    terminal('t1:l1', { handle: 'h1', worktreeId: 'wa', agentIdentity: 'claude' }),
    terminal('t2:l2', { handle: '-flag', orphaned: true }),
    { handle: 'h3' },
    'junk' as unknown as Record<string, unknown>,
    null as unknown as Record<string, unknown>
  )
  const list = listTerminals(raw)
  assert.equal(list.length, 2)
  assert.deepEqual(list[0], { handle: 'h1', tabId: 't1', leafId: 'l1', worktreeId: 'wa', agentIdentity: 'claude', orphaned: false })
  assert.equal(list[1]!.handle, null, 'a handle that could be read as a CLI flag is not a handle')
  assert.equal(list[1]!.orphaned, true)
  assert.deepEqual(listTerminals(undefined), [])
  assert.deepEqual(listTerminals({ terminals: 'x' }), [])
})

test('findExact matches the pane key and ignores orphaned terminals and handle-less ones', () => {
  const key = target.paneKey
  assert.deepEqual(findExact([rec(key)], key), { handle: `h-${key}`, via: 'pane' })
  assert.equal(findExact([rec(key, { orphaned: true })], key), null)
  assert.equal(findExact([rec(key, { handle: null })], key), null)
  assert.equal(findExact([rec('tabaaaaaaaa:other')], key), null)
  const first = rec(key, { handle: 'first' })
  assert.equal(findExact([first, rec(key, { handle: 'second' })], key)!.handle, 'first')
})

test('fallback by agent type needs exactly one unclaimed terminal of that type in that worktree', () => {
  const one = rec('tabx:leafx')
  assert.deepEqual(findFallback([one], target, none), { handle: 'h-tabx:leafx', via: 'agent type' })
  assert.equal(findFallback([one, rec('taby:leafy')], target, none), null, 'two candidates: no guess')
  assert.equal(findFallback([one, rec('taby:leafy', { agentIdentity: 'codex' })], target, none)!.handle, 'h-tabx:leafx', 'another type is not a candidate')
  assert.equal(findFallback([one], { ...target, worktreeId: 'wb' }, none), null)
  assert.equal(findFallback([rec('tabx:leafx', { worktreeId: null })], target, none), null)
  assert.equal(findFallback([rec('tabx:leafx', { orphaned: true })], target, none), null)
  assert.equal(findFallback([rec('tabx:leafx', { handle: null })], target, none), null)
})

test('a terminal claimed by another known agent is never a fallback', () => {
  const stray = rec('tabx:leafx')
  assert.equal(findFallback([stray], target, new Set(['tabx:leafx'])), null)
  // one claimed and one stray: the stray is the single candidate
  assert.equal(findFallback([stray, rec('taby:leafy')], target, new Set(['tabx:leafx']))!.handle, 'h-taby:leafy')
})

test('fallback by tab needs exactly one usable terminal in the same tab', () => {
  const sameTab = rec('tabaaaaaaaa:leafNEW', { agentIdentity: null })
  assert.deepEqual(findFallback([sameTab], target, none), { handle: 'h-tabaaaaaaaa:leafNEW', via: 'tab' })
  assert.equal(findFallback([sameTab, rec('tabaaaaaaaa:leafTWO', { agentIdentity: null })], target, none), null)
  assert.equal(findFallback([sameTab], target, new Set(['tabaaaaaaaa:leafNEW'])), null)
  assert.equal(findFallback([rec('tabaaaaaaaa:leafNEW', { agentIdentity: null, orphaned: true })], target, none), null)
})

test('the type fallback is tried before the tab fallback', () => {
  const byType = rec('tabx:leafx')
  const byTab = rec('tabaaaaaaaa:leafNEW', { agentIdentity: null })
  assert.equal(findFallback([byTab, byType], target, none)!.via, 'agent type')
})

test('two same-type candidates give no type answer, but exactly one in the same tab still does', () => {
  const sameTab = rec('tabaaaaaaaa:leafNEW')
  const elsewhere = rec('tabx:leafx')
  assert.deepEqual(findFallback([sameTab, elsewhere], target, none), { handle: 'h-tabaaaaaaaa:leafNEW', via: 'tab' })
  assert.equal(findFallback([elsewhere, rec('taby:leafy')], target, none), null)
})

test('describeList says what is in the list without a title, a handle or a full id', () => {
  const terms = [rec('tabaaaaaaaa:leafOTHER'), rec('tabq:leafq', { agentIdentity: 'weird id\n' }), rec('tabr:leafr', { agentIdentity: 'codex', orphaned: true }), rec('tabz:leafz', { worktreeId: 'wb' })]
  const d = describeList(terms, target)
  assert.match(d, /^pane tabaaaaa:leafbbbb, tab listed: yes, terminals in worktree: 3 \(1 orphaned\), agent identities: claude, codex, other$/)
  assert.ok(!d.includes('h-'), 'no handle')
  assert.match(describeList([rec('tabz:leafz', { worktreeId: 'wb' })], target), /tab listed: no, terminals in worktree: 0/)
  assert.match(describeList([], target), /agent identities: none/)
  assert.match(describeList(null, target), /terminal list unavailable/)
  const many = Array.from({ length: 12 }, (_, i) => rec(`t${i}:l${i}`, { agentIdentity: `kind${i}` }))
  assert.ok(describeList(many, target).split('agent identities: ')[1]!.split(', ').length <= 7, 'at most six identities and a "more"')
})
