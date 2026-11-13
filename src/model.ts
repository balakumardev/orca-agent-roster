// Agent Roster: the pure model.
//
// No I/O and no Orca imports. It turns the raw `orca worktree ps --json` and
// `orca terminal list --json` results into the rows, groups and status-bar summary the worker
// posts to the panel. Everything is defensive: a field the CLI leaves out never throws.
//
// The status vocabulary, labels and ranks mirror Orca's own Activity view (AgentListStatus in
// Orca 1.4.258). The Activity view's verdict, `agent.activity`, wins whenever it is present; the
// derivation below only covers rows that are newer than the last publish.

// ---------------------------------------------------------------------------------------------
// Status vocabulary

export type StatusId =
  | 'waiting'
  | 'blocked'
  | 'permission'
  | 'failed'
  | 'unconfirmed'
  | 'working'
  | 'monitoring'
  | 'interrupted'
  | 'unverifiable'
  | 'done'
  | 'idle'

/** Lower rank = earlier header. Same table as Orca's AGENT_LIST_STATUS_RANK. */
export const STATUS_RANK: Record<StatusId, number> = {
  waiting: 0,
  blocked: 1,
  permission: 2,
  failed: 3,
  unconfirmed: 4,
  working: 5,
  monitoring: 6,
  interrupted: 7,
  unverifiable: 8,
  done: 9,
  idle: 10
}

export const STATUS_LABEL: Record<StatusId, string> = {
  waiting: 'Waiting for input',
  blocked: 'Blocked',
  permission: 'Needs attention',
  failed: 'Failed',
  unconfirmed: "Couldn't confirm",
  working: 'Working',
  monitoring: 'Monitoring background tasks',
  interrupted: 'Interrupted',
  unverifiable: 'No recent update',
  done: 'Done',
  idle: 'Idle'
}

export const STATUS_IDS = Object.keys(STATUS_RANK) as StatusId[]

/** A working, blocked or waiting row that has not reported for this long decays (Orca: 30 min). */
export const STALE_AFTER_MS = 30 * 60 * 1000

export function isStatusId(value: unknown): value is StatusId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(STATUS_RANK, value)
}

// ---------------------------------------------------------------------------------------------
// Tiny safe readers for untrusted JSON

type Obj = Record<string, unknown>

function obj(v: unknown): Obj | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : null
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// ---------------------------------------------------------------------------------------------
// Status derivation (fallback for rows with no `activity` verdict)

type Outcome = 'success' | 'failure' | 'cancellation' | 'superseded' | 'interruption' | 'unconfirmed'
const OUTCOMES = new Set<string>(['success', 'failure', 'cancellation', 'superseded', 'interruption', 'unconfirmed'])

/** Orca's agentMainAgentVerdict: the finished lead's outcome, or null while the lead is live. */
function mainVerdict(state: unknown, interrupted: unknown, main: Obj | null): Outcome | null {
  if (main && main.state !== 'done') return null
  const outcome = main?.outcome
  if (outcome !== undefined && outcome !== null) {
    return typeof outcome === 'string' && OUTCOMES.has(outcome) ? (outcome as Outcome) : null
  }
  // Legacy rows: `interrupted` on a finished turn means the person pressed Stop.
  return state === 'done' && interrupted === true ? 'cancellation' : null
}

/**
 * The status Orca's Activity view would show for an agent row, rebuilt from the raw fields.
 * Precedence follows activityThreadStatusId: a failed lead outranks everything, then a stale
 * live row decays by PTY evidence, then the live state, then the finished turn's outcome.
 *
 * A row the structured host owns never decays: Orca's isAgentStatusFresh
 * (shared/agent-status/contracts/agent-status-freshness) returns true for `structuredHostOwned`
 * before it looks at the clock. `orca worktree ps --json` carries that flag as
 * `structuredHostOwned: true` on such agent rows and leaves the key out otherwise (the CLI's row
 * builder only emits it when the host owns the session). The three live rows seen while writing
 * this were all plain terminal agents, so the flag is verified from Orca's code, not from a live
 * structured-host row.
 */
