/* Agent Roster panel. Plain JavaScript: no framework, no build, no network.
 *
 * The worker owns all the data. This page asks it for the model (`roster.list`), listens for
 * `roster.update` pushes, and sends clicks back (`roster.focus`, `roster.setGroup`,
 * `roster.refresh`). Every string from the model is written with textContent, never innerHTML;
 * the only markup built from strings is the static icon table below. */
(function () {
  'use strict'

  // ---- status presentation ------------------------------------------------------------------

  // One entry per status the worker can send (Orca's AgentListStatus). The tone picks a color
  // class: waiting orange, danger red, yellow for work, amber for "unsure", green, muted.
  var TONES = {
    waiting: 'waiting',
    permission: 'waiting',
    blocked: 'danger',
    failed: 'danger',
    unconfirmed: 'amber',
    working: 'yellow',
    monitoring: 'yellow',
    interrupted: 'muted',
    unverifiable: 'amber',
    done: 'green',
    idle: 'muted'
  }

  var SVG_OPEN = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  var QUESTION = '<path d="M6.3 6.3a1.8 1.8 0 1 1 2.5 1.7c-.5.3-.8.6-.8 1.2"/><circle cx="8" cy="11.2" r=".55" fill="currentColor" stroke="none"/>'
  var ICONS = {
    waiting: SVG_OPEN + '<circle cx="8" cy="8" r="6.2"/>' + QUESTION + '</svg>',
    permission: SVG_OPEN + '<circle cx="8" cy="8" r="6.2"/>' + QUESTION + '</svg>',
    blocked: SVG_OPEN + '<circle cx="8" cy="8" r="6.2"/><path d="M8 4.7v3.7"/><circle cx="8" cy="11" r=".55" fill="currentColor" stroke="none"/></svg>',
    failed: SVG_OPEN + '<circle cx="8" cy="8" r="6.2"/><path d="M5.7 5.7l4.6 4.6M10.3 5.7l-4.6 4.6"/></svg>',
    unconfirmed: SVG_OPEN + '<circle cx="8" cy="8" r="6.2" stroke-dasharray="2.6 2.2"/><path d="M6.6 6.5a1.5 1.5 0 1 1 2.1 1.4c-.4.2-.6.5-.6.9" stroke-width="1.3"/><circle cx="8.1" cy="10.8" r=".5" fill="currentColor" stroke="none"/></svg>',
    working: SVG_OPEN + '<circle cx="8" cy="8" r="6.2" opacity=".25"/><path d="M8 1.8a6.2 6.2 0 0 1 6.2 6.2"/></svg>',
    monitoring: SVG_OPEN + '<path d="M1.6 8h3l1.8-4.6 3.2 9.2 1.8-4.6h3"/></svg>',
    interrupted: SVG_OPEN + '<circle cx="8" cy="8" r="6.2"/><rect x="5.6" y="5.6" width="4.8" height="4.8" rx="1" fill="currentColor" stroke="none"/></svg>',
    unverifiable: SVG_OPEN + '<circle cx="8" cy="8" r="6.2" stroke-dasharray="2.6 2.2"/><path d="M8 5v3.2l2 1.2"/></svg>',
    done: SVG_OPEN + '<circle cx="8" cy="8" r="6.2"/><path d="M5.2 8.2l2 2 3.7-4"/></svg>',
    idle: SVG_OPEN + '<circle cx="8" cy="8" r="3.4"/></svg>'
  }
  var BELL =
    '<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M8 1.5a4 4 0 0 0-4 4v2.3L2.7 10.4a.6.6 0 0 0 .5.9h9.6a.6.6 0 0 0 .5-.9L12 7.8V5.5a4 4 0 0 0-4-4Z"/><path d="M6.5 12.6a1.5 1.5 0 0 0 3 0Z"/></svg>'

  // ---- small helpers ------------------------------------------------------------------------

  /** `now`, `5m`, `3h`, `2d`: coarse, floored, no "ago", like Orca's Activity list. */
  function timeText(sortAt, now) {
    if (typeof sortAt !== 'number' || !isFinite(sortAt) || sortAt <= 0) return ''
    var minutes = Math.floor(Math.max(0, now - sortAt) / 60000)
    if (minutes < 1) return 'now'
    if (minutes < 60) return minutes + 'm'
    var hours = Math.floor(minutes / 60)
    if (hours < 24) return hours + 'h'
    return Math.floor(hours / 24) + 'd'
  }

  function absoluteTime(ms) {
    try {
      return new Date(ms).toLocaleString()
    } catch (e) {
      return ''
    }
  }

  function make(tag, className, text) {
    var node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined && text !== null) node.textContent = text
    return node
  }

  function glyph(status) {
    var span = make('span', 'glyph tone-' + (TONES[status] || 'muted') + (status === 'working' ? ' spin' : ''))
    span.innerHTML = ICONS[status] || ICONS.idle // static markup from the table above
    return span
  }

  // ---- state and rendering ------------------------------------------------------------------

  var state = { model: null, workerDown: false, note: '', noteIsError: false }
  var els = {}
  var noteTimer = null
  var plugin = null
  // A click highlights its row at once; this remembers where the cursor was so a refused or failed
  // switch can put it back. Cleared as soon as the worker sends a model (the worker is the truth).
  var focusPending = null
  // The model request is single: one in flight at most, and at most one retry timer.
  var loading = false
  var retryTimer = null

  function rowsByKey(model) {
    var map = {}
    for (var i = 0; i < model.rows.length; i++) map[model.rows[i].paneKey] = model.rows[i]
    return map
  }

  function subline(row, mode) {
    var parts = []
    if (mode === 'worktree') {
      parts.push(row.statusLabel)
    } else {
      parts.push(row.branch ? row.worktreeName + ' / ' + row.branch : row.worktreeName)
    }
    parts.push(row.agentType)
    if (row.isChild) parts.push('sub-agent')
    return parts.join(' · ')
  }

  function renderRow(row, mode, now, cursor) {
    var button = make('button', 'row')
    button.type = 'button'
    button.setAttribute('data-pane', row.paneKey)
    if (row.unread) button.classList.add('is-unread')
    if (cursor === row.paneKey) {
      button.classList.add('is-cursor')
      button.setAttribute('aria-current', 'true')
    }
    // A row Orca listed no terminal for at the last refresh is dimmed but still clickable: the
    // worker looks the terminal up again when the row is clicked, and it is often there by then.
    var listed = Boolean(row.handle)
    if (!listed) button.classList.add('is-unlisted')
    var tip = row.title + '\n' + row.statusLabel + (listed ? '' : '\nOrca lists no terminal for this agent right now. Clicking looks again.')
    button.title = tip
    button.setAttribute('aria-label', row.title + ', ' + row.statusLabel + (row.unread ? ', unread' : ''))

    button.appendChild(glyph(row.status))

    var main = make('span', 'row-main')
    main.appendChild(make('span', 'row-title', row.title))
    main.appendChild(make('span', 'row-meta', subline(row, mode)))
    button.appendChild(main)

    var side = make('span', 'row-side')
    if (row.unread) {
      var bell = make('span', 'bell')
      bell.innerHTML = BELL // static markup
      bell.title = 'Unread'
      side.appendChild(bell)
    }
    var time = make('time', null, timeText(row.sortAt, now))
    time.setAttribute('data-sort-at', String(row.sortAt))
    time.title = absoluteTime(row.sortAt)
    side.appendChild(time)
    button.appendChild(side)
    return button
  }

  // ---- collapsed groups -----------------------------------------------------------------------

  // Groups the person folded, by `kind:key` (a status or a worktree), kept in this panel's own
  // storage so they stay folded across reloads. Storage may be missing or throw: then folding
  // still works, it is just forgotten.
  var COLLAPSED_KEY = 'agent-roster.collapsed'
  var collapsed = (function () {
    try {
      var list = JSON.parse(window.localStorage.getItem(COLLAPSED_KEY) || '[]')
      return Array.isArray(list) ? list.filter(function (k) { return typeof k === 'string' }) : []
    } catch (e) {
      return []
    }
  })()

  function groupId(group) {
    return group.kind + ':' + group.key
  }

  function toggleGroup(id) {
    var at = collapsed.indexOf(id)
    if (at >= 0) collapsed.splice(at, 1)
    else collapsed.push(id)
    try {
      window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify(collapsed))
    } catch (e) {
      // not kept, still folded for now
    }
    render()
    var heads = els.list.querySelectorAll('.group-head')
    for (var i = 0; i < heads.length; i++) {
      if (heads[i].getAttribute('data-group') === id) heads[i].focus({ preventScroll: true })
    }
  }

  var CHEVRON = '<svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 4l4 4-4 4"/></svg>'

  function renderGroup(group, byKey, mode, now, cursor) {
    var section = make('section', 'group')
    var id = groupId(group)
    var folded = collapsed.indexOf(id) >= 0
    if (folded) section.classList.add('is-collapsed')
    var head = make('button', 'group-head')
    head.type = 'button'
    head.setAttribute('data-group', id)
    head.setAttribute('aria-expanded', String(!folded))
    head.title = folded ? 'Show these agents' : 'Hide these agents'
    var chevron = make('span', 'chevron')
    chevron.innerHTML = CHEVRON // static markup
    head.appendChild(chevron)
    head.appendChild(make('h2', 'group-name', group.label))
    head.appendChild(make('span', 'badge', String(group.paneKeys.length)))
    if (group.kind === 'worktree') {
      if (group.isActive) head.appendChild(make('span', 'pill', 'current'))
      if (group.subtitle) head.appendChild(make('span', 'group-sub', group.subtitle))
    }
    section.appendChild(head)
    if (folded) return section // a folded group keeps its count, but draws no rows
    var list = make('ul', 'rows')
    for (var i = 0; i < group.paneKeys.length; i++) {
      var row = byKey[group.paneKeys[i]]
      if (!row) continue
      var item = make('li')
      item.appendChild(renderRow(row, mode, now, cursor))
      list.appendChild(item)
    }
    section.appendChild(list)
    return section
  }

  function focusedPane() {
    var active = document.activeElement
    return active && active.getAttribute ? active.getAttribute('data-pane') : null
  }

  function restoreFocus(paneKey) {
    if (!paneKey) return
    var buttons = els.list.querySelectorAll('.row')
    for (var i = 0; i < buttons.length; i++) {
      if (buttons[i].getAttribute('data-pane') === paneKey) {
        buttons[i].focus({ preventScroll: true })
        return
      }
    }
  }

  function render() {
    var model = state.model
    var mode = model && model.settings && model.settings.groupBy === 'worktree' ? 'worktree' : 'status'
    var buttons = els.seg.querySelectorAll('button')
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].setAttribute('aria-pressed', String(buttons[i].getAttribute('data-mode') === mode))
    }

    // The note line: a worker or CLI problem wins over a transient message.
    var message = ''
    var isError = false
    if (state.workerDown) {
      message = 'Agent Roster worker not reachable, retrying'
      isError = true
    } else if (model && model.error) {
      message = model.error
      isError = true
      els.note.title = model.errorDetail || ''
    } else if (state.note) {
      message = state.note
      isError = state.noteIsError
      els.note.title = ''
    } else if (model && model.capped) {
      // The worker kept the post small: say that the list is not complete.
      message = 'Showing ' + model.capped.shown + ' of ' + model.capped.total + ' agents'
      els.note.title = ''
    }
    els.note.textContent = message
    els.note.hidden = message === ''
    els.note.classList.toggle('is-error', isError)

    var keepFocus = focusedPane()
    var frag = document.createDocumentFragment()
    if (!model) {
      frag.appendChild(make('p', 'empty', state.workerDown ? '' : 'Loading agents…'))
    } else if (model.rows.length === 0) {
      frag.appendChild(make('p', 'empty', 'No agents running. Start Claude Code or Codex in a worktree and it will show up here.'))
    } else {
      var byKey = rowsByKey(model)
      var groups = (model.groups && model.groups[mode]) || []
      var now = Date.now()
      for (var g = 0; g < groups.length; g++) frag.appendChild(renderGroup(groups[g], byKey, mode, now, model.cursor))
    }
    els.list.replaceChildren(frag)
    els.list.setAttribute('aria-busy', model ? 'false' : 'true')
    restoreFocus(keepFocus)
  }

  function apply(model) {
    if (!model || !Array.isArray(model.rows) || !model.groups) return
    state.model = model
    state.workerDown = false
    focusPending = null
    render()
  }

  function setNote(text, isError) {
    state.note = text
    state.noteIsError = Boolean(isError)
    if (noteTimer) clearTimeout(noteTimer)
    noteTimer = text
      ? setTimeout(function () {
          state.note = ''
          render()
        }, 6000)
      : null
    render()
  }

  /** Refreshes the "5m" texts in place, so focus and scroll stay where they are. */
  function tickTimes() {
    var nodes = els.list.querySelectorAll('time[data-sort-at]')
    var now = Date.now()
    for (var i = 0; i < nodes.length; i++) nodes[i].textContent = timeText(Number(nodes[i].getAttribute('data-sort-at')), now)
  }

  // ---- talking to the worker ----------------------------------------------------------------

  function workerDown() {
    state.workerDown = true
    render()
  }

  function clearRetry() {
    if (retryTimer !== null) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
  }

  function load() {
    if (loading) return
    clearRetry()
    loading = true
    plugin.request('roster.list', {}, { timeoutMs: 20000 }).then(
      function (model) {
        loading = false
        clearRetry()
        apply(model)
      },
      function () {
        loading = false
        workerDown()
        // Retry every 3 s while the panel is on screen; a hidden panel loads again when it is shown.
        if (retryTimer === null && document.visibilityState !== 'hidden') {
          retryTimer = setTimeout(function () {
            retryTimer = null
            load()
          }, 3000)
        }
      }
    )
  }

  function refresh() {
    els.refresh.classList.add('busy')
    plugin
      .request('roster.refresh', {}, { timeoutMs: 30000 })
      .then(apply, workerDown)
      .then(function () {
        els.refresh.classList.remove('busy')
      })
  }

  function setGroup(mode) {
    if (state.model) {
      state.model.settings = Object.assign({}, state.model.settings, { groupBy: mode })
      render() // switch at once; both groupings are already in the model
    }
    plugin.request('roster.setGroup', { mode: mode }, { timeoutMs: 10000 }).then(function (res) {
      if (res && res.ok && res.model) apply(res.model)
    }, workerDown)
  }

  function focusRow(paneKey) {
    var model = state.model
    if (!model) return
    var row = rowsByKey(model)[paneKey]
    if (!row) return
    var mine = { paneKey: paneKey, previous: model.cursor }
    focusPending = mine
    model.cursor = paneKey // optimistic; the worker's update confirms or corrects it
    render()
    plugin.request('roster.focus', { paneKey: paneKey }, { timeoutMs: 20000 }).then(
      function (res) {
        if (res && res.ok === false) {
          undoOptimisticCursor(mine)
          setNote(res.reason || 'Could not switch to that agent.', true)
        } else if (focusPending === mine) {
          focusPending = null
        }
      },
      function () {
        undoOptimisticCursor(mine)
        workerDown()
      }
    )
  }

  /** Puts the cursor back, unless the worker has sent a model since the click (then it already decided). */
  function undoOptimisticCursor(mine) {
    if (focusPending !== mine) return
    focusPending = null
    if (state.model && state.model.cursor === mine.paneKey) {
      state.model.cursor = mine.previous
      render()
    }
  }

  // ---- keyboard and wiring ------------------------------------------------------------------

  function onListKeydown(event) {
    var key = event.key
    if (key !== 'ArrowDown' && key !== 'ArrowUp' && key !== 'Home' && key !== 'End') return
    var buttons = Array.prototype.slice.call(els.list.querySelectorAll('.row'))
    if (buttons.length === 0) return
    var index = buttons.indexOf(document.activeElement)
    var next = index
    if (key === 'ArrowDown') next = Math.min(buttons.length - 1, index + 1)
    else if (key === 'ArrowUp') next = Math.max(0, index < 0 ? 0 : index - 1)
    else if (key === 'Home') next = 0
    else next = buttons.length - 1
    event.preventDefault()
    buttons[next].focus()
  }

  function start() {
    els.list = document.getElementById('list')
    els.note = document.getElementById('note')
    els.refresh = document.getElementById('refresh')
    els.seg = document.querySelector('.seg')

    var bridge = window.orca
    if (!bridge || !bridge.plugin) {
      els.list.replaceChildren(make('p', 'empty', 'Agent Roster runs inside Orca. Open it from the right sidebar.'))
      return
    }
    plugin = bridge.plugin

    els.list.addEventListener('click', function (event) {
      var target = event.target
      var toggle = target && target.closest ? target.closest('.group-head') : null
      if (toggle) {
        toggleGroup(toggle.getAttribute('data-group'))
        return
      }
      var button = target && target.closest ? target.closest('.row') : null
      if (button) focusRow(button.getAttribute('data-pane'))
    })
    els.list.addEventListener('keydown', onListKeydown)
    els.refresh.addEventListener('click', refresh)
    els.seg.addEventListener('click', function (event) {
      var target = event.target
      var button = target && target.closest ? target.closest('button[data-mode]') : null
      if (button) setGroup(button.getAttribute('data-mode'))
    })

    // Posts are fire and forget, so a panel opened later never saw earlier ones: ask first.
    plugin.on('roster.update', apply)
    load()
    setInterval(tickTimes, 30000)
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') load()
      else clearRetry()
    })
  }

  if (typeof module === 'object' && module && module.exports) {
    // Loaded by the tests, outside a browser.
    module.exports = { timeText: timeText, TONES: TONES, ICONS: ICONS }
  } else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start)
  } else {
    start()
  }
})()
