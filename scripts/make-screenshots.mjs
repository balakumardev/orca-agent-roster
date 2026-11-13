// Renders the panel with INVENTED sample data in headless Chrome, for the plugin page's
// screenshots, and checks that the page draws without errors. Dev tooling: not shipped logic.
//
//   node scripts/make-screenshots.mjs            writes screenshots/*.png and checks the DOM
//   CHROME=/path/to/chrome node scripts/...      use another Chrome or Chromium
//   OUT=/some/dir node scripts/...               write the PNGs there instead (to try it without touching screenshots/)
//
// It never touches Orca: a stub `window.orca` serves the sample model to the real panel.js.

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildModel, DEFAULT_SETTINGS, STATUS_LABEL } from '../src/model.ts'

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const MIN = 60_000
const now = Date.now()

// ---- invented sample roster --------------------------------------------------------------------

let n = 0
function row(over) {
  n++
  const status = over.status
  return {
    paneKey: `tab-${n}:leaf-${n}`,
    handle: `term_${n}`,
    worktreeId: over.worktreeName,
    repo: 'sample-repo',
    agentType: 'claude',
    titleSource: 'terminal',
    statusLabel: STATUS_LABEL[status],
    unread: false,
    isCurrentWorktree: false,
    hasLivePty: true,
    isChild: false,
    isFolded: false,
    worktreeActivityAt: 0,
    indexInWorktree: 0,
    ...over,
    sortAt: now - over.ago * MIN
  }
}

const rows = [
  row({ title: 'Untangle the walrus scheduler', status: 'waiting', ago: 4, worktreeName: 'api-gateway', branch: 'fix/walrus-queue', unread: true, worktreeActivityAt: now - 1 * MIN, indexInWorktree: 0, isCurrentWorktree: true }),
  row({ title: 'Migrate the invoices table', status: 'failed', ago: 41, worktreeName: 'api-gateway', branch: 'fix/walrus-queue', worktreeActivityAt: now - 1 * MIN, indexInWorktree: 1, isCurrentWorktree: true }),
  row({ title: 'Rename the quokka module', status: 'working', ago: 2, worktreeName: 'web-app', branch: 'feature/quokka', worktreeActivityAt: now - 2 * MIN, indexInWorktree: 0 }),
  row({ title: 'Port the parser to the new tokenizer', status: 'working', ago: 0, agentType: 'codex', worktreeName: 'web-app', branch: 'feature/quokka', worktreeActivityAt: now - 2 * MIN, indexInWorktree: 1 }),
  row({ title: 'Watch the nightly export job', status: 'monitoring', ago: 12, worktreeName: 'data-jobs', branch: 'main', worktreeActivityAt: now - 3 * MIN, indexInWorktree: 0 }),
  row({ title: 'Draft the mango release notes', status: 'done', ago: 62, worktreeName: 'docs-site', branch: 'main', unread: true, worktreeActivityAt: now - 4 * MIN, indexInWorktree: 0 }),
  row({ title: 'Tidy the pelican config', status: 'done', ago: 3 * 60, agentType: 'codex', worktreeName: 'docs-site', branch: 'main', worktreeActivityAt: now - 4 * MIN, indexInWorktree: 1 })
]
for (const r of rows) r.worktreeName = r.worktreeId

const normalized = { rows, activeWorktreeId: 'api-gateway' }
const cursor = rows[0].paneKey

// ---- theme tokens: invented, close to a neutral dark and light theme ----------------------------

const THEMES = {
  dark: {
    '--orca-background': '#18181b',
    '--orca-foreground': '#fafafa',
    '--orca-card': '#18181b',
    '--orca-primary': '#e4e4e7',
    '--orca-muted': '#27272a',
    '--orca-muted-foreground': '#a1a1aa',
    '--orca-accent': '#27272a',
    '--orca-destructive': '#f87171',
    '--orca-border': '#2f2f35',
    '--orca-ring': '#71717a',
    '--orca-radius': '10px',
    stage: 'radial-gradient(1200px 700px at 20% 10%, #1f2937 0%, #0b0e14 70%)',
    text: '#e5e7eb'
  },
  light: {
    '--orca-background': '#ffffff',
    '--orca-foreground': '#09090b',
    '--orca-card': '#ffffff',
    '--orca-primary': '#18181b',
    '--orca-muted': '#f4f4f5',
    '--orca-muted-foreground': '#71717a',
    '--orca-accent': '#f4f4f5',
    '--orca-destructive': '#dc2626',
    '--orca-border': '#e4e4e7',
    '--orca-ring': '#a1a1aa',
    '--orca-radius': '10px',
    stage: 'radial-gradient(1200px 700px at 20% 10%, #eef2ff 0%, #dfe5f1 75%)',
    text: '#1f2937'
  }
}