export function deriveStatus(raw: unknown, now: number): StatusId {
  const a = obj(raw) ?? {}
  const state = a.state
  const verdict = mainVerdict(state, a.interrupted, obj(a.mainAgent))
  if (verdict === 'failure' || verdict === 'interruption') return 'failed'

  const live = state === 'working' || state === 'blocked' || state === 'waiting'
  const updatedAt = num(a.updatedAt)
  if (live && a.structuredHostOwned !== true && updatedAt !== null && now - updatedAt > STALE_AFTER_MS) {
    // Silence proves no completion: a live PTY becomes unverifiable, no PTY becomes idle.
    return a.hasLivePty === true ? 'unverifiable' : 'idle'
  }

  switch (state) {
    case 'waiting':
      return 'waiting'
    case 'blocked':
      return 'blocked'
    case 'working':
      return a.workingMode === 'monitoring' ? 'monitoring' : 'working'
    case 'done':
      if (verdict === 'cancellation' || verdict === 'superseded') return 'interrupted'
      if (verdict === 'unconfirmed') return 'unconfirmed'
      return 'done'
    default:
      return 'idle'
  }
}

// ---------------------------------------------------------------------------------------------
// Titles

export type TitleSource = 'terminal' | 'conversation' | 'task' | 'display' | 'prompt' | 'worktree' | 'fallback'

/** Leading spinner and status glyphs agents put in front of a terminal title. */
const LEADING_GLYPHS =
  /^[\s​-‍︎️·•∗*⠀-⣿✀-➿⏺■-◿☀-⛿]+/u

/** C0, DEL and C1 controls: they separate words (a newline or tab in a title is a space). */
const CONTROLS = /[\u0000-\u001F\u007F-\u009F]+/g
/**
 * Characters that draw nothing and only hide or reorder text: soft hyphen, Arabic letter mark,
 * Mongolian vowel separator, zero-width space, LRM and RLM, the bidi embeddings and overrides, and
 * the whole U+2060..U+206F format block (word joiner, invisible operators, isolates, deprecated
 * controls), plus the byte-order mark. They are deleted, not turned into spaces. U+200C and U+200D
 * are deliberately NOT here: ZWNJ and ZWJ are part of Persian words and of emoji sequences.
 */
const INVISIBLES = /[\u00AD\u061C\u180E\u200B\u200E\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g

/** Removes control and invisible characters, leading status glyphs and runs of whitespace. */
export function cleanTitle(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw
    .replace(CONTROLS, ' ')
    .replace(INVISIBLES, '')
    .replace(LEADING_GLYPHS, '')
    .replace(/\s+/g, ' ')
    .trim()
}

const GENERIC_NAMES = /^(claude( code)?|codex( cli)?)(\s+-.*)?$/i
const SHELL_NAMES = /^-?(zsh|bash|fish|sh|dash|ksh|tcsh|csh|nu|nushell|pwsh|powershell|login)$/i
const DEFAULT_TAB_NAMES = /^(terminal|shell)( \d+)?$/i

function basenameOf(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '')
  const parts = trimmed.split(/[\\/]/)
  return parts[parts.length - 1] ?? ''
}

function looksLikePath(t: string): boolean {
  if (t === '~' || /^[A-Za-z]:[\\/]/.test(t)) return true
  // user@host: ~/dir, the default shell title
  if (/^[\w.-]+@[\w.-]+:/.test(t)) return true
  const slashes = t.match(/[\\/]/g)?.length ?? 0
  // A leading slash with words after it is a slash command, not a path.
  if (/^(~|\.{1,2})?[\\/]/.test(t)) return !/\s/.test(t) || slashes >= 2
  // a bare relative path such as src/app/lib
  return !/\s/.test(t) && slashes >= 2
}

/**
 * True when a cleaned title tells the person nothing: an empty string, the agent's own product
 * name, a truncated path stub, a path, a plain shell name, or the worktree's own name.
 * `names` are the worktree and folder names to compare against.
 */
