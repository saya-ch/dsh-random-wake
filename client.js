/**
 * dsh-random-wake — browser half.
 *
 * A right-sidebar tab that manages a LIST of sessions, each with its own
 * external rhythm and probability gate. Sessions that were never added here
 * are not touched by anything in this plugin.
 *
 * Layout note: anything structural (grids, flex rows, toggle geometry) is
 * expressed as inline style so it survives even if the injected stylesheet is
 * replaced or deduped by the host. The stylesheet only supplies colour and
 * polish from DSH's own alias tokens.
 */
window.__ModuleLoader__.load({
  id: 'dsh-random-wake',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const NS = 'dshRandomWake'
    const TAB_ID = 'dsh-random-wake/panel'
    const TAB_KIND = 'random-wake'
    const STYLE_ID = 'dwg-style-v3'
    const API = '/api/random-wake'
    const STATE_URL = `${API}/state`
    const TARGETS_URL = `${API}/targets`

    const en = {
      title: 'Wake gate',
      description: 'Wake managed sessions on an external rhythm',
      add: 'Add',
      addHint: 'Paste a session ID',
      useCurrent: 'Use current',
      empty: 'Nothing managed yet',
      emptyHint: 'Add a session above. Sessions you never add are never woken.',
      enable: 'On',
      edit: 'Settings',
      collapse: 'Hide',
      remove: 'Remove',
      save: 'Save',
      fireNow: 'Fire',
      nextIn: 'Next',
      today: 'Today',
      last: 'Last',
      interval: 'Interval',
      intervalUnit: 'min',
      jitter: 'Jitter',
      probability: 'Chance',
      quiet: 'Quiet hours',
      maxPerDay: 'Daily cap',
      cooldown: 'Cooldown',
      idleGuard: 'Idle guard',
      prompt: 'Wake message',
      saved: 'Saved',
      working: 'Working…',
      label: 'Label',
      presets: 'Rhythm presets',
      presetHint: 'Pick a preset to swap the whole timing set and save it at once.',
      target: 'Target session',
    }
    const zh = {
      title: '随机唤醒',
      description: '按外部节律唤醒受管理的会话',
      add: '添加',
      addHint: '粘贴会话 ID',
      useCurrent: '用当前会话',
      empty: '还没有受管理的会话',
      emptyHint: '在上面添加一个会话。没有加进来的会话永远不会被唤醒。',
      enable: '启用',
      edit: '参数',
      collapse: '收起',
      remove: '移出',
      save: '保存',
      fireNow: '立即触发',
      nextIn: '下次',
      today: '今日',
      last: '上次',
      interval: '间隔',
      intervalUnit: '分钟',
      jitter: '浮动',
      probability: '概率',
      quiet: '静默时段',
      maxPerDay: '每日上限',
      cooldown: '冷却',
      idleGuard: '闲置守卫',
      prompt: '唤醒消息',
      saved: '已保存',
      working: '处理中…',
      label: '备注名',
      presets: '节奏预设',
      presetHint: '选一个预设，整套时间参数一起换掉并立即保存。',
      target: '目标会话',
    }

    /**
     * Rhythm presets. Each is a whole answer to "how often would a person
     * really do this", so values are never picked in isolation:
     *   high jitter  -> no clock-like regularity
     *   low chance   -> most checks pass silently
     *   cooldown>gap -> never two messages back to back
     *   idle guard   -> waits until the other side is quiet
     *   quiet hours  -> never wakes them at night
     */
    const PRESETS = [
      {
        id: 'casual',
        name: { zh: '日常搭话', en: 'Casual' },
        hint: {
          zh: '一天最多 5 次，平均一两小时一次，多数检查都沉默。',
          en: 'Up to 5 a day, roughly every 1–2 hours; most checks stay silent.',
        },
        values: {
          intervalMinutes: 25, jitterPct: 40, probabilityPct: 25, maxPerDay: 5,
          cooldownMinutes: 35, idleGuardMinutes: 8, quietStart: '00:30', quietEnd: '08:30',
        },
      },
      {
        id: 'slow',
        name: { zh: '慢热', en: 'Slow burn' },
        hint: {
          zh: '一天最多 2 次，一小时起步，被拒也不追。',
          en: 'Two a day at most, an hour apart, never chasing.',
        },
        values: {
          intervalMinutes: 60, jitterPct: 50, probabilityPct: 15, maxPerDay: 2,
          cooldownMinutes: 60, idleGuardMinutes: 20, quietStart: '23:30', quietEnd: '09:00',
        },
      },
      {
        id: 'chatty',
        name: { zh: '话多', en: 'Chatty' },
        hint: {
          zh: '十几分钟看一眼，四成会说点什么，白天最多 12 次。',
          en: 'Checks every ~15 min, speaks ~40% of the time, 12 a day.',
        },
        values: {
          intervalMinutes: 15, jitterPct: 45, probabilityPct: 40, maxPerDay: 12,
          cooldownMinutes: 10, idleGuardMinutes: 3, quietStart: '02:00', quietEnd: '07:30',
        },
      },
      {
        id: 'night',
        name: { zh: '夜猫子', en: 'Night owl' },
        hint: {
          zh: '白天静默到中午，夜里活跃。',
          en: 'Silent until noon, alive at night.',
        },
        values: {
          intervalMinutes: 40, jitterPct: 35, probabilityPct: 30, maxPerDay: 4,
          cooldownMinutes: 30, idleGuardMinutes: 5, quietStart: '05:00', quietEnd: '12:00',
        },
      },
      {
        id: 'ritual',
        name: { zh: '早晚问候', en: 'Twice daily' },
        hint: {
          zh: '两小时一检查，六成会开口，但一天只给两次机会。',
          en: 'Checks every two hours, speaks 60% of the time, only twice a day.',
        },
        values: {
          intervalMinutes: 120, jitterPct: 25, probabilityPct: 60, maxPerDay: 2,
          cooldownMinutes: 120, idleGuardMinutes: 15, quietStart: '22:30', quietEnd: '07:00',
        },
      },
      {
        id: 'tea',
        name: { zh: '一杯茶', en: 'Tea break' },
        hint: {
          zh: '两三个小时才想起一次，一天三四次，很轻。',
          en: 'Think of you every 2–3 hours, three or four times a day at most.',
        },
        values: {
          intervalMinutes: 90, jitterPct: 45, probabilityPct: 35, maxPerDay: 4,
          cooldownMinutes: 90, idleGuardMinutes: 12, quietStart: '00:00', quietEnd: '09:00',
        },
      },
      {
        id: 'workday',
        name: { zh: '上班时段', en: 'Workday' },
        hint: {
          zh: '只在上班时间活动，晚上和周末不打扰；下班后自动沉默。',
          en: 'Alive only during the workday; silent through the evening.',
        },
        values: {
          intervalMinutes: 45, jitterPct: 30, probabilityPct: 30, maxPerDay: 6,
          cooldownMinutes: 40, idleGuardMinutes: 10, quietStart: '18:30', quietEnd: '09:30',
        },
      },
      {
        id: 'late',
        name: { zh: '深夜陪聊', en: 'Late night' },
        hint: {
          zh: '零点前后最活跃，两三点后收声。',
          en: 'Most alive around midnight, quiet after 2–3am.',
        },
        values: {
          intervalMinutes: 25, jitterPct: 50, probabilityPct: 45, maxPerDay: 8,
          cooldownMinutes: 15, idleGuardMinutes: 2, quietStart: '03:00', quietEnd: '13:00',
        },
      },
      {
        id: 'weekend',
        name: { zh: '周末闲散', en: 'Weekend lazy' },
        hint: {
          zh: '白天随意，间隔长；一天最多 6 次，不赶时间。',
          en: 'Loose daytime rhythm, long gaps, six a day at most.',
        },
        values: {
          intervalMinutes: 50, jitterPct: 60, probabilityPct: 35, maxPerDay: 6,
          cooldownMinutes: 45, idleGuardMinutes: 15, quietStart: '01:00', quietEnd: '10:00',
        },
      },
      {
        id: 'rare',
        name: { zh: '偶尔想起', en: 'Now and then' },
        hint: {
          zh: '一天最多一次，间隔三小时起，几乎不打扰。',
          en: 'Once a day at most, three hours apart, almost never bothers.',
        },
        values: {
          intervalMinutes: 180, jitterPct: 40, probabilityPct: 25, maxPerDay: 1,
          cooldownMinutes: 180, idleGuardMinutes: 30, quietStart: '22:00', quietEnd: '10:00',
        },
      },
      {
        id: 'burst',
        name: { zh: '一阵一阵', en: 'In bursts' },
        hint: {
          zh: '偶尔连说几句，然后长时间安静；浮动开到最大。',
          en: 'A few messages, then a long hush; widest jitter there is.',
        },
        values: {
          intervalMinutes: 20, jitterPct: 100, probabilityPct: 50, maxPerDay: 8,
          cooldownMinutes: 5, idleGuardMinutes: 2, quietStart: '02:30', quietEnd: '08:00',
        },
      },
    ]

    function presetById(id) {
      return PRESETS.find((preset) => preset.id === id)
    }

    /**
     * The alarm glyph is Lucide's `alarm-clock` (24x24, MIT), copied verbatim
     * from https://github.com/lucide-icons/lucide/blob/main/icons/alarm-clock.svg
     * — not hand-drawn. Only its colour is ours.
     */
    const ALARM_ACCENT = '#F2B01E'
    const ALARM_PATHS = [
      h('circle', { key: 'c', cx: 12, cy: 13, r: 8 }),
      h('path', { key: 'h', d: 'M12 9v4l2 2' }),
      h('path', { key: 'b1', d: 'M5 3 2 6' }),
      h('path', { key: 'b2', d: 'm22 6-3-3' }),
      h('path', { key: 'f1', d: 'M6.38 18.7 4 21' }),
      h('path', { key: 'f2', d: 'M17.64 18.67 20 21' }),
    ]

    /** Tab chip in the sidebar tab bar: small, inherits the chip's ink. */
    function AlarmGlyphInline({ size = 13 }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24',
        fill: 'none', stroke: 'currentColor',
        strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true',
        style: { flex: 'none', display: 'block' },
      }, ALARM_PATHS)
    }

    /** Guide entry + panel header: the amber alarm alone, no plate behind it. */
    function AlarmGlyphBadge({ size = 22 }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24',
        fill: 'none', stroke: ALARM_ACCENT,
        strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true',
        style: { flex: 'none', display: 'block' },
      }, ALARM_PATHS)
    }

    const REASON_TEXT = {
      'no-target-session': '没有目标会话',
      'target-busy': '目标正跑回合',
      'idle-guard': '还没安静够',
      busy: '目标正忙',
      error: '宿主报错',
      'quiet-hours': '静默时段',
      'daily-cap': '今日已达上限',
      cooldown: '冷却中',
      probability: '概率没抽中',
      disabled: '未启用',
      'already-managed': '这个会话已在列表里',
      'unknown-target': '目标不存在',
      ok: '成功',
    }

    function reasonText(reason) {
      if (!reason) return '—'
      const text = String(reason)
      if (text.startsWith('manual:')) return '手动 · ' + (REASON_TEXT[text.slice(7)] || text.slice(7))
      return REASON_TEXT[text] || text
    }

    function fmtIn(ms) {
      if (!ms || ms <= 0) return '—'
      const total = Math.round(ms / 1000)
      const m = Math.floor(total / 60)
      const s = total % 60
      if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`
      return m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`
    }

    function fmtTime(ms) {
      if (!ms) return '—'
      const d = new Date(ms)
      const p = (n) => String(n).padStart(2, '0')
      return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
    }

    function shortId(id) {
      const text = String(id || '')
      return text.length <= 28 ? text : `${text.slice(0, 15)}…${text.slice(-9)}`
    }

    async function readJson(res) {
      const text = await res.text()
      try {
        return { ok: res.ok, status: res.status, data: text === '' ? {} : JSON.parse(text) }
      } catch {
        return { ok: false, status: res.status, data: null, text }
      }
    }

    const CSS = `
      .dwg-root {
        font-family: var(--dsw-font-family, inherit);
        color: var(--dsw-alias-label-primary, inherit);
      }
      .dwg-card {
        border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.22));
        border-radius: 12px;
        background: var(--dsw-alias-bg-layer-1, transparent);
      }
      .dwg-title { font-weight: 600; font-size: 13px; }
      .dwg-sub { color: var(--dsw-alias-label-secondary, inherit); font-size: 11.5px; line-height: 1.5; }
      .dwg-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
      .dwg-label { color: var(--dsw-alias-label-secondary, inherit); font-size: 11.5px; }
      .dwg-input, .dwg-textarea, .dwg-select {
        box-sizing: border-box; padding: 6px 9px; border-radius: 8px;
        font: inherit; font-size: 12.5px;
        color: var(--dsw-alias-label-primary, inherit);
        background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.07));
        border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.28));
        outline: none; min-width: 0;
      }
      .dwg-input:focus, .dwg-textarea:focus {
        border-color: var(--dsw-alias-brand-primary, #4a7dff);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-brand-primary, #4a7dff) 18%, transparent);
      }
      .dwg-textarea { width: 100%; min-height: 62px; resize: vertical; line-height: 1.55; }
      .dwg-btn {
        padding: 5px 11px; border-radius: 8px; cursor: pointer;
        font: inherit; font-size: 12.5px; white-space: nowrap;
        color: var(--dsw-alias-label-primary, inherit);
        border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.3));
        background: transparent;
      }
      .dwg-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.1)); }
      .dwg-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #4a7dff); outline-offset: 1px; }
      .dwg-btn.primary {
        border-color: transparent;
        background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #4a7dff));
        color: var(--dsw-alias-label-primary-foreground, #fff);
      }
      .dwg-btn.ghost { border-color: transparent; color: var(--dsw-alias-label-secondary, inherit); }
      .dwg-btn.danger { border-color: transparent; color: var(--dsw-alias-state-error-primary, #d05555); }
      .dwg-btn.danger:hover:not(:disabled) {
        background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d05555) 12%, transparent);
      }
      .dwg-btn:disabled { opacity: .45; cursor: default; }
      .dwg-chip {
        padding: 4px 10px; border-radius: 999px; cursor: pointer;
        font: inherit; font-size: 12px; white-space: nowrap;
        color: var(--dsw-alias-label-secondary, inherit);
        border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.3));
        background: transparent;
      }
      .dwg-chip:hover { color: var(--dsw-alias-label-primary, inherit); background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.09)); }
      .dwg-chip.is-active {
        color: var(--dsw-alias-brand-primary, #4a7dff);
        border-color: color-mix(in srgb, var(--dsw-alias-brand-primary, #4a7dff) 55%, transparent);
        background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4a7dff) 10%, transparent);
      }
      .dwg-err {
        color: var(--dsw-alias-state-error-primary, #d05555);
        font-size: 12px; line-height: 1.5; padding: 7px 10px; border-radius: 8px;
        background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d05555) 10%, transparent);
      }
      .dwg-ok { color: var(--dsw-alias-state-success-primary, #2e9e5b); }
      .dwg-dim { color: var(--dsw-alias-label-secondary, inherit); }
      .dwg-sep { background: var(--dsw-alias-border-l1, rgba(127,127,127,.2)); opacity: .7; }
      .dwg-skel {
        background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.08));
        animation: dwgPulse 1.4s ease-in-out infinite;
      }
      @keyframes dwgPulse { 0%,100% { opacity:.5 } 50% { opacity:1 } }
      @media (prefers-reduced-motion: reduce) { .dwg-skel { animation: none; opacity: .7; } }
    `

    function useStyles() {
      useEffect(() => {
        if (document.getElementById(STYLE_ID)) return
        const el = document.createElement('style')
        el.id = STYLE_ID
        el.textContent = CSS
        document.head.appendChild(el)
      }, [])
    }

    function Toggle({ checked, onChange, label }) {
      const on = checked === true
      return h('label', {
        title: label,
        style: { display: 'inline-flex', alignItems: 'center', cursor: 'pointer', position: 'relative', flex: 'none' },
      },
        h('input', {
          type: 'checkbox', checked: on, onChange,
          style: { position: 'absolute', opacity: 0, width: 0, height: 0 },
          'aria-label': label,
        }),
        h('span', {
          style: {
            width: 34, height: 19, borderRadius: 999, flex: 'none',
            background: on
              ? 'var(--dsw-alias-brand-primary, #4a7dff)'
              : 'var(--dsw-alias-state-idle-primary, rgba(127,127,127,.35))',
            transition: 'background-color .2s ease',
            position: 'relative', display: 'block',
          },
        }, h('span', {
          style: {
            position: 'absolute', top: 2, left: 2, width: 15, height: 15, borderRadius: '50%',
            background: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,.25)',
            transform: `translateX(${on ? 15 : 0}px)`,
            transition: 'transform .2s cubic-bezier(.3,.7,.4,1)',
          },
        })),
      )
    }

    /** One numeric field: label above input, so alignment never depends on CSS. */
    function NumField({ label, value, onChange, min, max, suffix }) {
      return h('label', { style: { display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 } },
        h('span', { className: 'dwg-label' }, suffix ? `${label} · ${suffix}` : label),
        h('input', {
          className: 'dwg-input',
          type: 'number', min, max,
          value: value === undefined || value === null ? '' : value,
          onChange,
          'aria-label': label,
        }),
      )
    }

    const GRID = {
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(118px, 1fr))',
      gap: '8px 12px',
      marginTop: 10,
    }

    function TargetCard({ target, t, onPatch, onRemove, onFire, currentSessionId, locale }) {
      const rt = target.runtime || {}
      const [open, setOpen] = useState(false)
      const [draft, setDraft] = useState(null)
      const [note, setNote] = useState('')
      const [err, setErr] = useState('')
      const [busy, setBusy] = useState(false)
      const [presetId, setPresetId] = useState('')

      const value = draft || target
      const set = (key) => (event) => {
        const raw = event.target.type === 'checkbox' ? event.target.checked : event.target.value
        setDraft((prev) => ({ ...(prev || target), [key]: raw }))
        setNote('')
      }

      const applyPreset = async (preset) => {
        setPresetId(preset.id)
        const next = { ...(draft || target), ...preset.values }
        setDraft(next)
        setNote('')
        setBusy(true)
        setErr('')
        const result = await onPatch(target.id, next)
        setBusy(false)
        if (result && result.ok) {
          setDraft(null)
          setNote(t('saved'))
          setTimeout(() => setNote(''), 1800)
        } else {
          setErr(reasonText(result && result.error))
        }
      }

      const save = async () => {
        if (!draft) return
        setBusy(true)
        setErr('')
        const result = await onPatch(target.id, draft)
        setBusy(false)
        if (result && result.ok) {
          setDraft(null)
          setNote(t('saved'))
          setTimeout(() => setNote(''), 1800)
        } else {
          setErr(reasonText(result && result.error))
        }
      }

      const fire = async () => {
        setBusy(true)
        setErr('')
        const result = await onFire(target.id)
        setBusy(false)
        if (result && result.ok !== true) setErr(result.message || reasonText(result.reason))
      }

      const enabled = target.enabled === true
      const active = presetById(presetId)
      const lastText = `${rt.lastOutcome || 'never'}${rt.lastReason ? ' · ' + reasonText(rt.lastReason) : ''}`
      // The note is the user's own label, frozen when the session was added;
      // the live session title is only a fallback until one is set.
      const heading = (target.label && target.label.trim() !== '')
        ? target.label
        : (target.title && String(target.title).trim() !== '' ? target.title : shortId(target.sessionId))

      return h('div', {
        className: 'dwg-card',
        style: {
          padding: '12px 13px',
          borderColor: enabled
            ? 'color-mix(in srgb, var(--dsw-alias-brand-primary, #4a7dff) 34%, var(--dsw-alias-border-l1, #888))'
            : undefined,
        },
      },
        /* header */
        h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 10 } },
          h('div', { style: { minWidth: 0, flex: 1 } },
            h('div', { className: 'dwg-title', style: { display: 'flex', alignItems: 'center', gap: 7 } },
              enabled ? h('span', {
                style: {
                  width: 7, height: 7, borderRadius: '50%', flex: 'none',
                  background: 'var(--dsw-alias-state-success-primary, #2e9e5b)',
                },
              }) : null,
              h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                heading),
            ),
            h('div', { className: 'dwg-sub dwg-mono', title: target.sessionId, style: { marginTop: 2 } },
              target.title && target.title !== heading ? `${target.title} · ${shortId(target.sessionId)}` : shortId(target.sessionId)),
          ),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 7, flex: 'none' } },
            h('span', { className: 'dwg-label' }, t('enable')),
            h(Toggle, {
              checked: enabled, label: t('enable'),
              onChange: (event) => { void onPatch(target.id, { enabled: event.target.checked }) },
            }),
          ),
        ),

        /* status line */
        h('div', {
          style: {
            display: 'flex', flexWrap: 'wrap', gap: '2px 14px', marginTop: 9,
            fontSize: 11.5, fontVariantNumeric: 'tabular-nums',
          },
        },
          h('span', null,
            h('span', { className: 'dwg-dim' }, `${t('nextIn')} `),
            h('span', null, enabled ? fmtIn(rt.inMs) : '—')),
          h('span', null,
            h('span', { className: 'dwg-dim' }, `${t('today')} `),
            h('span', null, `${rt.todayCount ?? 0}/${target.maxPerDay}`)),
          h('span', { className: /^fired/.test(String(rt.lastOutcome)) ? 'dwg-ok' : 'dwg-dim' },
            h('span', { className: 'dwg-dim' }, `${t('last')} `),
            h('span', null, lastText)),
        ),

        /* actions */
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 10, flexWrap: 'wrap' } },
          h('button', { className: 'dwg-btn', type: 'button', onClick: () => setOpen(!open) },
            open ? t('collapse') : t('edit')),
          h('button', { className: 'dwg-btn', type: 'button', disabled: busy, onClick: fire },
            busy ? t('working') : t('fireNow')),
          h('div', { style: { flex: 1 } }),
          note ? h('span', { className: 'dwg-sub' }, note) : null,
          h('button', { className: 'dwg-btn danger', type: 'button', onClick: () => { void onRemove(target.id) } },
            t('remove')),
        ),
        err ? h('div', { className: 'dwg-err', style: { marginTop: 8 } }, err) : null,

        /* expanded settings */
        open ? h('div', null,
          h('div', { className: 'dwg-sep', style: { height: 1, margin: '10px 0' } }),

          h('div', { style: { display: 'grid', gridTemplateColumns: 'auto minmax(0,1fr)', gap: '6px 10px', alignItems: 'center' } },
            h('span', { className: 'dwg-label' }, t('label')),
            h('input', { className: 'dwg-input', value: value.label || '', onChange: set('label'), 'aria-label': t('label') }),
            h('span', { className: 'dwg-label' }, t('target')),
            h('div', { style: { display: 'flex', gap: 6 } },
              h('input', { className: 'dwg-input', style: { flex: 1 }, value: value.sessionId || '', onChange: set('sessionId'), 'aria-label': t('target') }),
              h('button', {
                className: 'dwg-btn ghost', type: 'button',
                onClick: () => setDraft({ ...(draft || target), sessionId: currentSessionId || '' }),
              }, t('useCurrent')),
            ),
          ),

          /* presets */
          h('div', { style: { marginTop: 12 } },
            h('div', { className: 'dwg-label', style: { marginBottom: 6 } }, t('presets')),
            h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
              PRESETS.map((preset) => h('button', {
                key: preset.id,
                type: 'button',
                className: `dwg-chip${presetId === preset.id ? ' is-active' : ''}`,
                title: preset.hint[locale] || preset.hint.zh,
                onClick: () => { void applyPreset(preset) },
              }, preset.name[locale] || preset.name.zh)),
            ),
            h('div', { className: 'dwg-sub', style: { marginTop: 5 } },
              active ? (active.hint[locale] || active.hint.zh) : t('presetHint')),
          ),

          /* numbers */
          h('div', { style: GRID },
            h(NumField, { label: t('interval'), suffix: t('intervalUnit'), min: 1, max: 1440, value: value.intervalMinutes, onChange: set('intervalMinutes') }),
            h(NumField, { label: t('jitter'), suffix: '%', min: 0, max: 100, value: value.jitterPct, onChange: set('jitterPct') }),
            h(NumField, { label: t('probability'), suffix: '%', min: 0, max: 100, value: value.probabilityPct, onChange: set('probabilityPct') }),
            h(NumField, { label: t('maxPerDay'), min: 0, max: 999, value: value.maxPerDay, onChange: set('maxPerDay') }),
            h(NumField, { label: t('cooldown'), suffix: t('intervalUnit'), min: 0, max: 1440, value: value.cooldownMinutes, onChange: set('cooldownMinutes') }),
            h(NumField, { label: t('idleGuard'), suffix: t('intervalUnit'), min: 0, max: 1440, value: value.idleGuardMinutes, onChange: set('idleGuardMinutes') }),
          ),

          /* quiet hours */
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 } },
            h('span', { className: 'dwg-label', style: { flex: 'none' } }, t('quiet')),
            h('input', { className: 'dwg-input', style: { width: 84, textAlign: 'center' }, value: value.quietStart || '', onChange: set('quietStart'), 'aria-label': 'quiet start' }),
            h('span', { className: 'dwg-dim' }, '→'),
            h('input', { className: 'dwg-input', style: { width: 84, textAlign: 'center' }, value: value.quietEnd || '', onChange: set('quietEnd'), 'aria-label': 'quiet end' }),
          ),

          /* prompt */
          h('div', { style: { marginTop: 10 } },
            h('div', { className: 'dwg-label', style: { marginBottom: 5 } }, t('prompt')),
            h('textarea', {
              className: 'dwg-textarea', value: value.prompt || '', onChange: set('prompt'),
              'aria-label': t('prompt'),
            }),
          ),

          h('div', { style: { display: 'flex', justifyContent: 'flex-end', marginTop: 10 } },
            h('button', { className: 'dwg-btn primary', type: 'button', disabled: busy || !draft, onClick: save }, t('save')),
          ),
        ) : null,
      )
    }

    function Panel({ sessionId, t, locale }) {
      useStyles()
      const [snap, setSnap] = useState(null)
      const [addValue, setAddValue] = useState('')
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)
      const alive = useRef(true)

      const load = useCallback(async () => {
        try {
          const res = await fetch(STATE_URL, { credentials: 'same-origin' })
          const parsed = await readJson(res)
          if (!parsed.ok || parsed.data === null) {
            throw new Error(`state ${parsed.status}${parsed.text ? ': ' + parsed.text.slice(0, 60) : ''}`)
          }
          if (alive.current) setSnap(parsed.data)
        } catch (e) {
          if (alive.current) setError(String(e && e.message ? e.message : e))
        }
      }, [])

      useEffect(() => {
        alive.current = true
        void load()
        const timer = setInterval(() => { void load() }, 4000)
        return () => {
          alive.current = false
          clearInterval(timer)
        }
      }, [load])

      const post = useCallback(async (body) => {
        const res = await fetch(TARGETS_URL, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        const parsed = await readJson(res)
        if (parsed.data && Array.isArray(parsed.data.targets) && alive.current) setSnap(parsed.data)
        if (!parsed.ok) {
          return {
            ok: false,
            error: parsed.data && parsed.data.error
              ? parsed.data.error
              : `HTTP ${parsed.status}${parsed.text ? ' ' + parsed.text.slice(0, 60) : ''}`,
          }
        }
        return { ok: true, data: parsed.data }
      }, [])

      const add = useCallback(async () => {
        const id = addValue.trim()
        if (id === '') return
        setBusy(true)
        setError('')
        try {
          const result = await post({ op: 'add', target: { sessionId: id, enabled: true } })
          if (!result.ok) setError(reasonText(result.error))
          else setAddValue('')
        } catch (e) {
          setError(String(e && e.message ? e.message : e))
        } finally {
          setBusy(false)
        }
      }, [addValue, post])

      const patch = useCallback(async (id, fields) => {
        try {
          return await post({ op: 'update', target: { id, ...fields } })
        } catch (e) {
          return { ok: false, error: String(e && e.message ? e.message : e) }
        }
      }, [post])

      const remove = useCallback(async (id) => {
        if (!window.confirm('把这个会话移出管理列表？')) return
        try {
          const result = await post({ op: 'remove', id })
          if (!result.ok) setError(reasonText(result.error))
        } catch (e) {
          setError(String(e && e.message ? e.message : e))
        }
      }, [post])

      const fire = useCallback(async (id) => {
        try {
          const result = await post({ op: 'fire', id })
          if (!result.ok) return { ok: false, reason: result.error }
          const inner = result.data && result.data.result
          if (inner && inner.ok !== true) return { ok: false, reason: inner.reason }
          return { ok: true }
        } catch (e) {
          return { ok: false, reason: String(e && e.message ? e.message : e) }
        }
      }, [post])

      const targets = snap && Array.isArray(snap.targets) ? snap.targets : []
      const loaded = snap !== null

      return h('div', {
        className: 'dwg-root',
        style: {
          display: 'flex', flexDirection: 'column', gap: 10,
          padding: '14px 14px 28px', height: '100%', overflowY: 'auto', boxSizing: 'border-box',
          fontSize: 13,
        },
      },
        error ? h('div', { className: 'dwg-err' }, error) : null,

        /* add card */
        h('div', { className: 'dwg-card', style: { padding: '12px 13px' } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 9 } },
            h(AlarmGlyphBadge, { size: 15 }),
            h('div', { style: { minWidth: 0 } },
              h('div', { className: 'dwg-title' }, t('title')),
              h('div', { className: 'dwg-sub', style: { marginTop: 1 } }, t('description')),
            ),
          ),
          h('div', { style: { display: 'flex', gap: 6, marginTop: 9 } },
            h('input', {
              className: 'dwg-input',
              style: { flex: 1 },
              placeholder: t('addHint'),
              value: addValue,
              onChange: (event) => setAddValue(event.target.value),
              onKeyDown: (event) => { if (event.key === 'Enter') void add() },
              'aria-label': t('addHint'),
            }),
            h('button', {
              className: 'dwg-btn ghost', type: 'button',
              onClick: () => setAddValue(sessionId || ''),
            }, t('useCurrent')),
            h('button', {
              className: 'dwg-btn primary', type: 'button',
              disabled: busy || addValue.trim() === '',
              onClick: add,
            }, busy ? t('working') : t('add')),
          ),
        ),

        !loaded ? h('div', { className: 'dwg-skel', style: { height: 76, borderRadius: 12 } }) : null,

        loaded && targets.length === 0
          ? h('div', { className: 'dwg-card', style: { padding: '22px 14px', textAlign: 'center' } },
            h('div', { style: { fontWeight: 500, marginBottom: 5 } }, t('empty')),
            h('div', { className: 'dwg-sub' }, t('emptyHint')),
          )
          : null,

        targets.map((target) => h(TargetCard, {
          key: target.id,
          target,
          t,
          locale,
          currentSessionId: sessionId,
          onPatch: patch,
          onRemove: remove,
          onFire: fire,
        })),
      )
    }

    return {
      inject: ['slots', 'locale', 'sidebarRightTabs'],
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        const locale = String(ctx.locale.preference ?? 'zh').toLowerCase().startsWith('zh') ? 'zh' : 'en'
        const PanelBound = (props) => h(Panel, Object.assign({}, props, { t, locale }))
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-random-wake: dictionaries')
        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: TAB_ID,
          kind: TAB_KIND,
          title: () => h('span', {
            style: { display: 'inline-flex', alignItems: 'center', gap: 5 },
          }, h(AlarmGlyphInline, { size: 11 }), h('span', null, t('title'))),
          keepMounted: true,
          guide: [{
            id: 'random-wake',
            order: 20,
            title: () => t('title'),
            description: () => t('description'),
            // Guide entry draws entry.icon when a type supplies one.
            icon: (props) => h(AlarmGlyphBadge, { size: (props && props.size) || 18 }),
          }],
        }), 'dsh-random-wake: tab type')
        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: TAB_ID,
          locale: NS,
          inject: sessionId => ({ sessionId }),
        }, PanelBound)), 'dsh-random-wake: tab body')
      },
    }
  },
})