const shots = [
  { file: 'status-dark.png', theme: 'dark', groupBy: 'status', title: 'Orca’s Activity view, in its own pane', blurb: 'Every running agent grouped by status, with the real session title instead of the first prompt.' },
  { file: 'worktree-light.png', theme: 'light', groupBy: 'worktree', title: 'Every agent of a worktree, always visible', blurb: 'Group by worktree and nothing is folded away. The highlighted row is where the shortcuts will continue from.' }
]

function stage(shot) {
  const t = THEMES[shot.theme]
  const vars = Object.entries(t).filter(([k]) => k.startsWith('--')).map(([k, v]) => `${k}:${v}`).join(';')
  const model = buildModel(normalized, { ...DEFAULT_SETTINGS, groupBy: shot.groupBy }, cursor, null)
  const panelHtml = readFileSync(join(root, 'panel/index.html'), 'utf8')
  const body = panelHtml.slice(panelHtml.indexOf('<body>') + 6, panelHtml.indexOf('<script src="panel.js">'))
  const css = pathToFileURL(join(root, 'panel/panel.css')).href
  const js = pathToFileURL(join(root, 'panel/panel.js')).href
  return `<!doctype html>
<html lang="en" class="${shot.theme}"><head><meta charset="utf-8"><title>Agent Roster</title>
<link rel="stylesheet" href="${css}">
<style>
  :root{${vars}}
  html,body{height:100%}
  body.stage{margin:0;display:flex;align-items:center;justify-content:center;gap:72px;background:${t.stage};color:${t.text};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif}
  .caption{max-width:430px}
  .caption h1{margin:0 0 14px;font-size:40px;line-height:1.1;font-weight:700;letter-spacing:-.02em}
  .caption p{margin:0;font-size:19px;line-height:1.5;opacity:.78}
  .frame{width:380px;height:760px;overflow:auto;border-radius:14px;background:var(--orca-background);border:1px solid var(--orca-border);box-shadow:0 30px 80px rgba(0,0,0,.35)}
</style></head>
<body class="stage">
<div class="caption"><h1>${shot.title}</h1><p>${shot.blurb}</p></div>
<div class="frame">${body}</div>
<script>
  window.__MODEL = ${JSON.stringify(model)};
  window.orca = { plugin: {
    request: function (name) { return Promise.resolve(name === 'roster.list' || name === 'roster.refresh' ? window.__MODEL : { ok: true, model: window.__MODEL }) },
    on: function () { return { dispose: function () {} } }
  } };
</script>
<script src="${js}"></script>
</body></html>`
}

// ---- render ------------------------------------------------------------------------------------

const work = mkdtempSync(join(tmpdir(), 'agent-roster-shots-'))
const profile = join(work, 'chrome-profile')
const out = process.env.OUT ? resolve(process.env.OUT) : join(root, 'screenshots')
mkdirSync(out, { recursive: true })

function chrome(args) {
  return execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', `--user-data-dir=${profile}`, '--hide-scrollbars', '--force-device-scale-factor=1', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000
  })
}

for (const shot of shots) {
  const page = join(work, `${shot.theme}-${shot.groupBy}.html`)
  writeFileSync(page, stage(shot))
  // 1) the page must draw: dump the DOM after scripts ran and look for the rows and no error note
  const dom = chrome(['--virtual-time-budget=4000', '--dump-dom', pathToFileURL(page).href])
  const drawn = (dom.match(/class="row[ "]/g) ?? []).length
  const groups = (dom.match(/class="group"/g) ?? []).length
  if (drawn !== rows.length) throw new Error(`${shot.file}: expected ${rows.length} rows, the panel drew ${drawn}`)
  if (dom.includes('worker not reachable') || dom.includes('Orca CLI unavailable')) throw new Error(`${shot.file}: the panel shows an error note`)
  console.log(`${shot.file}: panel drew ${drawn} rows in ${groups} groups`)
  // 2) the picture
  chrome([`--screenshot=${join(out, shot.file)}`, '--window-size=1600,1000', '--virtual-time-budget=4000', pathToFileURL(page).href])
}
console.log('done')