export function isGenericTitle(clean: string, names: readonly string[] = []): boolean {
  const t = clean.trim()
  if (!t) return true
  if (GENERIC_NAMES.test(t)) return true
  if (t.startsWith('..') || t.startsWith('…')) return true
  if (SHELL_NAMES.test(t) || DEFAULT_TAB_NAMES.test(t)) return true
  if (looksLikePath(t)) return true
  const lower = t.toLowerCase()
  for (const n of names) {
    if (n && lower === n.toLowerCase()) return true
  }
  return false
}

let segmenter: { segment(input: string): Iterable<{ segment: string }> } | null | undefined

/** User-perceived characters, so an emoji sequence, a flag or a letter with accents is one unit. */
function graphemes(s: string): string[] {
  if (segmenter === undefined) {
    try {
      segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null
    } catch {
      segmenter = null
    }
  }
  // Without Intl.Segmenter fall back to code points: still safe for plain text and astral emoji.
  return segmenter ? Array.from(segmenter.segment(s), (part) => part.segment) : Array.from(s)
}

/** Cuts to `max` graphemes (the last one is the ellipsis) and never splits a sequence in half. */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s // UTF-16 length is never smaller than the grapheme count
  const units = graphemes(s)
  if (units.length <= max) return s
  return units.slice(0, Math.max(1, max - 1)).join('').trimEnd() + '…'
}

export const PROMPT_TITLE_MAX = 60
export const TITLE_MAX = 120

export interface TitleInput {
  terminalTitle?: unknown
  conversationName?: unknown
  taskTitle?: unknown
  displayName?: unknown
  activityTitle?: unknown
  prompt?: unknown
  worktreeName: string
  /** Worktree display name, folder basename and repo name: titles equal to one are generic. */
  names: readonly string[]
}

/**
 * The label for an agent row: the real session title (the terminal's title) first, then the
 * conversation name, task title and display name, then Orca's activity title and the prompt (both
 * truncated), then the worktree. Every source is cleaned and skipped when it is generic.
 */
export function pickTitle(input: TitleInput): { title: string; source: TitleSource } {
  const chain: Array<[TitleSource, unknown, number]> = [
    ['terminal', input.terminalTitle, TITLE_MAX],
    ['conversation', input.conversationName, TITLE_MAX],
    ['task', input.taskTitle, TITLE_MAX],
    ['display', input.displayName, TITLE_MAX],
    ['prompt', input.activityTitle, PROMPT_TITLE_MAX],
    ['prompt', input.prompt, PROMPT_TITLE_MAX]
  ]
  for (const [source, value, max] of chain) {
    const clean = cleanTitle(value)
    if (!isGenericTitle(clean, input.names)) return { title: truncate(clean, max), source }
  }
  const wt = cleanTitle(input.worktreeName)
  if (wt) return { title: truncate(wt, TITLE_MAX), source: 'worktree' }
  return { title: 'Agent', source: 'fallback' }
}

// ---------------------------------------------------------------------------------------------
// Rows

export interface Row {
  paneKey: string
  /** Runtime terminal handle for `orca terminal switch`, or null when the join found none. */
  handle: string | null
  worktreeId: string
  worktreeName: string
  repo: string
  branch: string
  agentType: string
  title: string
  titleSource: TitleSource
  status: StatusId
  statusLabel: string
  unread: boolean
  sortAt: number
  isCurrentWorktree: boolean
  hasLivePty: boolean
  /** A worker nested under a coordinator agent (the panel marks it "sub-agent"). */
  isChild: boolean
  /** A finished worker Orca's list folds away (`activity.foldedChild`); hidden unless `showChildAgents` is on. */
  isFolded: boolean
  /** The worktree's `lastActivityAt`: the sidebar's default (Recent) order, for `projects` cycling and worktree grouping. */
  worktreeActivityAt: number
  /** The agent's position inside its worktree, as `ps` listed it. */
  indexInWorktree: number
}

export interface Normalized {
  rows: Row[]
  activeWorktreeId: string | null
}

function readHandle(v: unknown): string | null {
  const h = str(v)
  // A handle that starts with `-` would be read as a CLI flag.
  return h !== null && !h.startsWith('-') && /^[\w.:@-]+$/.test(h) ? h : null
}

