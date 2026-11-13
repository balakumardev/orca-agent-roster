import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { buildModel, DEFAULT_SETTINGS, normalize, STATUS_IDS } from '../src/model.ts'
import type { RosterModel } from '../src/model.ts'
import { fakeClock } from './clock.ts'
import { openPanel } from './fake-dom.ts'
import type { Page } from './fake-dom.ts'
import { agent, MIN, NOW, psOf, terminal, terminalsOf, verdict, worktree } from './fixtures.ts'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const read = (rel: string) => readFileSync(join(root, rel), 'utf8')

interface PanelExports {
  timeText(sortAt: unknown, now: number): string
  TONES: Record<string, string>
  ICONS: Record<string, string>
}

// panel.js is a classic browser script; with a `module` object in scope it exports its helpers.
function loadPanel(): PanelExports {
  const module = { exports: {} as unknown }
  runInNewContext(read('panel/panel.js'), { module }, { filename: 'panel.js' })
  return module.exports as PanelExports
}

test('timeText: now, Nm, Nh, Nd, floored, with no "ago"', () => {
  const { timeText } = loadPanel()
  const now = 1_700_000_000_000
  assert.equal(timeText(now, now), 'now')
  assert.equal(timeText(now - 59_999, now), 'now')
  assert.equal(timeText(now - MIN, now), '1m')
  assert.equal(timeText(now - 59 * MIN - 59_000, now), '59m')
  assert.equal(timeText(now - 60 * MIN, now), '1h')
  assert.equal(timeText(now - 23 * 60 * MIN - 59 * MIN, now), '23h')
  assert.equal(timeText(now - 24 * 60 * MIN, now), '1d')
  assert.equal(timeText(now - 5 * 24 * 60 * MIN, now), '5d')
  assert.equal(timeText(now + 5 * MIN, now), 'now', 'a future stamp (clock skew) reads as now')
})

test('timeText: a missing or invalid time is empty, never "NaN"', () => {
  const { timeText } = loadPanel()
  for (const bad of [undefined, null, 0, -1, 'x', NaN, Infinity]) assert.equal(timeText(bad, 1_700_000_000_000), '')
})

test('every status the worker can send has a glyph and a tone', () => {
  const { ICONS, TONES } = loadPanel()
  assert.deepEqual(Object.keys(ICONS).sort(), STATUS_IDS.slice().sort())
  assert.deepEqual(Object.keys(TONES).sort(), STATUS_IDS.slice().sort())
  for (const id of STATUS_IDS) assert.match(ICONS[id]!, /^<svg [^>]*aria-hidden="true">.*<\/svg>$/, id)
  const allowed = new Set(['waiting', 'danger', 'yellow', 'amber', 'green', 'muted'])
  for (const id of STATUS_IDS) assert.ok(allowed.has(TONES[id]!), `${id} tone`)
  // the colors the brief asks for
  assert.equal(TONES.waiting, 'waiting')
  assert.equal(TONES.blocked, 'danger')
  assert.equal(TONES.failed, 'danger')
  assert.equal(TONES.working, 'yellow')
  assert.equal(TONES.monitoring, 'yellow')
  assert.equal(TONES.unconfirmed, 'amber')
  assert.equal(TONES.unverifiable, 'amber')
  assert.equal(TONES.done, 'green')
  assert.equal(TONES.interrupted, 'muted')
})

