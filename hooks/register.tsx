import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit, TurnUsage } from 'claude-code'

import type { MainTurn, Memory, Meter, Task, TaskStatus, Todo, Totals } from '../types'

const PANE = 'task-monitor'
const TITLE = 'Tasks'
const KEEP_FINISHED = 8
const STORE_PANE_HIDDEN = 'paneHidden'
const PANE_ARGS = { id: PANE, title: TITLE, backgroundColor: 'transparent' } as const
const STORE_METER_HIDDEN = 'meterHidden'
const STORE_COLLAPSED = 'collapsed'
const STORE_METER_COMPACT = 'meterCompact'
// A finished foreground tool call stays listed only when it took this long.
const NOTABLE_TOOL_MS = 3000

const tasks = atom({ plugin: 'task-monitor', key: 'tasks' } as const, [], {
  shape: 'tasks-1',
})
const main = atom({ plugin: 'task-monitor', key: 'main' } as const, null, {
  shape: 'main-1',
})
const meter = atom({ plugin: 'task-monitor', key: 'meter' } as const, null, {
  shape: 'meter-1',
})
const todos = atom({ plugin: 'task-monitor', key: 'todos' } as const, [], { shape: 'todos-1' })
// Sections of the pane the person has folded: 'plan', 'fg', 'bg', 'done'.
const collapsed = atom({ plugin: 'task-monitor', key: 'collapsed' } as const, [], {
  shape: 'collapsed-1',
})
const meterCompact = atom({ plugin: 'task-monitor', key: 'meterCompact' } as const, false)
const meterHidden = atom({ plugin: 'task-monitor', key: 'meterHidden' } as const, false)
const memory = atom({ plugin: 'task-monitor', key: 'memory' } as const, null, { shape: 'memory-1' })
const totals = atom(
  { plugin: 'task-monitor', key: 'totals' } as const,
  { input: 0, output: 0 },
  { shape: 'totals-1' },
)

// ── formatting ──────────────────────────────────────────────────────────────

