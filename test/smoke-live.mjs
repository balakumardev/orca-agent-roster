// Read-only live smoke test. NOT part of `npm test` (the file name has no `.test.`).
//
//   node test/smoke-live.mjs              redacted summary of the live roster
//   node test/smoke-live.mjs --scan-repo  checks that no live title or conversation name appears in
//                                         any file of this repository, and prints only counts
//
// It runs the worker's real data layer (src/cli.ts and src/model.ts) against the live
// `orca worktree ps --json` and `orca terminal list --json`. It can run nothing else: the CLI
// runner below refuses every other command, so it can never switch a terminal. Output holds
// counts and category names only. Titles, prompts, paths and ids are never printed.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCli, fetchSnapshot } from '../src/cli.ts'
import { buildModel, cleanTitle, DEFAULT_SETTINGS, deriveStatus, isGenericTitle, listTerminals, normalize, statusBarSummary, STATUS_IDS } from '../src/model.ts'
import { findExact } from '../src/resolve.ts'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const ALLOWED = [
  ['worktree', 'ps'],
  ['terminal', 'list']
]

const realCli = createCli()
/** Only the two read-only listings may run. */
const readOnlyCli = async (args, timeoutMs) => {
  if (!ALLOWED.some(([a, b]) => args[0] === a && args[1] === b)) {
    throw new Error(`smoke-live is read-only: refusing "${args.slice(0, 2).join(' ')}"`)
  }
  return realCli(args, timeoutMs)
}

const hist = (items) => {
  const out = {}
  for (const i of items) out[i] = (out[i] ?? 0) + 1
  return out
}
const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)))

const now = Date.now()
const snap = await fetchSnapshot(readOnlyCli, Date.now)
const norm = normalize(snap.ps, snap.terminals, now)
const model = buildModel(norm, DEFAULT_SETTINGS, null, null)

if (process.argv.includes('--scan-repo')) {
  // Collect every live string worth checking, then count their occurrences in the repository.
  const live = new Set()
  const add = (v) => {
    if (typeof v !== 'string') return
    // A generic name such as the product name is not a session title and legitimately appears in tests.
    if (isGenericTitle(cleanTitle(v))) return
    for (const candidate of [v, cleanTitle(v)]) if (candidate.trim().length >= 6) live.add(candidate.trim())
  }
  for (const t of snap.terminals?.terminals ?? []) add(t?.title)
  for (const w of snap.ps?.worktrees ?? []) {
    for (const a of w?.agents ?? []) {
      add(a?.conversationName)
      add(a?.taskTitle)
    }
  }
  for (const r of norm.rows) add(r.title)

  const files = []
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (['.git', 'node_modules', '.orca'].includes(e.name)) continue
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (!/\.(png|jpe?g|webp|gif)$/i.test(e.name)) files.push(p)
    }
  }
  walk(root)
  let matches = 0
  const perFile = {}
  for (const f of files) {
    if (statSync(f).size > 4 * 1024 * 1024) continue
    const text = readFileSync(f, 'utf8')
    for (const s of live) {
      let from = 0
      for (;;) {
        const at = text.indexOf(s, from)
        if (at < 0) break
        matches++
        const rel = relative(root, f)
        perFile[rel] = (perFile[rel] ?? 0) + 1
        from = at + s.length
      }
    }
  }
  console.log(JSON.stringify({ mode: 'scan-repo', filesScanned: files.length, liveStringsChecked: live.size, matches, filesWithMatches: sorted(perFile) }, null, 2))
  process.exit(matches === 0 ? 0 : 1)
}

// Fallback check: how often does deriveStatus agree with Orca's own Activity verdict?
const disagreements = {}
let comparable = 0
let agree = 0
for (const w of snap.ps?.worktrees ?? []) {
  for (const a of w?.agents ?? []) {
    const act = a?.activity
    if (!act || act.listed === false || typeof act.status !== 'string') continue
    comparable++
    const mine = deriveStatus(a, now)
    if (mine === act.status) agree++
    else disagreements[`${act.status}->${mine}`] = (disagreements[`${act.status}->${mine}`] ?? 0) + 1
  }
}

const allRows = norm.rows
// The action-time lookup's assumptions, as counts: does each agent's pane key find a live terminal, and do the
// worktree id and agent type on the terminal agree with the agent's (what the two fallbacks compare)?
const terms = listTerminals(snap.terminals)
const byKey = new Map(terms.filter((t) => !t.orphaned).map((t) => [`${t.tabId}:${t.leafId}`, t]))
const lookup = {
  agents: allRows.length,
  terminals: terms.length,
  orphanedTerminals: terms.filter((t) => t.orphaned).length,
  exactFound: allRows.filter((r) => findExact(terms, r.paneKey) !== null).length,
  worktreeIdEqualsTerminals: allRows.filter((r) => byKey.get(r.paneKey)?.worktreeId === r.worktreeId).length,
  agentTypeEqualsIdentity: allRows.filter((r) => byKey.get(r.paneKey)?.agentIdentity === r.agentType).length,
  terminalsWithIdentity: terms.filter((t) => t.agentIdentity !== null).length
}
const summary = {
  mode: 'summary',
  cliCalls: { psMs: snap.psMs, terminalListMs: snap.terminalsMs },
  worktrees: (snap.ps?.worktrees ?? []).length,
  activeWorktreeKnown: norm.activeWorktreeId !== null,
  rows: { total: allRows.length, visible: model.rows.length, children: allRows.filter((r) => r.isChild).length, folded: allRows.filter((r) => r.isFolded).length },
  lookup,
  handle: { withHandle: allRows.filter((r) => r.handle !== null).length, withoutHandle: allRows.filter((r) => r.handle === null).length },
  status: sorted(hist(allRows.map((r) => r.status))),
  statusIdsKnown: STATUS_IDS.length,
  titleSource: sorted(hist(allRows.map((r) => r.titleSource))),
  agentType: sorted(hist(allRows.map((r) => r.agentType))),
  unread: allRows.filter((r) => r.unread).length,
  groups: { status: model.groups.status.map((g) => `${g.status}:${g.paneKeys.length}`), worktreesWithAgents: model.groups.worktree.length },
  statusBar: statusBarSummary(model.rows),
  fallbackVsActivity: { comparable, agree, disagreements: sorted(disagreements) }
}
console.log(JSON.stringify(summary, null, 2))
