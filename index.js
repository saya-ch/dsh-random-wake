/**
 * dsh-random-wake — host half.
 *
 * Manages a LIST of targets. Each target is one existing session plus its own
 * externally decided rhythm. Every decision that matters — when, and whether at
 * all — is made here, in code, never by a model:
 *
 *   interval  : base period + random jitter (uniform, computed here)
 *   gate      : quiet hours -> daily cap -> cooldown -> random draw (probability)
 *   idle guard: skip while the target session is still busy with recent activity
 *
 * When the gate says no, no model is called at all: the tick only re-arms the
 * next attempt for THAT target. Sessions that were never added as targets are
 * never touched: the plugin holds no reference to them and runs no timer on
 * them.
 *
 * The wake message is a user-role notice (form:"notice"), so the GUI renders it
 * as a chip instead of a fake user bubble.
 *
 * State lives in <dsh home>/random-wake/config.json.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'dsh-random-wake'
export const inject = ['connection', 'agents']

const PLUGIN = 'dsh-random-wake'
const API = '/api/random-wake'
const TICK_MS = 5_000
const HISTORY_MAX = 20

const DEFAULTS = {
  enabled: false,
  sessionId: '',
  label: '',
  intervalMinutes: 30,
  jitterPct: 20,
  probabilityPct: 40,
  quietStart: '01:00',
  quietEnd: '08:00',
  maxPerDay: 6,
  cooldownMinutes: 30,
  idleGuardMinutes: 0,
  prompt:
    '没什么事发生，是你自己忽然想起了他。想说什么就自然开口，' +
    '不想说就安静结束本回合，不要输出任何文字。',
}

function homeDir() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv
  return join(homedir(), '.dsh')
}

function statePath() {
  return join(homeDir(), 'random-wake', 'config.json')
}

const digits = (n, w = 2) => String(n).padStart(w, '0')

function localDateKey(d) {
  return `${d.getFullYear()}-${digits(d.getMonth() + 1)}-${digits(d.getDate())}`
}

function minutesOfDay(d) {
  return d.getHours() * 60 + d.getMinutes()
}

function parseHm(text, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? '').trim())
  if (!m) return fallback
  const h = Number(m[1])
  const mi = Number(m[2])
  if (!Number.isInteger(h) || !Number.isInteger(mi) || h > 23 || mi > 59) return fallback
  return h * 60 + mi
}

/** Inclusive-start, exclusive-end window; a window whose start > end wraps midnight. */
function inQuietHours(now, target) {
  const start = parseHm(target.quietStart, -1)
  const end = parseHm(target.quietEnd, -1)
  if (start < 0 || end < 0 || start === end) return false
  const t = minutesOfDay(now)
  return start < end ? t >= start && t < end : t >= start || t < end
}

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  const v = Math.round(n)
  if (v < min) return min
  if (v > max) return max
  return v
}

function newId() {
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

function normalizeTarget(raw, fallbackId) {
  const merged = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) }
  const id = typeof merged.id === 'string' && merged.id.trim() !== '' ? merged.id.trim() : (fallbackId || newId())
  return {
    id,
    label: typeof merged.label === 'string' ? merged.label : '',
    sessionId: typeof merged.sessionId === 'string' ? merged.sessionId.trim() : '',
    enabled: merged.enabled === true,
    intervalMinutes: clampInt(merged.intervalMinutes, 1, 1440, DEFAULTS.intervalMinutes),
    jitterPct: clampInt(merged.jitterPct, 0, 100, DEFAULTS.jitterPct),
    probabilityPct: clampInt(merged.probabilityPct, 0, 100, DEFAULTS.probabilityPct),
    quietStart: String(merged.quietStart ?? DEFAULTS.quietStart),
    quietEnd: String(merged.quietEnd ?? DEFAULTS.quietEnd),
    maxPerDay: clampInt(merged.maxPerDay, 0, 999, DEFAULTS.maxPerDay),
    cooldownMinutes: clampInt(merged.cooldownMinutes, 0, 1440, DEFAULTS.cooldownMinutes),
    idleGuardMinutes: clampInt(merged.idleGuardMinutes, 0, 1440, DEFAULTS.idleGuardMinutes),
    prompt: typeof merged.prompt === 'string' ? merged.prompt : DEFAULTS.prompt,
  }
}

function readState() {
  try {
    const raw = readFileSync(statePath(), 'utf8')
    const parsed = JSON.parse(raw)
    // v0.1 stored a single target at the top level; fold it into the list form.
    if (parsed && Array.isArray(parsed.targets)) {
      return { targets: parsed.targets.map((t, i) => normalizeTarget(t, `t-${i}`)) }
    }
    if (parsed && typeof parsed === 'object' && typeof parsed.sessionId === 'string' && parsed.sessionId !== '') {
      return { targets: [normalizeTarget(parsed)] }
    }
    return { targets: [] }
  } catch {
    return { targets: [] }
  }
}