function fmtTokens(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

function bar(percent: number, cells: number): [string, string] {
  const filled = Math.max(0, Math.min(cells, Math.round((percent / 100) * cells)))
  return ['▰'.repeat(filled), '▱'.repeat(cells - filled)]
}

function levelColor(percent: number): 'success' | 'warning' | 'error' {
  if (percent >= 85) return 'error'
  if (percent >= 60) return 'warning'
  return 'success'
}

// Time left until a limit resets: "42m", "2h 14m", "3d 4h".
function fmtUntil(ms: number): string {
  const m = Math.max(1, Math.ceil(ms / 60_000))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

// "340 MB", "1.2 GB", in the units Activity Monitor uses (1 MB = 1024 KB).
function fmtBytes(n: number): string {
  const mb = n / 1024 / 1024
  if (mb < 1024) return `${Math.round(mb)} MB`
  return `${(mb / 1024).toFixed(1)} GB`
}

const SPIN = ['◐', '◓', '◑', '◒']

/** An indeterminate "working" strip: a short block sweeping across `cells`. */
function sweep(frame: number, cells: number): [string, string, string] {
  const size = 3
  const span = cells + size
  const head = frame % span
  const start = Math.max(0, head - size)
  const end = Math.min(cells, head)
  return ['─'.repeat(start), '━'.repeat(Math.max(0, end - start)), '─'.repeat(cells - Math.max(end, start))]
}

function toolLabel(e: Record<string, unknown>, tool: string): string {
  const description = e.description
  if (typeof description === 'string' && description.trim() !== '') return description.replace(/\s+/g, ' ').trim()
  for (const field of ['file_path', 'pattern', 'url', 'query', 'command', 'prompt']) {
    const value = e[field]
    if (typeof value === 'string' && value.trim() !== '') {
      const text = field === 'file_path' ? (value.split('/').pop() ?? value) : value
      return `${tool} ${text.replace(/\s+/g, ' ').trim()}`
    }
  }
  return tool
}

function usageInput(u: TurnUsage): number {
  return u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
}

// ── state helpers ───────────────────────────────────────────────────────────

function prune(list: Task[]): Task[] {
  const live = list.filter(t => t.status === 'running' || t.status === 'waiting')
  const ended = list
    .filter(t => t.status !== 'running' && t.status !== 'waiting')
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
    .slice(0, KEEP_FINISHED)
  return [...live, ...ended]
}

function upsert($: EngineInterface, task: Task) {
  return update($, tasks, list => {
    const exists = list.some(t => t.id === task.id)
    return prune(exists ? list.map(t => (t.id === task.id ? { ...t, ...task } : t)) : [...list, task])
  })
}

function patch($: EngineInterface, id: string, fn: (t: Task) => Task) {
  return update($, tasks, list => prune(list.map(t => (t.id === id ? fn(t) : t))))
}

async function finish($: EngineInterface, id: string, status: TaskStatus) {
  const now = await $.clock.now()
  return patch($, id, t =>
    t.status === 'running' || t.status === 'waiting'
      ? { ...t, status, endedAt: now, activity: undefined }
      : t,
  )
}

async function refreshMeter($: EngineInterface) {
  const usage = await $.session.usage()
  const next = meterOf(usage.context, usage.rateLimits)
  await update($, meter, () => next)
}

// Per-model weekly windows, as Claude Code names them in its limit notices
// ("Fable limit" is the `seven_day_overage_included` window).
const MODEL_LIMITS = [
  { kind: 'seven_day_overage_included', label: 'fable', short: 'fb' },
  { kind: 'seven_day_opus', label: 'opus', short: 'op' },
  { kind: 'seven_day_sonnet', label: 'sonnet', short: 'sn' },
] as const

function meterOf(
  context: { tokens?: number; window: number; percent?: number },
  limits: SessionRateLimit[],
): Meter {
  const five = limits.find(r => r.kind === 'five_hour')
  const week = limits.find(r => r.kind === 'seven_day')
  return {
    contextTokens: context.tokens,
    contextWindow: context.window,
    contextPercent: context.percent,
    fiveHourPercent: five?.percentUsed,
    fiveHourResetsAt: five?.resetsAt,
    weekPercent: week?.percentUsed,
    weekResetsAt: week?.resetsAt,
    models: limits
      .filter(r => MODEL_LIMITS.some(l => l.kind === r.kind))
      .map(r => ({ kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt })),
  }
}

// Reads the memory of the Claude Code process. Commands run as its children,
// so the shell walks up from its parent to the process named `claude` (or a
// version number, as the native build's binary is), and takes its parent when
// none matches. macOS: `footprint` (Activity Monitor's figure, and the part
// swapped or compressed); Linux: /proc's resident set and swap; else `ps`.
// A second line holds the machine's memory: its total and what is still
// available. macOS: the total less what Activity Monitor calls Memory Used
// (app memory, wired, compressed); Linux: MemAvailable.
const MEMORY_SCRIPT = `
p=$PPID; i=0; found=
while [ "$i" -lt 6 ] && [ -n "$p" ] && [ "$p" -gt 1 ]; do
  c=$(ps -o comm= -p "$p" 2>/dev/null); c=\${c##*/}
  case "$c" in claude|claude-code|[0-9]*.[0-9]*.[0-9]*) found=$p; break;; esac
  p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' '); i=$((i+1))
done
p=\${found:-$PPID}
if [ -r "/proc/$p/status" ]; then
  awk -v p="$p" '/^VmRSS:/{r=$2*1024} /^VmSwap:/{s=$2*1024} END{print p, r+0, s+0}' "/proc/$p/status"
elif out=$(footprint --swapped -f bytes "$p" 2>/dev/null | awk '$NF=="TOTAL"{print $1, $3; exit}') && [ -n "$out" ]; then
  echo "$p $out"
else
  echo "$p $(( $(ps -o rss= -p "$p" | tr -d ' ') * 1024 )) 0"
fi
if [ -r /proc/meminfo ]; then
  awk '/^MemTotal:/{t=$2*1024} /^MemAvailable:/{a=$2*1024} END{printf "%.0f %.0f\\n", t, a}' /proc/meminfo
else
  vm_stat 2>/dev/null | awk -v t="$(sysctl -n hw.memsize 2>/dev/null)" '
    /page size of/ {for (i = 1; i <= NF; i++) if ($i == "of") ps = $(i + 1)}
    /^Anonymous pages/ {gsub(/\\./, "", $NF); an = $NF}
    /^Pages purgeable/ {gsub(/\\./, "", $NF); pu = $NF}
    /^Pages wired down/ {gsub(/\\./, "", $NF); w = $NF}
    /^Pages occupied by compressor/ {gsub(/\\./, "", $NF); c = $NF}
    END {if (t > 0 && ps > 0) {a = t - (an - pu + w + c) * ps; if (a < 0) a = 0; printf "%.0f %.0f\\n", t, a}}'
fi
`

async function sampleMemory($: EngineInterface): Promise<void> {
  const { exitCode, stdout } = await $.process.run(['/bin/sh', '-c', MEMORY_SCRIPT], { timeoutMs: 5000 })
  const [own = '', system = ''] = stdout.trim().split('\n')
  const [pid, bytes, swapped] = own.trim().split(/\s+/).map(Number)
  if (exitCode !== 0 || !Number.isFinite(pid) || !Number.isFinite(bytes) || !(bytes! > 0)) return
  const [total, available] = system.trim().split(/\s+/).map(Number)
  const hasSystem = Number.isFinite(total) && Number.isFinite(available) && total! > 0
  const value: Memory = {
    pid: pid!,
    bytes: bytes!,
    swapped: Number.isFinite(swapped) ? swapped! : 0,
    ...(hasSystem && { systemTotal: total!, systemAvailable: available! }),
  }
  await update($, memory, () => value)
}

async function toggleCompact($: EngineInterface): Promise<boolean> {
  const isCompact = await update($, meterCompact, v => !v)
  await $.store.set(STORE_METER_COMPACT, isCompact)
  return isCompact
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(block =>
      block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string'
        ? (block as { text: string }).text
        : '',
    )
    .join('\n')
}

// ── the mod ─────────────────────────────────────────────────────────────────

export const register: Register = on => {
  // Columns the docked pane takes from the screen. The hint line under the
  // prompt is only told the transcript column's width, which a docked pane
  // narrows, so the meter adds this back to reach the screen's right edge.
  let dockColumns = 0

  // Background flag of agents about to start, by description: a foreground
  // agent's spawn may resolve only when it ends, so `turn.start` reads this.
  const pendingBackground = new Map<string, boolean>()

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'task-monitor',
      description: 'Show or hide the tasks panel; "meter" shows or hides the usage meter, "compact" shrinks or expands it',
      argumentHint: '[meter|compact|limits]',
    })
    const isMeterHidden = (await $.store.get(STORE_METER_HIDDEN)) === true
    await update($, meterHidden, () => isMeterHidden)
    const isMeterCompact = (await $.store.get(STORE_METER_COMPACT)) === true
    await update($, meterCompact, () => isMeterCompact)
    const folded = await $.store.get(STORE_COLLAPSED)
    if (Array.isArray(folded)) {
      const ids = folded.filter((x): x is string => typeof x === 'string')
      await update($, collapsed, () => ids)
    }
    if ((await $.store.get(STORE_PANE_HIDDEN)) !== true) void $.ui.open(PANE_ARGS)
    $.ui.status(undefined)
    await refreshMeter($).catch(() => undefined)
    void sampleMemory($).catch(() => undefined)

    // While something runs, redraw each second so the clocks tick; and ask
    // the engine whether any agent we still show as running has ended.
    // Every 30 s, even when idle, so the reset countdowns stay current; and
    // once a window has reset, read the fresh usage.
    let ticks = 0
    $.clock.every(1000, () => {
      void (async () => {
        ticks += 1
        if (ticks % 5 === 0) await sampleMemory($).catch(() => undefined)
        if (ticks % 30 === 0) {
          const m = await read($, meter)
          const now = await $.clock.now()
          const isPast = (at?: string) => at !== undefined && Date.parse(at) <= now
          if (m !== null && (isPast(m.fiveHourResetsAt) || isPast(m.weekResetsAt) || (m.models ?? []).some(w => isPast(w.resetsAt))))
            await refreshMeter($).catch(() => undefined)
          $.ui.invalidate('ui.render')
        }
        const list = await read($, tasks)
        const turn = await read($, main)
        const isLive =
          list.some(t => t.status === 'running' || t.status === 'waiting') ||
          (turn !== null && turn.endedAt === undefined)
        if (!isLive) return
        $.ui.invalidate('ui.render')

        const agents = list.filter(t => t.kind === 'agent' && t.status === 'running')
        if (agents.length === 0) return
        const known = await $.agent.list()
        for (const a of agents) {
          const info = known.find(k => k.id === a.id)
          if (info === undefined) continue
          if (info.status === 'completed') await finish($, a.id, 'done')
          else if (info.status === 'failed') await finish($, a.id, 'failed')
          else if (info.status === 'killed') await finish($, a.id, 'killed')
          else if (info.status === 'waiting' || info.status === 'idle')
            await patch($, a.id, t => ({ ...t, status: 'waiting' }))
        }
      })().catch(() => undefined)
    })

    return next(e)
  })

  on('command.run', { command: 'task-monitor' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'meter') {
      const isHidden = !(await read($, meterHidden))
      await update($, meterHidden, () => isHidden)
      await $.store.set(STORE_METER_HIDDEN, isHidden)
      return { text: isHidden ? 'Usage meter hidden. "/task-monitor meter" brings it back.' : 'Usage meter shown.' }
    }
    if (arg === 'limits') {
      const usage = await $.session.usage()
      if (usage.rateLimits.length === 0) return { text: 'Claude Code reports no usage limits for this session.' }
      const lines = usage.rateLimits.map(r => {
        const at = r.resetsAt === undefined ? NaN : Date.parse(r.resetsAt)
        return `${r.kind}: ${r.percentUsed}%${Number.isNaN(at) ? '' : `, resets ${r.resetsAt}`}`
      })
      return { text: `Usage limits as Claude Code reports them:\n${lines.join('\n')}` }
    }
    if (arg === 'compact') {
      const isCompact = await toggleCompact($)
      return { text: isCompact ? 'Usage meter compact.' : 'Usage meter in full.' }
    }
    if (arg !== '')
      return {
        text: 'Usage: /task-monitor to show or hide the panel, /task-monitor meter to show or hide the usage meter, /task-monitor compact to shrink or expand it, /task-monitor limits to list every usage limit.',
      }

    const isOpen = (await $.ui.panes()).some(pane => pane.id === PANE)
    if (isOpen) {
      await $.store.set(STORE_PANE_HIDDEN, true)
      await $.ui.close({ id: PANE })
      return { text: 'Tasks panel hidden; it stays hidden in new sessions until "/task-monitor".' }
    }
    await $.store.set(STORE_PANE_HIDDEN, false)
    const opened = await $.ui.open(PANE_ARGS)
    return {
      text: opened.isPlaced ? 'Tasks panel shown.' : 'The tasks panel will show once the terminal has room.',
    }
  })

  // Closing the pane by hand (its close mark, ctrl+x x) keeps it closed in
  // later sessions too, until "/task-monitor" shows it again.
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) dockColumns = 0
    if (e.id === PANE && e.origin.kind === 'person') await $.store.set(STORE_PANE_HIDDEN, true)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, tasks, () => [])
      await update($, main, () => null)
      await update($, totals, () => ({ input: 0, output: 0 }))
      await update($, todos, () => [])
    }
    return next(e)
  })

  // ── usage meter ──
  on('session.measure', async ($, e, next) => {
    const value = meterOf(e.context, e.rateLimits)
    await update($, meter, () => value)
    return next(e)
  })

  // ── agents ──
  on('agent.spawn', async ($, e, next) => {
    pendingBackground.set(e.description, e.background)
    const startedAt = await $.clock.now()
    const ran = await next(e)
    if (ran.deny === undefined && ran.agentId !== undefined) {
      const id = ran.agentId
      const list = await read($, tasks)
      if (!list.some(t => t.id === id)) {
        await upsert($, {
          id,
          kind: 'agent',
          label: e.description || e.subagentType,
          detail: e.subagentType,
          isBackground: e.background,
          status: 'running',
          startedAt,
          context: 0,
          output: 0,
          steps: 0,
        })
      }
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    const now = await $.clock.now()
    if (e.agentId === undefined) {
      await update($, main, () => ({ startedAt: now, steps: 0, context: 0, output: 0 }) satisfies MainTurn)
      return next(e)
    }
    const id = e.agentId
    const list = await read($, tasks)
    const known = list.find(t => t.id === id)
    if (known !== undefined) {
      await patch($, id, t => ({ ...t, status: 'running', endedAt: undefined }))
    } else {
      const info = (await $.agent.list()).find(a => a.id === id)
      const description = info?.description ?? 'Subagent'
      await upsert($, {
        id,
        kind: 'agent',
        label: description,
        detail: info?.type ?? 'agent',
        isBackground: pendingBackground.get(description) ?? false,
        status: 'running',
        startedAt: now,
        context: 0,
        output: 0,
        steps: 0,
      })
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const u = result.usage
    if (u !== null) {
      const input = usageInput(u)
      await update($, totals, t => ({ input: t.input + input, output: t.output + u.output_tokens }) satisfies Totals)
      if (e.agentId === undefined) {
        await update($, main, m =>
          m === null ? m : { ...m, steps: m.steps + 1, context: input, output: m.output + u.output_tokens },
        )
      } else {
        await patch($, e.agentId, t => ({
          ...t,
          steps: t.steps + 1,
          context: input,
          output: t.output + u.output_tokens,
        }))
      }
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const now = await $.clock.now()
    if (e.agentId === undefined) {
      await update($, main, m => (m === null ? m : { ...m, endedAt: now }))
    } else {
      const status: TaskStatus =
        e.reason === 'aborted' ? 'killed' : e.reason === 'answer' ? 'done' : 'failed'
      await finish($, e.agentId, status)
    }
    void refreshMeter($).catch(() => undefined)
    return next(e)
  })

  // ── tool calls and background shells ──
  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    if (tool === 'Agent' || tool === 'Task') return next(e)

    const args = e as unknown as Record<string, unknown>
    const label = toolLabel(args, tool)

    // The main conversation's to-do list: the plan the progress bar measures.
    if (e.agentId === undefined && (tool === 'TodoWrite' || tool === 'TaskCreate' || tool === 'TaskUpdate')) {
      const ran = await next(e)
      if (ran.deny !== undefined || ran.isError === true) return ran
      if (tool === 'TodoWrite' && Array.isArray(args.todos)) {
        const list = (args.todos as { content?: unknown; status?: unknown; activeForm?: unknown }[]).map((t, i) => ({
          id: `todo-${i}`,
          subject: String(t.content ?? ''),
          activeForm: typeof t.activeForm === 'string' ? t.activeForm : undefined,
          status: t.status === 'completed' || t.status === 'in_progress' ? t.status : 'pending',
        }) satisfies Todo)
        await update($, todos, () => list)
      } else if (tool === 'TaskCreate') {
        const created = (ran.result as { task?: { id?: unknown; subject?: unknown } } | undefined)?.task
        const id = typeof created?.id === 'string' ? created.id : `task-${e.tool_use_id}`
        const subject = typeof args.subject === 'string' ? args.subject : String(created?.subject ?? 'Task')
        const activeForm = typeof args.activeForm === 'string' ? args.activeForm : undefined
        const item: Todo = { id, subject, activeForm, status: 'pending' }
        await update($, todos, list => [...list.filter(t => t.id !== id), item])
      } else if (tool === 'TaskUpdate' && typeof args.taskId === 'string') {
        const id = args.taskId
        await update($, todos, list =>
          args.status === 'deleted'
            ? list.filter(t => t.id !== id)
            : list.map(t =>
                t.id !== id
                  ? t
                  : {
                      ...t,
                      subject: typeof args.subject === 'string' ? args.subject : t.subject,
                      activeForm: typeof args.activeForm === 'string' ? args.activeForm : t.activeForm,
                      status:
                        args.status === 'completed' || args.status === 'in_progress' || args.status === 'pending'
                          ? args.status
                          : t.status,
                    },
              ),
        )
      }
      return ran
    }

    if (tool === 'TaskStop') {
      const ran = await next(e)
      const id = typeof args.task_id === 'string' ? args.task_id : typeof args.shell_id === 'string' ? args.shell_id : undefined
      if (id !== undefined && ran.deny === undefined && ran.isError !== true) await finish($, id, 'killed')
      return ran
    }

    // Inside a subagent, a tool is that agent's current activity, not a row.
    if (e.agentId !== undefined && !(tool === 'Bash' && args.run_in_background === true)) {
      const agentId = e.agentId
      await patch($, agentId, t => ({ ...t, activity: label }))
      const ran = await next(e)
      await patch($, agentId, t => (t.activity === label ? { ...t, activity: undefined } : t))
      return ran
    }

    const startedAt = await $.clock.now()
    const callId = `tool:${e.tool_use_id}`
    const isBg = tool === 'Bash' && args.run_in_background === true
    if (!isBg) {
      await upsert($, {
        id: callId,
        kind: 'tool',
        label,
        detail: tool,
        isBackground: false,
        status: 'running',
        startedAt,
        context: 0,
        output: 0,
        steps: 0,
      })
    }

    const ran = await next(e)
    const now = await $.clock.now()
    const bgId =
      tool === 'Bash' && ran.result !== undefined
        ? (ran.result as { backgroundTaskId?: string }).backgroundTaskId
        : undefined

    await update($, tasks, list => {
      const rest = list.filter(t => t.id !== callId)
      if (bgId !== undefined) {
        const command = typeof args.command === 'string' ? args.command : label
        const description = typeof args.description === 'string' ? args.description : command
        return prune([
          ...rest,
          {
            id: bgId,
            kind: 'shell',
            label: description,
            detail: command.replace(/\s+/g, ' ').trim(),
            isBackground: true,
            status: 'running',
            startedAt,
            context: 0,
            output: 0,
            steps: 0,
          },
        ])
      }
      if (now - startedAt < NOTABLE_TOOL_MS) return rest
      const failed = ran.deny !== undefined || ran.isError === true
      return prune([
        ...rest,
        {
          id: callId,
          kind: 'tool',
          label,
          detail: tool,
          isBackground: false,
          status: failed ? 'failed' : 'done',
          startedAt,
          endedAt: now,
          context: 0,
          output: 0,
          steps: 0,
        },
      ])
    })
    return ran
  }).catch(($, e, next) => next(e))

  // A background task's completion arrives as a <task-notification> row.
  on('session.append', async ($, e, next) => {
    const text = textOf(e.message.content)
    if (text.includes('<task-notification>')) {
      for (const block of text.split('<task-notification>').slice(1)) {
        const id = /<task-id>([^<]+)<\/task-id>/.exec(block)?.[1]?.trim()
        const raw = /<status>([^<]+)<\/status>/.exec(block)?.[1]?.trim().toLowerCase()
        if (id === undefined || raw === undefined) continue
        const status: TaskStatus =
          raw === 'completed' ? 'done' : raw === 'killed' || raw === 'stopped' ? 'killed' : 'failed'
        await finish($, id, status).catch(() => undefined)
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // ── drawing: the pane ──
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const now = await $.clock.now()
    const folded = await read($, collapsed)
    const isOpen = (id: string) => !folded.includes(id)
    const toggle = async (id: string) => {
      const next = await update($, collapsed, list =>
        list.includes(id) ? list.filter(x => x !== id) : [...list, id],
      )
      await $.store.set(STORE_COLLAPSED, next)
    }
    const list = await read($, tasks)
    const turn = await read($, main)
    const plan = await read($, todos)
    const mem = await read($, memory)
    const frame = Math.floor(now / 1000)
    const spin = SPIN[frame % SPIN.length] ?? '◐'
    const width = Math.max(20, e.props.bodyColumns - 3)
    // The pane's frame (border and gap) takes three columns beyond its body.
    const docked = e.props.placement === 'dock' ? e.props.bodyColumns + 3 : 0
    if (docked !== dockColumns) {
      dockColumns = docked
      $.ui.invalidate('ui.render')
    }

    const isLive = (t: Task) => t.status === 'running' || t.status === 'waiting'
    const fg = list.filter(t => isLive(t) && !t.isBackground)
    const bg = list.filter(t => isLive(t) && t.isBackground)
    const ended = list.filter(t => !isLive(t))
    const isMainRunning = turn !== null && turn.endedAt === undefined
    const doneCount = plan.filter(t => t.status === 'completed').length
    const showPlan = plan.length > 0 && (doneCount < plan.length || isMainRunning)

    let rows = 0
    const kindOf = (task: Task) => (task.id === 'main' ? task.detail : task.kind === 'shell' ? 'bash' : task.detail.toLowerCase())

    const Row = ({ task }: { task: Task }) => {
      const live = isLive(task)
      const accent = task.isBackground ? 'suggestion' : 'claude'
      const glyph = !live
        ? task.status === 'done'
          ? '✓'
          : task.status === 'killed'
            ? '■'
            : '✗'
        : task.status === 'waiting'
          ? '◌'
          : spin
      const glyphColor = live
        ? task.status === 'waiting'
          ? 'warning'
          : accent
        : task.status === 'done'
          ? 'success'
          : task.status === 'killed'
            ? 'warning'
            : 'error'
      const elapsed = fmtDuration((task.endedAt ?? now) - task.startedAt)
      const tokens = task.kind === 'agent' && task.context + task.output > 0 ? fmtTokens(task.context + task.output) : ''
      const sub =
        task.kind === 'agent'
          ? [task.activity ?? (task.status === 'waiting' ? 'waiting' : undefined), tokens && `${tokens} tok`, task.steps > 0 && `${task.steps} ${task.steps === 1 ? 'step' : 'steps'}`]
          : task.kind === 'shell'
            ? [task.detail]
            : []
      const subline = sub.filter(Boolean).join(' · ')
      const [before, block, after] = sweep(frame, 10)
      rows += live ? 3 : 1

      return (
        <Box flexDirection="column" marginBottom={live ? 1 : 0}>
          <Box flexDirection="row">
            <Box flexShrink={0}>
              <Text color={glyphColor}>{glyph} </Text>
            </Box>
            <Box flexGrow={1} flexShrink={1}>
              <Text wrap="truncate-end" bold={live} dimColor={!live}>
                {task.label}
              </Text>
            </Box>
            <Box flexShrink={0} marginLeft={1}>
              {!live && <Text dimColor>{tokens !== '' ? `${tokens} · ` : ''}{kindOf(task)}  </Text>}
              <Text color={live ? accent : undefined} dimColor={!live} bold={live} tabular>
                {elapsed}
              </Text>
            </Box>
          </Box>
          {live && (
            <Box flexDirection="row" paddingLeft={2}>
              <Box flexShrink={0}>
                {task.status === 'waiting' ? (
                  <Text dimColor>{'─'.repeat(10)} </Text>
                ) : (
                  <Text>
                    <Text dimColor>{before}</Text>
                    <Text color={accent} bold>{block}</Text>
                    <Text dimColor>{after} </Text>
                  </Text>
                )}
              </Box>
              <Box flexGrow={1} flexShrink={1}>
                <Text dimColor wrap="truncate-end">
                  {kindOf(task)}
                  {subline !== '' ? ` · ${subline}` : ''}
                </Text>
              </Box>
            </Box>
          )}
        </Box>
      )
    }

    // A section's title is a button: a click, or Enter under the focus,
    // folds the section to its title line and opens it again.
    const Heading = ({ id, text, count, color }: { id: string; text: string; count: string; color: string }) => {
      const open = isOpen(id)
      rows += open ? 2 : 1
      return (
        <Box flexDirection="row" marginBottom={open ? 1 : 0}>
          <Button key={`section-${id}`} plain onPress={() => void toggle(id)}>
            <Text color={color}>{open ? '▾ ' : '▸ '}</Text>
            <Text bold color={color}>{text}</Text>
            <Text dimColor> {count}</Text>
          </Button>
        </Box>
      )
    }

    const fgCount = fg.length + (isMainRunning ? 1 : 0)
    const nothing = fgCount === 0 && bg.length === 0 && ended.length === 0 && !showPlan

    const planPercent = plan.length === 0 ? 0 : Math.round((doneCount / plan.length) * 100)
    const [planOn, planOff] = bar(planPercent, Math.max(8, width - 6))

    const body = (
      <Box flexDirection="column" flexGrow={1} flexShrink={1} paddingLeft={1}>
        {nothing && (
          <Box flexDirection="column">
            <Text bold color="claude">Nothing running</Text>
            <Text dimColor wrap="wrap">
              The plan, the conversation, subagents, background commands and long tool calls show up here, with their time and tokens.
            </Text>
          </Box>
        )}

        {showPlan && (
          <Box flexDirection="column" marginBottom={1}>
            <Heading id="plan" text="Plan" count={`${doneCount}/${plan.length}`} color="claude" />
            <Box flexDirection="row" marginBottom={1}>
              <Text color={doneCount === plan.length ? 'success' : 'claude'}>{planOn}</Text>
              <Text dimColor>{planOff}</Text>
              <Text bold color={doneCount === plan.length ? 'success' : 'claude'}> {planPercent}%</Text>
            </Box>
            {isOpen('plan') && plan.map(item => {
              rows += 1
              const isDone = item.status === 'completed'
              const isNow = item.status === 'in_progress'
              return (
                <Box key={item.id} flexDirection="row">
                  <Box flexShrink={0}>
                    <Text color={isDone ? 'success' : isNow ? 'claude' : undefined} dimColor={!isDone && !isNow}>
                      {isDone ? '✓' : isNow ? spin : '○'}{' '}
                    </Text>
                  </Box>
                  <Text wrap="truncate-end" bold={isNow} dimColor={isDone || !isNow} strikethrough={isDone}>
                    {isNow ? (item.activeForm ?? item.subject) : item.subject}
                  </Text>
                </Box>
              )
            })}
          </Box>
        )}

        {fgCount > 0 && (
          <Box flexDirection="column">
            <Heading id="fg" text="Foreground" count={String(fgCount)} color="claude" />
            {isOpen('fg') && isMainRunning && turn !== null && (
              <Row
                task={{
                  id: 'main',
                  kind: 'agent',
                  label: 'Conversation',
                  detail: `${turn.steps} ${turn.steps === 1 ? 'step' : 'steps'} · ctx ${fmtTokens(turn.context)} · ${fmtTokens(turn.output)} out`,
                  isBackground: false,
                  status: 'running',
                  startedAt: turn.startedAt,
                  context: 0,
                  output: 0,
                  steps: 0,
                }}
              />
            )}
            {isOpen('fg') && fg.map(t => (
              <Row key={t.id} task={t} />
            ))}
          </Box>
        )}

        {bg.length > 0 && (
          <Box flexDirection="column">
            <Heading id="bg" text="Background" count={String(bg.length)} color="suggestion" />
            {isOpen('bg') && bg.map(t => (
              <Row key={t.id} task={t} />
            ))}
          </Box>
        )}

        {ended.length > 0 && (
          <Box flexDirection="column">
            <Heading id="done" text="Finished" count={String(ended.length)} color="subtle" />
            {isOpen('done') && ended.map(t => (
              <Row key={t.id} task={t} />
            ))}
          </Box>
        )}
      </Box>
    )

    // The session's memory, small and dim, pinned to the panel's bottom
    // edge; the swapped part only when there is some (at least 1 MB). Under
    // it, the machine's memory still available, amber under 20% and red under
    // 10%.
    const hasSwap = mem !== null && mem.swapped >= 1024 * 1024
    const total = mem?.systemTotal
    const available = mem?.systemAvailable
    const hasSystem = total !== undefined && available !== undefined
    const freeShare = hasSystem ? available / total : 1
    const freeColor = freeShare < 0.1 ? 'error' : freeShare < 0.2 ? 'warning' : undefined
    const memLines = mem !== null && (
      <Box flexDirection="column" flexShrink={0} paddingLeft={1} alignItems="flex-end">
        <Box flexDirection="row">
          <Text dimColor>mem </Text>
          <Text dimColor bold tabular>{fmtBytes(mem.bytes)}</Text>
          {hasSwap && <Text dimColor>  swap </Text>}
          {hasSwap && <Text color="warning" tabular>{fmtBytes(mem.swapped)}</Text>}
        </Box>
        {hasSystem && (
          <Box flexDirection="row">
            <Text dimColor>free </Text>
            <Text color={freeColor} dimColor={freeColor === undefined} bold tabular>{fmtBytes(available)}</Text>
            <Text dimColor> of {fmtBytes(total)}</Text>
          </Box>
        )}
      </Box>
    )

    // The divider: a bold accent rule down the panel's left edge, as tall as
    // the panel or its content, whichever is taller.
    const height = Math.max(e.props.scroll.bodyRows, rows + (nothing ? 3 : 2) + (mem === null ? 0 : hasSystem ? 3 : 2))
    return (
      <Box flexDirection="row">
        <Box flexDirection="column" flexShrink={0}>
          <Text color="claude" bold>
            {Array.from({ length: height }, () => '┃').join('\n')}
          </Text>
        </Box>
        <Box flexDirection="column" flexGrow={1} flexShrink={1} height={height}>
          {body}
          {memLines}
        </Box>
      </Box>
    )
  })

  // ── drawing: the meter, bottom right under the prompt ──
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    if (await read($, meterHidden)) return next(e)
    const m = await read($, meter)
    const sum = await read($, totals)
    if (m === null && sum.input + sum.output === 0) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    const isCompact = await read($, meterCompact)
    const screen = (e.viewport?.columns ?? 80) + dockColumns
    // Compact: percentages and the 5h reset only, no bars or token counts.
    const isWide = !isCompact && screen >= 120
    const isRoomy = !isCompact && screen >= 90

    const parts: unknown[] = []
    const dot = (k: string) => (
      <Text key={k} dimColor>
        {'  ·  '}
      </Text>
    )

    if (isRoomy && sum.input + sum.output > 0) {
      parts.push(
        <Text key="tok">
          <Text dimColor>tokens </Text>
          <Text>{fmtTokens(sum.input)}</Text>
          <Text dimColor>↓ </Text>
          <Text>{fmtTokens(sum.output)}</Text>
          <Text dimColor>↑</Text>
        </Text>,
      )
    }

    const now = await $.clock.now()
    const limit = (key: string, label: string, short: string, percent?: number, resetsAt?: string) => {
      if (percent === undefined) return
      const at = resetsAt === undefined ? NaN : Date.parse(resetsAt)
      const hasReset = at <= now
      const p = hasReset ? 0 : Math.round(percent)
      const [filled, empty] = bar(p, 5)
      if (parts.length > 0) parts.push(dot(`d-${key}`))
      parts.push(
        <Text key={key}>
          <Text dimColor>{isCompact ? short : label} </Text>
          {isRoomy && <Text color={levelColor(p)}>{filled}</Text>}
          {isRoomy && <Text dimColor>{empty} </Text>}
          <Text color={levelColor(p)} bold>{p}%</Text>
          {at > now && (!isCompact || key === '5h') && <Text dimColor> ↻ {fmtUntil(at - now)}</Text>}
        </Text>,
      )
    }
    limit('5h', '5h', '5h', m?.fiveHourPercent, m?.fiveHourResetsAt)
    limit('wk', 'week', 'wk', m?.weekPercent, m?.weekResetsAt)
    for (const l of MODEL_LIMITS) {
      const w = m?.models?.find(r => r.kind === l.kind)
      if (w !== undefined) limit(l.kind, l.label, l.short, w.percentUsed, w.resetsAt)
    }

    if (m !== null) {
      const p = m.contextPercent ?? 0
      const [onC, offC] = isCompact ? ['', ''] : bar(p, isWide ? 10 : 6)
      if (parts.length > 0) parts.push(dot('d-ctx'))
      parts.push(
        <Text key="ctx">
          <Text dimColor>{isCompact ? 'ctx' : 'context'} </Text>
          {!isCompact && <Text color={levelColor(p)}>{onC}</Text>}
          {!isCompact && <Text dimColor>{offC} </Text>}
          <Text color={levelColor(p)} bold>{Math.round(p)}%</Text>
          {isWide && (
            <Text dimColor>
              {' '}
              {fmtTokens(m.contextTokens ?? 0)}/{fmtTokens(m.contextWindow)}
            </Text>
          )}
        </Text>,
      )
    }

    // The hint line is indented two columns; keep two more clear at the edge.
    const engine = await next(e)
    return (
      <Box flexDirection="column">
        {engine}
        <Box flexDirection="row" justifyContent="flex-end" width={Math.max(20, screen - 4)}>
          {parts as never}
          <Box marginLeft={2}>
            <Button key="meter-size" label={isCompact ? 'Expand the usage meter' : 'Compact the usage meter'} plain dimColor onPress={() => void toggleCompact($)}>
              {isCompact ? '+' : '−'}
            </Button>
          </Box>
        </Box>
      </Box>
    )
  })
}
