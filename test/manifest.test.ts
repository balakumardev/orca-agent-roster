import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_SETTINGS, STATUS_IDS } from '../src/model.ts'
import { createRoster } from '../src/worker.ts'
import { newRig, sampleWorld, settle } from './rig.ts'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(root, 'orca-plugin.json'), 'utf8')) as Record<string, any>

test('identity: id, name and publisher-derived key rules', () => {
  assert.equal(manifest.id, 'agent-roster')
  assert.equal(manifest.name, 'Agent Roster')
  assert.ok(!manifest.name.toLowerCase().startsWith('orca'))
  assert.ok(!manifest.id.startsWith('orca-'))
  assert.equal('publisher' in manifest, false, 'the owner prefix is automatic')
  assert.equal(manifest.license, 'MIT')
  assert.equal(manifest.author.name, 'balakumardev')
  assert.equal(manifest.repository, 'https://github.com/balakumardev/orca-agent-roster')
  assert.equal(manifest.homepage, 'https://github.com/balakumardev/orca-agent-roster')
  assert.equal(manifest.engines.orca, '>=1.4.258')
  assert.equal(manifest.execution, 'trusted-worker')
  assert.equal(manifest.main, 'src/worker.ts')
  const taken = ['power-sessions', 'chat-board', 'agent-inbox', 'agent-center', 'agent-activity', 'agent-deck', 'agent-pool', 'agent-split', 'agent-accounts', 'context-meter', 'activity-calendar', 'cockpit', 'overview', 'toolkit', 'folder-sessionizer', 'worktree-kit-sync']
  assert.ok(!taken.includes(manifest.id))
})

test('every file the manifest names exists', () => {
  const files = [manifest.icon, manifest.main, ...manifest.contributes.panels.map((p: { entry: string }) => p.entry)]
  for (const f of files) assert.ok(existsSync(join(root, f)), f)
  assert.ok(statSync(join(root, manifest.icon)).size <= 256 * 1024, 'icon <= 256 KB')
  for (const s of manifest.screenshots ?? []) {
    assert.ok(existsSync(join(root, s.path)), s.path)
    assert.ok(statSync(join(root, s.path)).size <= 1536 * 1024, `${s.path} <= 1536 KB`)
    assert.ok(typeof s.alt === 'string' && s.alt.length > 0)
  }
  assert.ok((manifest.screenshots ?? []).length <= 6)
})

test('the shortcuts: previous and next, global, one command each, no chord bound twice', () => {
  const { commands, keybindings } = manifest.contributes
  assert.deepEqual(commands.map((c: { id: string }) => c.id).sort(), ['agent-roster.next', 'agent-roster.prev'])
  const byCommand = Object.fromEntries(keybindings.map((k: { command: string; key: string; when: string }) => [k.command, k]))
  assert.equal(byCommand['agent-roster.prev'].key, 'Mod+Shift+Semicolon')
  assert.equal(byCommand['agent-roster.next'].key, 'Mod+Shift+Quote')
  for (const k of keybindings) {
    assert.equal(k.when, 'global')
    const cmd = commands.find((c: { id: string }) => c.id === k.command)
    assert.ok(cmd, `${k.command} must be contributed`)
    assert.equal(cmd.when, k.when, 'a shortcut must match its command\'s `when`')
  }
  assert.equal(new Set(keybindings.map((k: { key: string }) => k.key)).size, keybindings.length)
})

test('capabilities are the minimum the worker needs', () => {
  assert.ok(manifest.contributes.events.length <= 5)
  assert.deepEqual(manifest.capabilities.map((c: { kind: string }) => c.kind).sort(), ['agent:read', 'settings:own', 'workspace:read'])
})