function writeState(state) {
  try {
    mkdirSync(join(homeDir(), 'random-wake'), { recursive: true })
    writeFileSync(statePath(), JSON.stringify({ targets: state.targets }, null, 2), 'utf8')
    return true
  } catch {
    return false
  }
}

export function apply(ctx) {
  let state = readState()

  /** Optional services: the panel degrades to showing raw ids when absent. */
  const titleService = (() => {
    try {
      return ctx.get('sessionTitle', false)
    } catch {
      return undefined
    }
  })()
  const persistence = (() => {
    try {
      return ctx.get('sessionPersistence', false)
    } catch {
      return undefined
    }
  })()

  /** sessionId -> { title, at }; cold sessions cost one log read per TTL. */
  const titleCache = new Map()
  const TITLE_TTL_MS = 60_000

  function foldTitleFromEvents(events) {
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]
      if (event && event.type === 'session/title') {
        const value = event.data && event.data.title
        if (typeof value === 'string' && value.trim() !== '') return value
        return null
      }
    }
    return null
  }

  async function titleOf(sessionId) {
    const live = agentOf(sessionId)
    if (live !== undefined) {
      try {
        const current = titleService?.get?.(live.session)
        if (current && typeof current.title === 'string' && current.title.trim() !== '') {
          titleCache.set(sessionId, { title: current.title, at: Date.now() })
          return current.title
        }
      } catch {
        /* fall through to the log fold */
      }
    }
    const cached = titleCache.get(sessionId)
    if (cached !== undefined && Date.now() - cached.at < TITLE_TTL_MS) return cached.title
    if (persistence === undefined) return cached?.title ?? null
    try {
      const reader = await persistence.open(sessionId, 'read')
      try {
        const slice = reader.read()
        const events = slice && Array.isArray(slice.events) ? slice.events : []
        const title = foldTitleFromEvents(events)
        titleCache.set(sessionId, { title, at: Date.now() })
        return title
      } finally {
        try {
          reader.close()
        } catch {
          /* a close failure must not hide the title we just read */
        }
      }
    } catch {
      return cached?.title ?? null
    }
  }

  /** id -> per-target runtime (never persisted; re-armed on load/restart) */
  const runtime = new Map()

  function rtOf(id) {
    let rt = runtime.get(id)
    if (rt === undefined) {
      rt = {
        at: 0,
        todayKey: localDateKey(new Date()),
        todayCount: 0,
        lastFireAt: 0,
        lastOutcome: 'never',
        lastReason: '',
        history: [],
      }
      runtime.set(id, rt)
    }
    return rt
  }

  function jitterMs(target) {
    const base = target.intervalMinutes * 60_000
    const pct = clampInt(target.jitterPct, 0, 100, 0)
    if (pct <= 0) return base
    return base * (1 + (Math.random() * 2 - 1) * (pct / 100))
  }

  function armNext(target, fromMs, reason) {
    const rt = rtOf(target.id)
    rt.at = Math.round(fromMs + jitterMs(target))
    rt.lastReason = reason
  }

  function rollToday(target, now) {
    const rt = rtOf(target.id)
    const key = localDateKey(now)
    if (key !== rt.todayKey) {
      rt.todayKey = key
      rt.todayCount = 0
    }
  }

  function pushHistory(rt, entry) {
    rt.history.unshift(entry)
    if (rt.history.length > HISTORY_MAX) rt.history.length = HISTORY_MAX
  }

  function decide(target, now) {
    if (!target.enabled) return { fire: false, reason: 'disabled' }
    if (target.sessionId === '') return { fire: false, reason: 'no-target-session' }
    if (inQuietHours(now, target)) return { fire: false, reason: 'quiet-hours' }
    const rt = rtOf(target.id)
    if (rt.todayCount >= clampInt(target.maxPerDay, 0, 999, 6)) {
      return { fire: false, reason: 'daily-cap' }
    }
    const cooldownMs = clampInt(target.cooldownMinutes, 0, 1440, 0) * 60_000
    if (rt.lastFireAt > 0 && now - rt.lastFireAt < cooldownMs) {
      return { fire: false, reason: 'cooldown' }
    }
    const pct = clampInt(target.probabilityPct, 0, 100, 100)
    if (Math.floor(Math.random() * 100) >= pct) return { fire: false, reason: 'probability' }
    return { fire: true }
  }

  function buildMessage(target) {
    const now = new Date()
    const text = [
      `[self-wake ${localDateKey(now)} ${digits(now.getHours())}:${digits(now.getMinutes())}]`,
      'This is not a message from the user. You woke up on your own — something crossed your mind and you felt like saying it.',
      target.prompt,
    ].join('\n')
    return {
      role: 'user',
      content: [{ type: 'text', text }],
      source: {
        kind: `plugin:${PLUGIN}`,
        form: 'notice',
        summary: '自己想起',
      },
    }
  }

  function agentOf(sessionId) {
    try {
      return ctx.agents.get(sessionId)
    } catch {
      return undefined
    }
  }

  function targetBusy(agent) {
    if (agent === undefined) return false
    try {
      if (typeof ctx.agents.turnBoundaryOf !== 'function') return false
      const boundary = ctx.agents.turnBoundaryOf(agent.session)
      return boundary !== undefined && boundary.openTurnStartSeq !== null
    } catch {
      return false
    }
  }

  async function fire(target, manual) {
    const sessionId = String(target.sessionId || '').trim()
    if (sessionId === '') return { ok: false, reason: 'no-target-session' }

    const idleGuard = clampInt(target.idleGuardMinutes, 0, 1440, 0) * 60_000
    let agent = agentOf(sessionId)
    let handle = null
    try {
      if (agent !== undefined && targetBusy(agent)) {
        return { ok: false, reason: 'target-busy' }
      }
      if (agent === undefined) {
        handle = await ctx.agents.resume({ resumeSessionId: sessionId })
        agent = handle.agent
      }
      if (idleGuard > 0 && manual !== true) {
        try {
          const events = agent.session.snapshotEvents()
          const last = events.length > 0 ? events[events.length - 1] : undefined
          const lastAt = last && typeof last.time === 'number' ? last.time : 0
          if (lastAt > 0 && Date.now() - lastAt < idleGuard) {
            return { ok: false, reason: 'idle-guard' }
          }
        } catch {
          /* an unreadable log must not block the wake */
        }
      }
      const message = buildMessage(target)
      const claimed = await agent.runMaintenance(() => {
        agent.followup(message)
        return Promise.resolve(true)
      })
      if (!claimed) return { ok: false, reason: 'busy' }
      await agent.whenIdle()
      return { ok: true, manual: manual === true }
    } catch (error) {
      return { ok: false, reason: 'error', error: String(error && error.message ? error.message : error) }
    } finally {
      try {
        if (handle !== null) handle.dispose()
      } catch {
        /* disposal failure must not surface as a wake failure */
      }
    }
  }

  const firing = new Set()

  async function tickTarget(target) {
    if (firing.has(target.id)) return
    const rt = rtOf(target.id)
    const now = Date.now()
    if (!target.enabled) return
    if (now < rt.at) return
    rollToday(target, new Date(now))
    const verdict = decide(target, new Date(now))
    if (!verdict.fire) {
      rt.lastOutcome = 'skipped'
      rt.lastReason = verdict.reason
      pushHistory(rt, { at: now, ok: false, reason: verdict.reason })
      armNext(target, now, verdict.reason)
      return
    }
    firing.add(target.id)
    try {
      const result = await fire(target, false)
      rt.lastOutcome = result.ok ? 'fired' : 'failed'
      rt.lastReason = result.ok ? 'ok' : String(result.reason)
      if (result.ok) {
        rt.lastFireAt = now
        rt.todayCount += 1
      }
      pushHistory(rt, { at: now, ok: result.ok === true, reason: rt.lastReason })
    } finally {
      firing.delete(target.id)
      armNext(target, Date.now(), 'after-fire')
    }
  }

  async function tick() {
    for (const target of state.targets) {
      try {
        await tickTarget(target)
      } catch {
        /* one broken target must never stop the others */
      }
    }
  }

  // Arm every enabled target once at load.
  for (const target of state.targets) {
    if (target.enabled) armNext(target, Date.now(), 'startup')
  }

  ctx.effect(() => {
    const timer = setInterval(() => {
      void tick()
    }, TICK_MS)
    return () => clearInterval(timer)
  }, `${PLUGIN}: ticker`)

  async function snapshotTarget(target) {
    const rt = rtOf(target.id)
    const now = Date.now()
    return {
      ...target,
      title: await titleOf(target.sessionId),
      runtime: {
        at: rt.at,
        inMs: Math.max(0, rt.at - now),
        todayKey: rt.todayKey,
        todayCount: rt.todayCount,
        lastFireAt: rt.lastFireAt,
        lastOutcome: rt.lastOutcome,
        lastReason: rt.lastReason,
        history: rt.history.slice(0, 12),
        ticking: firing.has(target.id),
      },
    }
  }

  async function snapshot() {
    return {
      targets: await Promise.all(state.targets.map(snapshotTarget)),
      statePath: statePath(),
      now: Date.now(),
    }
  }

  function json(value, status = 200) {
    return new Response(JSON.stringify(value), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    })
  }

  function admitted(request) {
    try {
      const admission = ctx.connection.admit({ headers: request.headers })
      return !(admission && 'rejection' in admission)
    } catch {
      return false
    }
  }

  function findTarget(id) {
    return state.targets.find((t) => t.id === id)
  }

  async function handleTargets(request) {
    if (!admitted(request)) return json({ error: 'forbidden' }, 403)
    let body = {}
    try {
      body = await request.json()
    } catch {
      return json({ error: 'bad-json' }, 400)
    }
    const op = body && typeof body.op === 'string' ? body.op : ''

    if (op === 'add') {
      const raw = body.target && typeof body.target === 'object' ? body.target : {}
      const target = normalizeTarget(raw, undefined)
      if (target.sessionId === '') return json({ error: 'no-target-session', ...(await snapshot()) }, 400)
      const exists = state.targets.some((t) => t.sessionId === target.sessionId)
      if (exists) return json({ error: 'already-managed', ...(await snapshot()) }, 409)
      // The note is a snapshot of the session title AT ADD TIME: it is the
      // user's own label from then on, so a later rename never moves it.
      if (String(target.label || '').trim() === '') {
        target.label = (await titleOf(target.sessionId)) || ''
      }
      state.targets.push(target)
      writeState(state)
      if (target.enabled) armNext(target, Date.now(), 'added')
      return json(await snapshot())
    }

    if (op === 'update') {
      const raw = body.target && typeof body.target === 'object' ? body.target : {}
      const index = state.targets.findIndex((t) => t.id === raw.id)
      if (index < 0) return json({ error: 'unknown-target', ...(await snapshot()) }, 404)
      const previous = state.targets[index]
      const next = normalizeTarget({ ...previous, ...raw }, previous.id)
      const wasEnabled = previous.enabled
      state.targets[index] = next
      writeState(state)
      if (next.enabled && !wasEnabled) armNext(next, Date.now(), 'enabled')
      if (!next.enabled) rtOf(next.id).at = 0
      if (next.enabled && wasEnabled && (raw.intervalMinutes !== undefined || raw.jitterPct !== undefined)) {
        armNext(next, Date.now(), 'config')
      }
      return json(await snapshot())
    }

    if (op === 'remove') {
      const id = typeof body.id === 'string' ? body.id : ''
      const removed = findTarget(id)
      const before = state.targets.length
      state.targets = state.targets.filter((t) => t.id !== id)
      if (state.targets.length === before) return json({ error: 'unknown-target', ...(await snapshot()) }, 404)
      runtime.delete(id)
      if (removed !== undefined) titleCache.delete(removed.sessionId)
      writeState(state)
      return json(await snapshot())
    }

    if (op === 'fire') {
      const target = findTarget(typeof body.id === 'string' ? body.id : '')
      if (target === undefined) return json({ error: 'unknown-target', ...(await snapshot()) }, 404)
      const result = await fire(target, true)
      const rt = rtOf(target.id)
      if (result.ok) {
        rt.lastFireAt = Date.now()
        rt.todayCount += 1
        rt.lastOutcome = 'fired-manual'
        rt.lastReason = 'ok'
        pushHistory(rt, { at: Date.now(), ok: true, reason: 'manual' })
      } else {
        rt.lastOutcome = 'failed-manual'
        rt.lastReason = String(result.reason)
        pushHistory(rt, { at: Date.now(), ok: false, reason: `manual:${result.reason}` })
      }
      return json({ result, snapshot: await snapshot() })
    }

    return json({ error: 'unknown-op', ...(await snapshot()) }, 400)
  }

  ctx.effect(() => {
    const dispose = ctx.connection.fetch.register({
      path: `${API}/state`,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request) => {
        if (!admitted(request)) return json({ error: 'forbidden' }, 403)
        return json(await snapshot())
      },
    })
    return () => {
      void dispose()
    }
  }, `${PLUGIN}: state route`)

  ctx.effect(() => {
    const dispose = ctx.connection.fetch.register({
      path: `${API}/targets`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => handleTargets(request),
    })
    return () => {
      void dispose()
    }
  }, `${PLUGIN}: targets route`)

  ctx.logger?.info?.(`[${PLUGIN}] ready (${state.targets.length} target(s), state=${statePath()})`)
}

