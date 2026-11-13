// Agent Roster: finding the terminal behind an agent. Pure functions over a fresh `terminal list`.
//
// The model's handle is a hint from the last refresh. A press or a click asks Orca again and looks
// the pane up by its key (`${tabId}:${leafId}`). When the key is not listed, two fallbacks may name
// the terminal, each only when exactly one terminal qualifies: a guess between two would switch to
// the wrong agent. A terminal that another known agent owns never qualifies.

import type { TerminalRecord } from './model.ts'

/** The waits before the second, third and fourth look at the terminal list. */
export const RESOLVE_BACKOFF_MS: readonly number[] = [250, 500, 800]

export interface Target {
  paneKey: string
  worktreeId: string
  agentType: string
}

export type Via = 'pane' | 'agent type' | 'tab'

export interface Found {
  handle: string
  via: Via
}

/** `${tabId}:${leafId}` cut at the first colon (Orca's tab ids hold none). */
export function splitPaneKey(paneKey: string): { tabId: string; leafId: string } {
  const at = paneKey.indexOf(':')
  return at < 0 ? { tabId: paneKey, leafId: '' } : { tabId: paneKey.slice(0, at), leafId: paneKey.slice(at + 1) }
}

const keyOf = (t: TerminalRecord): string => `${t.tabId}:${t.leafId}`
const usable = (t: TerminalRecord): t is TerminalRecord & { handle: string } => t.handle !== null && !t.orphaned

/** The live terminal of exactly this pane. An orphaned terminal is a dead handle and never matches. */
export function findExact(terms: readonly TerminalRecord[], paneKey: string): Found | null {
  for (const t of terms) if (usable(t) && keyOf(t) === paneKey) return { handle: t.handle, via: 'pane' }
  return null
}

/**
 * A terminal for a pane whose key is not listed. First: the only unclaimed terminal in the same
 * worktree whose agent identity is the row's agent type. Then: the only unclaimed terminal in the
 * same tab. A rule with two or more qualifying terminals gives no answer and the next rule is tried. `claimed` holds the pane keys of the
 * other agents, so their terminals are never taken.
 */
export function findFallback(terms: readonly TerminalRecord[], target: Target, claimed: ReadonlySet<string>): Found | null {
  const free = terms.filter((t) => usable(t) && !claimed.has(keyOf(t)))
  if (target.worktreeId !== '') {
    const byType = free.filter((t) => t.worktreeId === target.worktreeId && t.agentIdentity === target.agentType)
    if (byType.length === 1) return { handle: byType[0]!.handle as string, via: 'agent type' }
  }
  const { tabId } = splitPaneKey(target.paneKey)
  const byTab = free.filter((t) => t.tabId === tabId)
  return byTab.length === 1 ? { handle: byTab[0]!.handle as string, via: 'tab' } : null
}

/** Identity values come from Orca's data: keep short plain tokens, call anything else "other". */
function cleanIdentity(v: string): string {
  return /^[\w.-]{1,24}$/.test(v) ? v : 'other'
}

const MAX_IDENTITIES = 6

/**
 * One line of facts for the log when a lookup missed: the pane named by the first 8 characters of
 * its tab and leaf ids, whether its tab is in the list, and what the worktree holds. Never a title,
 * a handle or a full id.
 */
export function describeList(terms: readonly TerminalRecord[] | null, target: Target): string {
  const { tabId, leafId } = splitPaneKey(target.paneKey)
  const safe = (s: string): string => s.replace(/[^\w.-]/g, '?').slice(0, 8)
  const pane = `pane ${safe(tabId)}:${safe(leafId)}`
  if (terms === null) return `${pane}, terminal list unavailable`
  const inWorktree = terms.filter((t) => target.worktreeId !== '' && t.worktreeId === target.worktreeId)
  const identities = Array.from(new Set(inWorktree.flatMap((t) => (t.agentIdentity ? [cleanIdentity(t.agentIdentity)] : [])))).sort((a, b) => {
    // "other" last, so the readable kinds come first
    return a === 'other' ? 1 : b === 'other' ? -1 : a < b ? -1 : a > b ? 1 : 0
  })
  const shown = identities.length > MAX_IDENTITIES ? [...identities.slice(0, MAX_IDENTITIES), `${identities.length - MAX_IDENTITIES} more`] : identities
  const orphaned = inWorktree.filter((t) => t.orphaned).length
  return (
    `${pane}, tab listed: ${terms.some((t) => t.tabId === tabId) ? 'yes' : 'no'}, ` +
    `terminals in worktree: ${inWorktree.length}${orphaned > 0 ? ` (${orphaned} orphaned)` : ''}, ` +
    `agent identities: ${shown.length > 0 ? shown.join(', ') : 'none'}`
  )
}
