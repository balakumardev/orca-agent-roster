// Invented sample data for the tests. Nothing here comes from a real machine.

export const NOW = Date.UTC(2026, 10, 13, 12, 0, 0)
export const MIN = 60_000

type Obj = Record<string, unknown>

let counter = 0

/** An agent row as `orca worktree ps --json` returns it, with every optional key absent. */
export function agent(over: Obj = {}): Obj {
  counter++
  return {
    paneKey: `tab-${counter}:leaf-${counter}`,
    parentPaneKey: null,
    agentType: 'claude',
    state: 'working',
    stateStartedAt: NOW - 5 * MIN,
    updatedAt: NOW - 1_000,
    hasLivePty: true,
    conversationName: null,
    taskTitle: null,
    displayName: null,
    prompt: 'Please tune the zebra widget cache',
    ...over
  }
}

/** The built-in Activity view's verdict for a row. */
export function verdict(over: Obj = {}): Obj {
  return { listed: true, status: 'working', unread: false, clearable: false, sortAt: NOW - 5 * MIN, title: 'prompt text', ...over }
}

export function worktree(over: Obj = {}, agents: Obj[] = []): Obj {
  counter++
  return {
    worktreeId: `repo-a::/work/alpha-${counter}`,
    displayName: `alpha-${counter}`,
    repo: 'alpha-repo',
    path: `/work/alpha-${counter}`,
    branch: 'refs/heads/main',
    isActive: false,
    isArchived: false,
    sortOrder: counter * 1000,
    workspaceKind: 'git',
    agents,
    ...over
  }
}

export function terminal(paneKey: string, over: Obj = {}): Obj {
  const [tabId, leafId] = paneKey.split(':')
  counter++
  return { handle: `term_${counter}`, tabId, leafId, title: 'Rename the quokka module', orphaned: false, writable: true, ...over }
}

export const psOf = (...worktrees: Obj[]): Obj => ({ worktrees, totalCount: worktrees.length, truncated: false })
export const terminalsOf = (...terminals: Obj[]): Obj => ({ terminals, totalCount: terminals.length, truncated: false })