test('the page references only its own files and no remote URLs', () => {
  const html = read('panel/index.html')
  assert.ok(existsSync(join(root, 'panel/panel.css')) && existsSync(join(root, 'panel/panel.js')))
  assert.match(html, /href="panel\.css"/)
  assert.match(html, /src="panel\.js"/)
  for (const [name, text] of [['html', html], ['css', read('panel/panel.css')], ['js', read('panel/panel.js')]] as const) {
    assert.doesNotMatch(text.replace(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g, ''), /https?:\/\//, `${name} must not reference a URL`)
  }
  assert.doesNotMatch(read('panel/panel.css'), /@import|url\(/)
})

test('the panel respects reduced motion and uses Orca theme variables', () => {
  const css = read('panel/panel.css')
  assert.match(css, /prefers-reduced-motion: reduce/)
  for (const v of ['--orca-background', '--orca-foreground', '--orca-accent', '--orca-border', '--orca-muted-foreground', '--orca-primary']) assert.ok(css.includes(v), v)
  assert.match(css, /button:focus-visible/)
})

// ---- behaviour: the real panel.js running against a hand-written DOM and a fake Orca bridge ------------

const html = read('panel/index.html')
const js = read('panel/panel.js')
const tick = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise<void>((r) => setImmediate(r))
}

/** Four agents in two worktrees; alpha is the active one. Handles exist for every row but the working one in beta. */
function sampleModel(over: { cursor?: string | null; groupBy?: 'status' | 'worktree'; title?: string } = {}): RosterModel {
  const mk = (paneKey: string, status: string, agoMin: number, extra: Record<string, unknown> = {}) =>
    agent({ paneKey, activity: verdict({ status, sortAt: NOW - agoMin * MIN, ...extra }) })
  const wa = worktree({ worktreeId: 'wa', displayName: 'alpha', branch: 'refs/heads/main', isActive: true, lastActivityAt: NOW }, [mk('a1:l', 'waiting', 4), mk('a2:l', 'working', 2)])
  const wb = worktree({ worktreeId: 'wb', displayName: 'beta', branch: 'refs/heads/fix/x', lastActivityAt: NOW - MIN }, [mk('b1:l', 'done', 9), mk('b2:l', 'working', 1, { unread: true })])
  const terms = [
    terminal('a1:l', { handle: 'h-a1', title: over.title ?? 'Untangle the walrus scheduler' }),
    terminal('a2:l', { handle: 'h-a2', title: 'Rename the quokka module' }),
    terminal('b1:l', { handle: 'h-b1', title: 'Draft the mango release notes' })
  ]
  const n = normalize(psOf(wa, wb), terminalsOf(...terms), NOW)
  return buildModel(n, { ...DEFAULT_SETTINGS, groupBy: over.groupBy ?? 'status' }, over.cursor ?? null, null)
}

/** Opens the panel and answers its first roster.list with `model`. */
async function open(model: RosterModel | null = sampleModel()): Promise<Page> {
  const page = openPanel({ html, js, clock: fakeClock(NOW) })
  assert.equal(page.bridge.calls[0]?.name, 'roster.list', 'the panel asks for the model first')
  if (model) {
    page.bridge.calls[0]!.resolve(model)
    await tick()
  }
  return page
}

const cursorKeys = (page: Page) => page.rows().filter((r) => r.cursor).map((r) => r.paneKey)

test('panel: renders the model in status groups, with titles, meta lines, badges and the cursor row', async () => {
  const page = await open(sampleModel({ cursor: 'a2:l' }))
  assert.deepEqual(page.groups().map((g) => [g.name, g.badge]), [['Waiting for input', '1'], ['Working', '2'], ['Done', '1']])
  assert.deepEqual(page.rows().map((r) => r.paneKey), ['a1:l', 'b2:l', 'a2:l', 'b1:l'])
  const first = page.rows()[0]!
  assert.equal(first.title, 'Untangle the walrus scheduler')
  assert.match(first.meta, /^alpha \/ main \u00B7 claude$/)
  assert.deepEqual(cursorKeys(page), ['a2:l'])
  assert.equal(page.list.getAttribute('aria-busy'), 'false')
  const pressed = page.doc.querySelector('.seg')!.querySelectorAll('button').map((b) => [b.getAttribute('data-mode'), b.getAttribute('aria-pressed')])
  assert.deepEqual(pressed, [['status', 'true'], ['worktree', 'false']])
  assert.equal(page.note.hidden, true)
  const bell = page.rows().find((r) => r.paneKey === 'b2:l')!.node
  assert.ok(bell.classList.contains('is-unread'))
  assert.ok(bell.querySelector('.bell'), 'unread rows carry the bell')
})

test('panel: worktree mode lists every agent under its worktree, with the current pill and a repo / branch subtitle', async () => {
  const page = await open(sampleModel({ groupBy: 'worktree' }))
  assert.deepEqual(page.groups().map((g) => [g.name, g.badge, g.pill]), [['alpha', '2', true], ['beta', '2', false]])
  assert.match(page.groups()[0]!.sub, /alpha-repo \/ main/)
  // in worktree mode the meta line leads with the status instead of the worktree
  assert.match(page.rows()[0]!.meta, /^Waiting for input \u00B7 claude$/)
})

test('panel: an empty roster, a CLI error note and the capped note', async () => {
  const empty = await open({ ...sampleModel(), rows: [], groups: { status: [], worktree: [] } })
  assert.match(empty.list.textContent, /No agents running/)
  const failing = await open({ ...sampleModel(), error: 'Orca CLI unavailable, retrying', errorDetail: 'spawn failed' })
  assert.equal(failing.note.hidden, false)
  assert.equal(failing.note.textContent, 'Orca CLI unavailable, retrying')
  assert.ok(failing.note.classList.contains('is-error'))
  assert.equal(failing.rows().length, 4, 'the last good rows stay on screen')
  const capped = await open({ ...sampleModel(), capped: { shown: 4, total: 900 } } as RosterModel)
  assert.equal(capped.note.hidden, false)
  assert.equal(capped.note.textContent, 'Showing 4 of 900 agents')
  assert.ok(!capped.note.classList.contains('is-error'))
})

test('panel: model text is written as text, and markup is only ever built from the static glyph tables', async () => {
  const hostile = '<img src=x onerror=alert(1)> & <b>bold</b>'
  const page = await open(sampleModel({ title: hostile }))
  const title = page.rows().find((r) => r.paneKey === 'a1:l')!
  assert.equal(title.title, hostile, 'shown verbatim as text')
  assert.equal(page.rows().find((r) => r.paneKey === 'a1:l')!.node.querySelector('img'), null, 'no element was created from it')
  assert.ok(page.doc.log.innerHTMLWrites.length > 0)
  for (const markup of page.doc.log.innerHTMLWrites) {
    assert.match(markup, /^<svg [^>]*aria-hidden="true">.*<\/svg>$/, 'only the static svg tables')
    assert.ok(!markup.includes('onerror') && !markup.includes('walrus'), 'no model text inside markup')
  }
})

test('panel: clicking a row asks the worker to focus it and shows the cursor there at once', async () => {
  const page = await open(sampleModel({ cursor: 'a1:l' }))
  page.rows().find((r) => r.paneKey === 'b1:l')!.node.dispatch('click')
  assert.deepEqual(page.bridge.last('roster.focus')!.input, { paneKey: 'b1:l' })
  assert.deepEqual(cursorKeys(page), ['b1:l'], 'optimistic highlight')
  page.bridge.last('roster.focus')!.resolve({ ok: true })
  await tick()
  assert.deepEqual(cursorKeys(page), ['b1:l'], 'a successful switch keeps it')
  assert.equal(page.note.hidden, true)
})

test('panel: a focus the worker refuses undoes the optimistic highlight and says why', async () => {
  const page = await open(sampleModel({ cursor: 'a1:l' }))
  page.rows().find((r) => r.paneKey === 'b1:l')!.node.dispatch('click')
  assert.deepEqual(cursorKeys(page), ['b1:l'])
  page.bridge.last('roster.focus')!.resolve({ ok: false, reason: 'Orca could not switch to that terminal.' })
  await tick()
  assert.deepEqual(cursorKeys(page), ['a1:l'], 'the cursor is back where it was')
  assert.equal(page.note.textContent, 'Orca could not switch to that terminal.')
  assert.ok(page.note.classList.contains('is-error'))
})

test('panel: a focus that fails because the worker is unreachable also undoes the highlight', async () => {
  const page = await open(sampleModel({ cursor: null }))
  page.rows().find((r) => r.paneKey === 'a2:l')!.node.dispatch('click')
  assert.deepEqual(cursorKeys(page), ['a2:l'])
  page.bridge.last('roster.focus')!.reject(new Error('timed out'))
  await tick()
  assert.deepEqual(cursorKeys(page), [])
  assert.match(page.note.textContent, /not reachable/)
})

test('panel: a failure that arrives after the worker already pushed a newer cursor does not move it back', async () => {
  const page = await open(sampleModel({ cursor: 'a1:l' }))
  page.rows().find((r) => r.paneKey === 'b1:l')!.node.dispatch('click')
  page.bridge.push('roster.update', sampleModel({ cursor: 'a2:l' })) // the worker says a2 is the cursor
  assert.deepEqual(cursorKeys(page), ['a2:l'])
  page.bridge.last('roster.focus')!.resolve({ ok: false, reason: 'nope' })
  await tick()
  assert.deepEqual(cursorKeys(page), ['a2:l'], 'the worker is the source of truth')
})

test('panel: a row the model lists without a terminal is still sent to the worker, which looks the terminal up at click time', async () => {
  const model = sampleModel({ cursor: 'a1:l' })
  const row = model.rows.find((r) => r.paneKey === 'b2:l')!
  assert.equal(row.handle, null)
  const page = await open(model)
  const node = page.rows().find((r) => r.paneKey === 'b2:l')!.node
  assert.equal(node.getAttribute('aria-disabled'), null, 'the row is clickable')
  node.dispatch('click')
  assert.equal(page.bridge.pending('roster.focus').length, 1)
  assert.deepEqual(page.bridge.last('roster.focus')!.input, { paneKey: 'b2:l' })
  const reason = 'Orca lists no terminal for this agent right now. Try again in a moment.'
  page.bridge.last('roster.focus')!.resolve({ ok: false, reason })
  await tick()
  assert.equal(page.note.textContent, reason, "the worker's plain-words answer is shown as it came")
  assert.deepEqual(cursorKeys(page), ['a1:l'], 'the optimistic cursor was put back')
})

test('panel: when the worker is unreachable there is exactly one retry loop, however often the panel is shown again', async () => {
  const page = await open(null)
  const timersBefore = page.clock.pending() // the 30 s time-text interval
  page.bridge.calls[0]!.reject(new Error('worker down'))
  await tick()
  assert.match(page.note.textContent, /not reachable/)
  assert.equal(page.clock.pending(), timersBefore + 1, 'one retry timer')
  // the panel is hidden and shown again several times while the worker is still down
  for (let i = 0; i < 3; i++) {
    page.doc.setVisibility('hidden')
    page.doc.setVisibility('visible')
  }
  assert.ok(page.bridge.pending('roster.list').length <= 1, 'never two loads in flight')
  page.bridge.pending('roster.list').forEach((c) => c.reject(new Error('worker down')))
  await tick()
  assert.ok(page.clock.pending() <= timersBefore + 1, `retry timers stacked up: ${page.clock.pending() - timersBefore}`)
  // the retry fires once and, when the worker is back, the loop ends for good
  page.clock.tick(3000)
  await tick()
  const retry = page.bridge.pending('roster.list')
  assert.equal(retry.length, 1)
  retry[0]!.resolve(sampleModel())
  await tick()
  assert.equal(page.rows().length, 4)
  assert.equal(page.note.hidden, true)
  assert.equal(page.clock.pending(), timersBefore, 'success clears the retry')
  page.clock.tick(60_000)
  await tick()
  assert.equal(page.bridge.pending('roster.list').length, 0, 'nothing retries after success')
})

test('panel: hiding the panel cancels a pending retry', async () => {
  const page = await open(null)
  const timersBefore = page.clock.pending()
  page.bridge.calls[0]!.reject(new Error('worker down'))
  await tick()
  assert.equal(page.clock.pending(), timersBefore + 1)
  page.doc.setVisibility('hidden')
  assert.equal(page.clock.pending(), timersBefore, 'the retry timer is cleared on hide')
  page.clock.tick(10_000)
  await tick()
  assert.equal(page.bridge.calls.filter((c) => c.name === 'roster.list').length, 1, 'no load while hidden')
  page.doc.setVisibility('visible')
  assert.equal(page.bridge.pending('roster.list').length, 1, 'showing it again loads once')
})

test('panel: the Group by switch flips at once, tells the worker, and applies the worker answer', async () => {
  const page = await open(sampleModel())
  const worktreeButton = page.doc.querySelector('.seg')!.querySelectorAll('button')[1]!
  worktreeButton.dispatch('click')
  assert.deepEqual(page.groups().map((g) => g.name), ['alpha', 'beta'], 'both groupings are already in the model')
  assert.equal(worktreeButton.getAttribute('aria-pressed'), 'true')
  assert.deepEqual(page.bridge.last('roster.setGroup')!.input, { mode: 'worktree' })
  page.bridge.last('roster.setGroup')!.resolve({ ok: true, model: sampleModel({ groupBy: 'worktree', cursor: 'b1:l' }) })
  await tick()
  assert.deepEqual(cursorKeys(page), ['b1:l'])
})

test('panel: a pushed update re-renders and keeps keyboard focus on the same row; arrow keys move between rows', async () => {
  const page = await open(sampleModel())
  const rows = page.rows()
  rows[1]!.node.focus()
  page.bridge.push('roster.update', sampleModel({ cursor: 'a1:l' }))
  assert.equal(page.doc.activeElement?.getAttribute('data-pane'), rows[1]!.paneKey, 'focus survives the re-render')
  assert.notEqual(page.doc.activeElement, rows[1]!.node, 'it is a fresh node, focus was restored by key')
  page.list.dispatch('keydown', { key: 'ArrowDown' })
  assert.equal(page.doc.activeElement?.getAttribute('data-pane'), rows[2]!.paneKey)
  page.list.dispatch('keydown', { key: 'Home' })
  assert.equal(page.doc.activeElement?.getAttribute('data-pane'), rows[0]!.paneKey)
  page.list.dispatch('keydown', { key: 'End' })
  assert.equal(page.doc.activeElement?.getAttribute('data-pane'), rows[3]!.paneKey)
  page.list.dispatch('keydown', { key: 'a' }) // other keys are left alone
  assert.equal(page.doc.activeElement?.getAttribute('data-pane'), rows[3]!.paneKey)
})

test('panel: the "5m" texts tick forward in place every 30 s without a re-render', async () => {
  const page = await open(sampleModel())
  const before = page.rows().find((r) => r.paneKey === 'a1:l')!
  assert.equal(before.time, '4m')
  page.setNow(NOW + 3 * MIN)
  page.clock.tick(30_000)
  const after = page.rows().find((r) => r.paneKey === 'a1:l')!
  assert.equal(after.time, '7m')
  assert.equal(after.node, before.node, 'the same node: focus and scroll stay put')
})

test('panel: the refresh button asks the worker and shows busy until it answers', async () => {
  const page = await open(sampleModel())
  const button = page.doc.getElementById('refresh')!
  button.dispatch('click')
  assert.ok(button.classList.contains('busy'))
  page.bridge.last('roster.refresh')!.resolve(sampleModel({ cursor: 'a2:l' }))
  await tick()
  assert.ok(!button.classList.contains('busy'))
  assert.deepEqual(cursorKeys(page), ['a2:l'])
})

test('panel: outside Orca it explains itself, and across every interaction it never touches the network', async () => {
  const bare = openPanel({ html, js, clock: fakeClock(NOW), withBridge: false })
  assert.match(bare.list.textContent, /runs inside Orca/)
  const page = await open(sampleModel())
  page.rows()[0]!.node.dispatch('click')
  page.doc.getElementById('refresh')!.dispatch('click')
  page.doc.setVisibility('hidden')
  page.doc.setVisibility('visible')
  page.clock.tick(60_000)
  await tick()
  assert.deepEqual(page.net, [])
})