interface TerminalInfo {
  handle: string | null
  title: string | null
}

function indexTerminals(terminalsResult: unknown): Map<string, TerminalInfo> {
  const out = new Map<string, TerminalInfo>()
  for (const raw of arr(obj(terminalsResult)?.terminals)) {
    const t = obj(raw)
    if (!t) continue
    const tabId = t.tabId
    const leafId = t.leafId
    if ((typeof tabId !== 'string' && typeof tabId !== 'number') || (typeof leafId !== 'string' && typeof leafId !== 'number')) continue
    const key = `${tabId}:${leafId}`
    // A dead handle (orphaned) cannot be switched to and its title is stale.
    if (t.orphaned === true) continue
    if (out.has(key)) continue
    out.set(key, { handle: readHandle(t.handle), title: typeof t.title === 'string' ? t.title : null })
  }
  return out
}

/** One entry of `orca terminal list --json`, reduced to what finding a switch target needs. */
export interface TerminalRecord {
  /** Null when the handle is missing or could be read as a CLI flag: it cannot be switched to. */
  handle: string | null
  tabId: string
  leafId: string
  worktreeId: string | null
  /** The agent type Orca recorded on the terminal ("claude", ...), when it did. */
  agentIdentity: string | null
  /** A terminal whose process is gone: its handle is dead and its pane key is not the pane's. */
  orphaned: boolean
}

/** Every terminal in a `terminal list` result, in order. Anything that is not an object with a tab and a leaf is skipped. */
export function listTerminals(terminalsResult: unknown): TerminalRecord[] {
  const out: TerminalRecord[] = []
  for (const raw of arr(obj(terminalsResult)?.terminals)) {
    const t = obj(raw)
    if (!t) continue
    const { tabId, leafId } = t
    if ((typeof tabId !== 'string' && typeof tabId !== 'number') || (typeof leafId !== 'string' && typeof leafId !== 'number')) continue
    out.push({
      handle: readHandle(t.handle),
      tabId: String(tabId),
      leafId: String(leafId),
      worktreeId: str(t.worktreeId),
      agentIdentity: str(t.agentIdentity),
      orphaned: t.orphaned === true
    })
  }
  return out
}