test('the running worker uses only what the manifest declares: events, commands, settings, host calls and Orca API members', async () => {
  const rig = newRig({ world: sampleWorld() })
  const roster = createRoster(rig.fake.orca, rig.deps)
  try {
    await settle()
    // exercise every entry point once
    await rig.fake.commands.get('agent-roster.next')!(undefined, { signal: new AbortController().signal })
    await rig.fake.commands.get('agent-roster.prev')!(undefined, { signal: new AbortController().signal })
    await rig.fake.handlers.get('roster.list')!({})
    await rig.fake.handlers.get('roster.refresh')!({})
    await rig.fake.handlers.get('roster.focus')!({ paneKey: 'tb1:l' }, { signal: new AbortController().signal })
    await rig.fake.handlers.get('roster.setGroup')!({ mode: 'worktree' })
    rig.fake.changeSetting('cycleOrder', 'projects')
    rig.fake.emit('agent.status.changed', {})
    rig.fake.emit('workspace.changed', {})
    rig.clock.tick(60_000)
    await settle()

    // events: exactly the declared ones were subscribed to
    assert.deepEqual(rig.fake.eventNames().sort(), manifest.contributes.events.map((e: { on: string }) => e.on).sort())
    // commands: exactly the declared ones were registered
    assert.deepEqual([...rig.fake.commands.keys()].sort(), manifest.contributes.commands.map((c: { id: string }) => c.id).sort())
    // settings: only declared keys were written
    const declared = new Set(manifest.contributes.settings.map((x: { key: string }) => x.key))
    for (const [key] of rig.fake.settingsWrites) assert.ok(declared.has(key), `wrote undeclared setting ${key}`)
    // host calls: only the status bar item the manifest contributes
    assert.ok(rig.fake.hostCalls.length > 0)
    for (const call of rig.fake.hostCalls) {
      assert.equal(call.method, 'statusBar.update')
      assert.ok(manifest.contributes.statusBarItems.some((i: { id: string }) => i.id === call.params.id))
    }
    // API members: nothing that needs a capability the manifest does not ask for (storage, secrets, hooks, ...)
    assert.deepEqual([...rig.fake.touched].filter((m) => !['log', 'commands', 'events', 'panels', 'host', 'settings'].includes(m)), [])
  } finally {
    roster.stop()
  }
})

test('settings match the defaults the code reads', () => {
  const byKey = Object.fromEntries(manifest.contributes.settings.map((s: { key: string }) => [s.key, s]))
  assert.deepEqual(Object.keys(byKey).sort(), Object.keys(DEFAULT_SETTINGS).sort())
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) assert.equal(byKey[key].default, value, key)
  assert.deepEqual(byKey.groupBy.enum, ['status', 'worktree'])
  assert.deepEqual(byKey.cycleOrder.enum, ['activity', 'projects'])
  assert.equal(byKey.skipFinished.type, 'boolean')
  assert.equal(byKey.showChildAgents.type, 'boolean')
  for (const s of manifest.contributes.settings) if (s.enum) assert.equal(s.enumLabels.length, s.enum.length)
})

test('the panel and status bar item', () => {
  const [panel] = manifest.contributes.panels
  assert.equal(panel.entry, 'panel/index.html')
  assert.equal(panel.ui, 'html')
  assert.equal(panel.icon, 'agent')
  const [bar] = manifest.contributes.statusBarItems
  assert.equal(bar.id, 'summary')
  assert.equal('command' in bar, false, 'pressing the summary does nothing: it must not switch agents')
  assert.ok(STATUS_IDS.length > 0)
})

test('no personal paths or addresses in any shipped text file', () => {
  const files = ['orca-plugin.json', 'README.md', 'LICENSE', 'package.json', 'panel/index.html', 'panel/panel.css', 'panel/panel.js', 'src/model.ts', 'src/cycle.ts', 'src/cli.ts', 'src/poller.ts', 'src/worker.ts']
  for (const f of files) {
    if (!existsSync(join(root, f))) continue
    const text = readFileSync(join(root, f), 'utf8')
    assert.doesNotMatch(text, /\/Users\/|\/home\/[a-z]/, `${f} must not name a home directory`)
    assert.doesNotMatch(text, /@[a-z0-9-]+\.(com|ai|io|dev)\b/i, `${f} must not contain an email address`)
  }
})
