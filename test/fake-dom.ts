// A tiny hand-written DOM: only what panel/panel.js touches, so the panel's real code runs under
// node:vm with no jsdom. The static markup is parsed from the real panel/index.html, so a renamed
// id or data attribute breaks the test instead of passing quietly.

import { runInNewContext } from 'node:vm'
import type { fakeClock } from './clock.ts'

type Listener = (event: any) => void

interface Parts {
  tag: string | null
  classes: string[]
  attrs: Array<[string, string | null]>
}

/** `tag`, `.class` and `[attr]` / `[attr=value]` in any mix: all the panel's selectors need. */
function parseSelector(selector: string): Parts {
  const m = /^([a-zA-Z][\w-]*)?((?:\.[\w-]+)*)((?:\[[\w-]+(?:=[^\]]+)?\])*)$/.exec(selector.trim())
  if (!m) throw new Error(`fake DOM: unsupported selector ${selector}`)
  const attrs: Array<[string, string | null]> = []
  for (const a of (m[3] ?? '').match(/\[[^\]]+\]/g) ?? []) {
    const [name, value] = a.slice(1, -1).split('=')
    attrs.push([name!, value === undefined ? null : value.replace(/^["']|["']$/g, '')])
  }
  return { tag: m[1] ? m[1].toLowerCase() : null, classes: (m[2] ?? '').split('.').filter(Boolean), attrs }
}

export class FakeNode {
  tagName: string
  className = ''
  children: FakeNode[] = []
  parentNode: FakeNode | null = null
  attrs: Record<string, string> = {}
  listeners: Record<string, Listener[]> = {}
  own = ''
  hidden = false
  title = ''
  type = ''
  doc: FakeDocument

  constructor(doc: FakeDocument, tag: string) {
    this.doc = doc
    this.tagName = tag.toLowerCase()
  }

  get id(): string {
    return this.attrs.id ?? ''
  }

  get classList() {
    const self = this
    const names = () => self.className.split(/\s+/).filter(Boolean)
    return {
      add(...c: string[]) {
        self.className = Array.from(new Set([...names(), ...c])).join(' ')
      },
      remove(...c: string[]) {
        self.className = names().filter((n) => !c.includes(n)).join(' ')
      },
      contains: (c: string) => names().includes(c),
      toggle(c: string, force?: boolean) {
        const on = force ?? !names().includes(c)
        if (on) this.add(c)
        else this.remove(c)
        return on
      }
    }
  }

  get textContent(): string {
    return this.own + this.children.map((c) => c.textContent).join('')
  }
  set textContent(v: string) {
    this.children = []
    this.own = String(v)
  }

  get innerHTML(): string {
    return this._html
  }
  set innerHTML(v: string) {
    this.doc.log.innerHTMLWrites.push(String(v))
    this.children = []
    this.own = ''
    this._html = String(v)
  }
  _html = ''

  setAttribute(name: string, value: unknown): void {
    this.attrs[name] = String(value)
    if (name === 'class') this.className = String(value)
  }
  getAttribute(name: string): string | null {
    if (name === 'class') return this.className || null
    return name in this.attrs ? this.attrs[name]! : null
  }
  hasAttribute(name: string): boolean {
    return this.getAttribute(name) !== null
  }

  appendChild(child: FakeNode): FakeNode {
    if (child.tagName === '#fragment') {
      for (const c of child.children.splice(0)) this.appendChild(c)
      return child
    }
    child.parentNode?.children.splice(child.parentNode.children.indexOf(child), 1)
    child.parentNode = this
    this.children.push(child)
    return child
  }
  replaceChildren(...nodes: FakeNode[]): void {
    for (const c of this.children) c.parentNode = null
    this.children = []
    this.own = ''
    for (const n of nodes) this.appendChild(n)
  }

  addEventListener(type: string, fn: Listener): void {
    ;(this.listeners[type] ??= []).push(fn)
  }
  /** Fires the listeners the way the browser would, with a bubbling `target` for clicks and keys. */
  dispatch(type: string, event: Record<string, unknown> = {}): void {
    const e = { type, target: this, preventDefault() {}, ...event }
    for (let node: FakeNode | null = this; node; node = node.parentNode) {
      for (const fn of node.listeners[type] ?? []) fn(e)
    }
  }

  matches(selector: string): boolean {
    const { tag, classes, attrs } = parseSelector(selector)
    if (tag && this.tagName !== tag) return false
    const own = this.className.split(/\s+/)
    if (!classes.every((c) => own.includes(c))) return false
    return attrs.every(([name, value]) => {
      const have = this.getAttribute(name)
      return value === null ? have !== null : have === value
    })
  }
  closest(selector: string): FakeNode | null {
    for (let node: FakeNode | null = this; node; node = node.parentNode) if (node.matches(selector)) return node
    return null
  }
  querySelectorAll(selector: string): FakeNode[] {
    const out: FakeNode[] = []
    const walk = (node: FakeNode) => {
      for (const child of node.children) {
        if (child.matches(selector)) out.push(child)
        walk(child)
      }
    }
    walk(this)
    return out
  }
  querySelector(selector: string): FakeNode | null {
    return this.querySelectorAll(selector)[0] ?? null
  }
  focus(): void {
    this.doc.activeElement = this
  }
}

export class FakeDocument {
  log = { innerHTMLWrites: [] as string[] }
  root: FakeNode
  activeElement: FakeNode | null = null
  readyState = 'complete'
  visibilityState = 'visible'
  listeners: Record<string, Listener[]> = {}

  constructor() {
    this.root = new FakeNode(this, '#document')
  }
  createElement(tag: string): FakeNode {
    return new FakeNode(this, tag)
  }
  createDocumentFragment(): FakeNode {
    return new FakeNode(this, '#fragment')
  }
  getElementById(id: string): FakeNode | null {
    const walk = (node: FakeNode): FakeNode | null => {
      for (const c of node.children) {
        if (c.attrs.id === id) return c
        const hit = walk(c)
        if (hit) return hit
      }
      return null
    }
    return walk(this.root)
  }
  querySelector(selector: string): FakeNode | null {
    return this.root.querySelector(selector)
  }
  addEventListener(type: string, fn: Listener): void {
    ;(this.listeners[type] ??= []).push(fn)
  }
  dispatch(type: string): void {
    for (const fn of this.listeners[type] ?? []) fn({ type })
  }
  setVisibility(state: 'visible' | 'hidden'): void {
    this.visibilityState = state
    this.dispatch('visibilitychange')
  }
}

const VOID = new Set(['meta', 'link', 'br', 'img', 'input', 'hr'])

/** Parses well-formed static markup (no script bodies, no entities decoded) into a FakeDocument. */
export function parseHtml(html: string): FakeDocument {
  const doc = new FakeDocument()
  const stack: FakeNode[] = [doc.root]
  const token = /<!--[\s\S]*?-->|<!doctype[^>]*>|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/gi
  for (let m = token.exec(html); m; m = token.exec(html)) {
    const top = stack[stack.length - 1]!
    if (m[1]) {
      const name = m[1].toLowerCase()
      while (stack.length > 1 && stack[stack.length - 1]!.tagName !== name) stack.pop()
      if (stack.length > 1) stack.pop()
    } else if (m[2]) {
      const node = doc.createElement(m[2])
      for (const a of (m[3] ?? '').matchAll(/([^\s=>/]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|[^\s>]+))?/g)) {
        node.setAttribute(a[1]!, a[3] ?? a[4] ?? (a[2] ?? ''))
      }
      if (m[2].toLowerCase() === 'button') node.type = node.getAttribute('type') ?? ''
      top.appendChild(node)
      if (m[4] !== '/' && !VOID.has(node.tagName)) stack.push(node)
    } else if (m[5] && m[5].trim()) {
      const text = doc.createElement('#text')
      text.own = m[5].replace(/\s+/g, ' ')
      top.appendChild(text)
    }
  }
  return doc
}

// ---- the Orca bridge the panel talks to -------------------------------------------------------------

export interface BridgeCall {
  name: string
  input: any
  opts: any
  settled: boolean
  resolve(value: unknown): void
  reject(error: unknown): void
}

export function fakeBridge() {
  const calls: BridgeCall[] = []
  const subscribers = new Map<string, Array<(payload: any) => void>>()
  return {
    calls,
    /** Requests of this name that have not been answered yet. */
    pending: (name: string) => calls.filter((c) => c.name === name && !c.settled),
    last: (name: string) => calls.filter((c) => c.name === name).at(-1),
    plugin: {
      request(name: string, input: unknown, opts: unknown) {
        return new Promise((resolve, reject) => {
          const call: BridgeCall = {
            name,
            // the real bridge serializes the input, so the worker never sees the panel's own objects
            input: input === undefined ? undefined : JSON.parse(JSON.stringify(input)),
            opts,
            settled: false,
            resolve: (v) => {
              call.settled = true
              resolve(v)
            },
            reject: (e) => {
              call.settled = true
              reject(e)
            }
          }
          calls.push(call)
        })
      },
      on(name: string, fn: (payload: any) => void) {
        subscribers.set(name, [...(subscribers.get(name) ?? []), fn])
        return { dispose() {} }
      }
    },
    /** A worker push such as `roster.update`. */
    push(name: string, payload: unknown): void {
      for (const fn of subscribers.get(name) ?? []) fn(payload)
    }
  }
}

// ---- running the real panel -------------------------------------------------------------------------

export interface Page {
  doc: FakeDocument
  bridge: ReturnType<typeof fakeBridge>
  /** Anything the page tried to send over the network. */
  net: string[]
  clock: ReturnType<typeof fakeClock>
  /** Moves the page's clock (what `Date.now()` returns) forward without firing timers. */
  setNow(ms: number): void
  list: FakeNode
  note: FakeNode
  rows(): Array<{ node: FakeNode; paneKey: string; title: string; meta: string; cursor: boolean; time: string }>
  groups(): Array<{ name: string; badge: string; pill: boolean; sub: string }>
}

export function openPanel(opts: { html: string; js: string; clock: ReturnType<typeof fakeClock>; withBridge?: boolean; storage?: Map<string, string> }): Page {
  const doc = parseHtml(opts.html)
  const bridge = fakeBridge()
  const net: string[] = []
  let nowMs = opts.clock.now()
  class PageDate extends Date {
    static now(): number {
      return nowMs
    }
  }
  const refuse = (what: string) =>
    function refused() {
      net.push(what)
      throw new Error(`the panel must not use ${what}`)
    }
  const sandbox: Record<string, unknown> = {
    document: doc,
    Date: PageDate,
    setTimeout: opts.clock.timers.setTimeout,
    clearTimeout: opts.clock.timers.clearTimeout,
    setInterval: opts.clock.timers.setInterval,
    clearInterval: opts.clock.timers.clearInterval,
    console: { log() {}, warn() {}, error() {} },
    fetch: refuse('fetch'),
    XMLHttpRequest: refuse('XMLHttpRequest'),
    WebSocket: refuse('WebSocket'),
    EventSource: refuse('EventSource'),
    navigator: { sendBeacon: refuse('sendBeacon') }
  }
  if (opts.storage) {
    const storage = opts.storage
    sandbox.localStorage = { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, String(v)) }
  }
  sandbox.window = sandbox
  if (opts.withBridge !== false) sandbox.orca = { plugin: bridge.plugin }
  runInNewContext(opts.js, sandbox, { filename: 'panel.js' })

  const list = doc.getElementById('list')!
  const note = doc.getElementById('note')!
  return {
    doc,
    bridge,
    net,
    clock: opts.clock,
    setNow: (ms) => void (nowMs = ms),
    list,
    note,
    rows: () =>
      list.querySelectorAll('.row').map((node) => ({
        node,
        paneKey: node.getAttribute('data-pane') ?? '',
        title: node.querySelector('.row-title')?.textContent ?? '',
        meta: node.querySelector('.row-meta')?.textContent ?? '',
        cursor: node.classList.contains('is-cursor') && node.getAttribute('aria-current') === 'true',
        time: node.querySelector('time')?.textContent ?? ''
      })),
    groups: () =>
      list.querySelectorAll('.group').map((g) => ({
        name: g.querySelector('.group-name')?.textContent ?? '',
        badge: g.querySelector('.badge')?.textContent ?? '',
        pill: g.querySelector('.pill') !== null,
        sub: g.querySelector('.group-sub')?.textContent ?? ''
      }))
  }
}