function stripBranchPrefix(b: unknown): string {
  return typeof b === 'string' ? b.replace(/^refs\/heads\//, '') : ''
}

/**
 * Joins `worktree ps` agents with `terminal list` terminals (key `${tabId}:${leafId}` equals the
 * agent's `paneKey`) and returns one row per pane. Rows the Activity view does not list
 * (`activity.listed === false`) and archived worktrees' non-live rows are dropped. Child rows are
 * kept and flagged; `buildModel` hides only the folded ones, as Orca does (a working sub-agent is
 * never hidden: see classifyChildAgents in Orca's activity-thread-child-agent).
 */
export function normalize(psResult: unknown, terminalsResult: unknown, now: number): Normalized {
  const terminals = indexTerminals(terminalsResult)
  const rows: Row[] = []
  const seen = new Set<string>()
  let activeWorktreeId: string | null = null

  for (const rawWt of arr(obj(psResult)?.worktrees)) {
    const wt = obj(rawWt)
    if (!wt) continue
    const worktreeId = str(wt.worktreeId) ?? str(wt.path) ?? ''
    const archived = wt.isArchived === true
    const isActive = wt.isActive === true
    if (isActive && !archived && activeWorktreeId === null && worktreeId) activeWorktreeId = worktreeId
    const path = str(wt.path) ?? ''
    const repo = str(wt.repo) ?? ''
    const worktreeName = str(wt.displayName) ?? str(path ? basenameOf(path) : '') ?? repo
    const names = [worktreeName, path ? basenameOf(path) : '', repo].filter(Boolean)
    const branch = stripBranchPrefix(wt.branch)
    const worktreeActivityAt = num(wt.lastActivityAt) ?? 0

    let index = 0
    for (const rawAgent of arr(wt.agents)) {
      const agent = obj(rawAgent)
      const paneKey = agent ? str(agent.paneKey) : null
      if (!agent || paneKey === null) continue
      const myIndex = index++
      if (seen.has(paneKey)) continue

      const act = obj(agent.activity)
      if (act && act.listed === false) continue
      const hasLivePty = agent.hasLivePty === true
      if (archived && !hasLivePty) continue
      seen.add(paneKey)

      const status = act && isStatusId(act.status) ? act.status : deriveStatus(agent, now)
      const terminal = terminals.get(paneKey) ?? null
      const { title, source } = pickTitle({
        terminalTitle: terminal?.title,
        conversationName: agent.conversationName,
        taskTitle: agent.taskTitle,
        displayName: agent.displayName,
        activityTitle: act?.title,
        prompt: agent.prompt,
        worktreeName,
        names
      })
      const sortAt = (act ? num(act.sortAt) : null) ?? num(agent.stateStartedAt) ?? num(agent.updatedAt) ?? 0

      rows.push({
        paneKey,
        handle: terminal?.handle ?? null,
        worktreeId,
        worktreeName,
        repo,
        branch,
        agentType: str(agent.agentType) ?? 'agent',
        title,
        titleSource: source,
        status,
        statusLabel: STATUS_LABEL[status],
        unread: act?.unread === true,
        sortAt,
        isCurrentWorktree: isActive,
        hasLivePty,
        isChild: Boolean(act && (str(act.childOf) || act.foldedChild === true)) || str(agent.parentPaneKey) !== null,
        isFolded: act?.foldedChild === true,
        worktreeActivityAt,
        indexInWorktree: myIndex
      })
    }
  }
  return { rows: orderByActivity(rows), activeWorktreeId }
}

/** The same worktree is marked active on every row and in the summary (used right after a switch). */
export function withActiveWorktree(n: Normalized, worktreeId: string): Normalized {
  return {
    activeWorktreeId: worktreeId,
    rows: n.rows.map((r) => ({ ...r, isCurrentWorktree: r.worktreeId === worktreeId }))
  }
}

// ---------------------------------------------------------------------------------------------
// Ordering and grouping

/** Status rank, then sortAt newest first, then pane key so the order is total and stable. */
export function compareActivity(a: Row, b: Row): number {
  return (
    STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
    b.sortAt - a.sortAt ||
    (a.paneKey < b.paneKey ? -1 : a.paneKey > b.paneKey ? 1 : 0)
  )
}

export function orderByActivity(rows: readonly Row[]): Row[] {
  return rows.slice().sort(compareActivity)
}

/** Case and accents ignored, as Orca's sidebar label comparison does (shared/sidebar-list/text-order). */
function fold(text: string): string {
  const lower = text.toLowerCase()
  return /[^\u0000-\u007F]/.test(lower) ? lower.normalize('NFD').replace(/\p{M}/gu, '') : lower
}

/** Digit runs compare as numbers ("w2" before "w10"), everything else by code unit. */
function compareNatural(a: string, b: string): number {
  const x = fold(a).match(/\d+|\D+/g) ?? []
  const y = fold(b).match(/\d+|\D+/g) ?? []
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const p = x[i]!
    const q = y[i]!
    if (/^\d/.test(p) && /^\d/.test(q)) {
      const pn = p.replace(/^0+(?=\d)/, '')
      const qn = q.replace(/^0+(?=\d)/, '')
      if (pn.length !== qn.length) return pn.length - qn.length
      if (pn !== qn) return pn < qn ? -1 : 1
    } else if (p !== q) {
      return p < q ? -1 : 1
    }
  }
  return x.length - y.length
}

/**
 * Worktrees in the order Orca's sidebar uses by default, then the agent's position in its worktree.
 *
 * Orca 1.4.258 defaults to `sortBy: 'recent'` (getDefaultUIState in shared/constants), and Recent
 * sorts by `lastActivityAt`, newest first, then by label (case 'recent' in
 * shared/workspace-view/workspace-row-sort, recentStamp in shared/sidebar-list/stamp-order). `ps`
 * reports `lastActivityAt` on every worktree, so it is read from there; a missing or invalid stamp
 * counts as 0. Not mirrored: the sidebar's grouping by project (the project order is a manual
 * setting `ps` does not expose, so worktrees are walked as one list), the five-minute grace for a
 * brand-new worktree (no `createdAt` in `ps`), and the other sort modes (Smart, Name, Manual).
 */
export function compareProjects(a: Row, b: Row): number {
  return (
    b.worktreeActivityAt - a.worktreeActivityAt ||
    compareNatural(a.worktreeName, b.worktreeName) ||
    (a.worktreeId < b.worktreeId ? -1 : a.worktreeId > b.worktreeId ? 1 : 0) ||
    a.indexInWorktree - b.indexInWorktree ||
    (a.paneKey < b.paneKey ? -1 : a.paneKey > b.paneKey ? 1 : 0)
  )
}

export function orderByProjects(rows: readonly Row[]): Row[] {
  return rows.slice().sort(compareProjects)
}

export interface Group {
  key: string
  kind: 'status' | 'worktree'
  label: string
  /** Worktree groups: `repo / branch`. Status groups: empty. */
  subtitle: string
  status: StatusId | null
  worktreeId: string | null
  isActive: boolean
  paneKeys: string[]
}

/** One group per status that has rows, in rank order; rows keep the activity order inside. */
export function groupByStatus(rows: readonly Row[]): Group[] {
  const ordered = orderByActivity(rows)
  const groups: Group[] = []
  for (const row of ordered) {
    let g = groups[groups.length - 1]
    if (!g || g.status !== row.status) {
      g = {
        key: `status:${row.status}`,
        kind: 'status',
        label: STATUS_LABEL[row.status],
        subtitle: '',
        status: row.status,
        worktreeId: null,
        isActive: false,
        paneKeys: []
      }
      groups.push(g)
    }
    g.paneKeys.push(row.paneKey)
  }
  return groups
}

/** One group per worktree that has agents, in worktree order; every agent is listed under it. */
export function groupByWorktree(rows: readonly Row[]): Group[] {
  const ordered = orderByProjects(rows)
  const groups: Group[] = []
  for (const row of ordered) {
    let g = groups[groups.length - 1]
    if (!g || g.worktreeId !== row.worktreeId) {
      g = {
        key: `worktree:${row.worktreeId}`,
        kind: 'worktree',
        label: row.worktreeName,
        subtitle: [row.repo, row.branch].filter(Boolean).join(' / '),
        status: null,
        worktreeId: row.worktreeId,
        isActive: row.isCurrentWorktree,
        paneKeys: []
      }
      groups.push(g)
    }
    g.paneKeys.push(row.paneKey)
  }
  return groups
}

// ---------------------------------------------------------------------------------------------
// Settings and the model the panel receives

export type GroupMode = 'status' | 'worktree'
export type CycleOrder = 'activity' | 'projects'

export interface RosterSettings {
  groupBy: GroupMode
  cycleOrder: CycleOrder
  skipFinished: boolean
  showChildAgents: boolean
}

export const DEFAULT_SETTINGS: RosterSettings = {
  groupBy: 'status',
  cycleOrder: 'activity',
  skipFinished: false,
  showChildAgents: false
}

export function isGroupMode(v: unknown): v is GroupMode {
  return v === 'status' || v === 'worktree'
}

export function isCycleOrder(v: unknown): v is CycleOrder {
  return v === 'activity' || v === 'projects'
}

/** Reads the settings object Orca returns; anything missing or of the wrong type falls back. */
export function readSettings(raw: unknown): RosterSettings {
  const s = obj(raw) ?? {}
  return {
    groupBy: isGroupMode(s.groupBy) ? s.groupBy : DEFAULT_SETTINGS.groupBy,
    cycleOrder: isCycleOrder(s.cycleOrder) ? s.cycleOrder : DEFAULT_SETTINGS.cycleOrder,
    skipFinished: typeof s.skipFinished === 'boolean' ? s.skipFinished : DEFAULT_SETTINGS.skipFinished,
    showChildAgents: typeof s.showChildAgents === 'boolean' ? s.showChildAgents : DEFAULT_SETTINGS.showChildAgents
  }
}

export interface RosterModel {
  /** Visible rows in the activity order. */
  rows: Row[]
  /** Both groupings, so the panel's toggle switches without a round trip. */
  groups: { status: Group[]; worktree: Group[] }
  settings: RosterSettings
  /** The paneKey the shortcuts last switched to, if that row still exists. */
  cursor: string | null
  activeWorktreeId: string | null
  /** Set while the last refresh failed; the rows are then the last good ones. */
  error: string | null
  errorDetail: string | null
  /** Set only when the roster was too large for one panel post: how many rows the panel got of how many exist. */
  capped: { shown: number; total: number } | null
}

export interface ModelError {
  message: string
  detail: string
}

export function visibleRows(n: Normalized, settings: RosterSettings): Row[] {
  return settings.showChildAgents ? n.rows : n.rows.filter((r) => !r.isFolded)
}

/** The model holds nothing that depends on the clock, so an unchanged roster compares equal. */
export function buildModel(
  n: Normalized,
  settings: RosterSettings,
  cursor: string | null,
  error: ModelError | null
): RosterModel {
  const rows = visibleRows(n, settings)
  return {
    rows,
    groups: { status: groupByStatus(rows), worktree: groupByWorktree(rows) },
    settings,
    cursor: cursor !== null && rows.some((r) => r.paneKey === cursor) ? cursor : null,
    activeWorktreeId: n.activeWorktreeId,
    error: error ? error.message : null,
    errorDetail: error ? error.detail : null,
    capped: null
  }
}

/** The largest model the worker posts to the panel (Orca's post limit is 256 KiB; this leaves headroom). */
export const MAX_MODEL_BYTES = 200_000

/**
 * A model that fits one panel post: when the serialized model is over `maxBytes`, only the first
 * rows (in the activity order) are kept, both groupings are rebuilt from them, and `capped` says
 * how many of how many. A model that already fits is returned as it is, with `capped: null`.
 */
export function fitModel(model: RosterModel, maxBytes: number = MAX_MODEL_BYTES): RosterModel {
  const size = (m: RosterModel): number => JSON.stringify(m).length
  let bytes = size(model)
  if (bytes <= maxBytes) return model
  const total = model.rows.length
  let keep = total
  let fitted = model
  for (let guard = 0; guard < 12 && bytes > maxBytes && keep > 1; guard++) {
    keep = Math.max(1, Math.min(keep - 1, Math.floor((keep * maxBytes * 0.95) / bytes)))
    const rows = model.rows.slice(0, keep)
    fitted = {
      ...model,
      rows,
      groups: { status: groupByStatus(rows), worktree: groupByWorktree(rows) },
      cursor: model.cursor !== null && rows.some((r) => r.paneKey === model.cursor) ? model.cursor : null,
      capped: { shown: keep, total }
    }
    bytes = size(fitted)
  }
  return fitted
}

// ---------------------------------------------------------------------------------------------
// Status bar

export interface StatusBarSummary {
  visible: boolean
  text: string
  tone: 'neutral' | 'warning'
  tooltip: string
}

/** `2 working · 1 waiting`; hidden with no agents; warning tone when something needs the person. */
export function statusBarSummary(rows: readonly Row[]): StatusBarSummary {
  if (rows.length === 0) return { visible: false, text: '', tone: 'neutral', tooltip: 'Agent Roster: no agents running' }
  let working = 0
  let waiting = 0
  let blocked = 0
  for (const r of rows) {
    if (r.status === 'working' || r.status === 'monitoring') working++
    else if (r.status === 'waiting' || r.status === 'permission') waiting++
    else if (r.status === 'blocked') blocked++
  }
  const parts: string[] = []
  if (working) parts.push(`${working} working`)
  if (waiting) parts.push(`${waiting} waiting`)
  if (blocked) parts.push(`${blocked} blocked`)
  const text = parts.length ? parts.join(' · ') : `${rows.length} ${rows.length === 1 ? 'agent' : 'agents'}`
  return {
    visible: true,
    text,
    tone: waiting + blocked > 0 ? 'warning' : 'neutral',
    tooltip: `Agent Roster: ${rows.length} ${rows.length === 1 ? 'agent' : 'agents'}`
  }
}
