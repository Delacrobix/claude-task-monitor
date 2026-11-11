import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, TurnUsage } from 'claude-code'

import type { MainTurn, Meter, Task, TaskStatus, Totals } from '../types'

const PANE = 'task-monitor'
const TITLE = 'Tasks'
const KEEP_FINISHED = 8
const STORE_PANE_HIDDEN = 'paneHidden'
const STORE_METER_HIDDEN = 'meterHidden'
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
const meterHidden = atom({ plugin: 'task-monitor', key: 'meterHidden' } as const, false)
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

const SPIN = ['◐', '◓', '◑', '◒']

function toolLabel(e: Record<string, unknown>, tool: string): string {
  for (const field of ['description', 'file_path', 'pattern', 'url', 'query', 'command', 'prompt']) {
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
  const five = usage.rateLimits.find(r => r.kind === 'five_hour')
  const next: Meter = {
    contextTokens: usage.context.tokens,
    contextWindow: usage.context.window,
    contextPercent: usage.context.percent,
    fiveHourPercent: five?.percentUsed,
    fiveHourResetsAt: five?.resetsAt,
  }
  await update($, meter, () => next)
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
  // Background flag of agents about to start, by description: a foreground
  // agent's spawn may resolve only when it ends, so `turn.start` reads this.
  const pendingBackground = new Map<string, boolean>()

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'task-monitor',
      description: 'Show or hide the tasks panel; "/task-monitor meter" shows or hides the usage meter',
      argumentHint: '[meter]',
    })
    const isMeterHidden = (await $.store.get(STORE_METER_HIDDEN)) === true
    await update($, meterHidden, () => isMeterHidden)
    if ((await $.store.get(STORE_PANE_HIDDEN)) !== true) void $.ui.open({ id: PANE, title: TITLE })
    void refreshMeter($).catch(() => undefined)

    // While something runs, redraw each second so the clocks tick; and ask
    // the engine whether any agent we still show as running has ended.
    $.clock.every(1000, () => {
      void (async () => {
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
    if (arg !== '') return { text: 'Usage: /task-monitor to show or hide the panel, /task-monitor meter for the usage meter.' }

    const isOpen = (await $.ui.panes()).some(pane => pane.id === PANE)
    if (isOpen) {
      await $.store.set(STORE_PANE_HIDDEN, true)
      await $.ui.close({ id: PANE })
      return { text: 'Tasks panel hidden; it stays hidden in new sessions until "/task-monitor".' }
    }
    await $.store.set(STORE_PANE_HIDDEN, false)
    const opened = await $.ui.open({ id: PANE, title: TITLE })
    return {
      text: opened.isPlaced ? 'Tasks panel shown.' : 'The tasks panel will show once the terminal has room.',
    }
  })

  // Closing the pane by hand (its close mark, ctrl+x x) keeps it closed in
  // later sessions too, until "/task-monitor" shows it again.
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person') await $.store.set(STORE_PANE_HIDDEN, true)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, tasks, () => [])
      await update($, main, () => null)
      await update($, totals, () => ({ input: 0, output: 0 }))
    }
    return next(e)
  })

  // ── usage meter ──
  on('session.measure', async ($, e, next) => {
    const five = e.rateLimits.find(r => r.kind === 'five_hour')
    const value: Meter = {
      contextTokens: e.context.tokens,
      contextWindow: e.context.window,
      contextPercent: e.context.percent,
      fiveHourPercent: five?.percentUsed,
      fiveHourResetsAt: five?.resetsAt,
    }
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
    const { Box, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    const list = await read($, tasks)
    const turn = await read($, main)
    const spin = SPIN[Math.floor(now / 1000) % SPIN.length] ?? '◐'

    const isLive = (t: Task) => t.status === 'running' || t.status === 'waiting'
    const fg = list.filter(t => isLive(t) && !t.isBackground)
    const bg = list.filter(t => isLive(t) && t.isBackground)
    const ended = list.filter(t => !isLive(t))
    const isMainRunning = turn !== null && turn.endedAt === undefined

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
      const kind = task.kind === 'agent' ? task.detail : task.kind === 'shell' ? 'bash' : task.detail
      const sub =
        task.kind === 'agent'
          ? [task.activity ?? (task.status === 'waiting' ? 'waiting' : undefined), tokens && `${tokens} tok`, task.steps > 0 && `${task.steps} ${task.steps === 1 ? 'step' : 'steps'}`]
          : task.kind === 'shell'
            ? [task.detail]
            : []
      const subline = sub.filter(Boolean).join(' · ')

      return (
        <Box flexDirection="column" marginBottom={live ? 1 : 0}>
          <Box flexDirection="row">
            <Box flexShrink={0}>
              <Text color={glyphColor}>{glyph} </Text>
            </Box>
            <Box flexGrow={1} flexShrink={1}>
              <Text wrap="truncate-end" dimColor={!live}>
                <Text bold={live} color={live ? 'text' : undefined}>{task.label}</Text>
              </Text>
            </Box>
            <Box flexShrink={0} marginLeft={1}>
              {!live && tokens !== '' && <Text dimColor>{tokens}  </Text>}
              <Text color={live ? accent : undefined} dimColor={!live} bold={live} tabular>
                {elapsed}
              </Text>
            </Box>
          </Box>
          {live && (
            <Box flexDirection="row" paddingLeft={2}>
              <Text color={accent} dimColor>{kind}</Text>
              {subline !== '' && <Text dimColor wrap="truncate-end"> ⎿ {subline}</Text>}
            </Box>
          )}
        </Box>
      )
    }

    const Heading = ({ text, count, color }: { text: string; count: number; color: string }) => (
      <Box flexDirection="row" marginBottom={1}>
        <Text bold color={color}>{text}</Text>
        <Text dimColor> {count}</Text>
      </Box>
    )

    const fgCount = fg.length + (isMainRunning ? 1 : 0)
    const nothing = fgCount === 0 && bg.length === 0 && ended.length === 0

    return (
      <Box flexDirection="column" paddingX={1}>
        {nothing && (
          <Box flexDirection="column">
            <Text bold color="claude">Nothing running</Text>
            <Text dimColor wrap="wrap">
              The conversation, subagents, background commands and long tool calls show up here, with their time and tokens.
            </Text>
          </Box>
        )}

        {fgCount > 0 && (
          <Box flexDirection="column">
            <Heading text="Foreground" count={fgCount} color="claude" />
            {isMainRunning && turn !== null && (
              <Box flexDirection="column" marginBottom={1}>
                <Box flexDirection="row">
                  <Box flexShrink={0}>
                    <Text color="claude">{spin} </Text>
                  </Box>
                  <Box flexGrow={1} flexShrink={1}>
                    <Text bold wrap="truncate-end">Conversation</Text>
                  </Box>
                  <Box flexShrink={0} marginLeft={1}>
                    <Text color="claude" bold tabular>{fmtDuration(now - turn.startedAt)}</Text>
                  </Box>
                </Box>
                <Box paddingLeft={2}>
                  <Text dimColor wrap="truncate-end">
                    {turn.steps === 0
                      ? 'waiting for the model'
                      : `${turn.steps} ${turn.steps === 1 ? 'step' : 'steps'} · ctx ${fmtTokens(turn.context)} · ${fmtTokens(turn.output)} out`}
                  </Text>
                </Box>
              </Box>
            )}
            {fg.map(t => (
              <Row key={t.id} task={t} />
            ))}
          </Box>
        )}

        {bg.length > 0 && (
          <Box flexDirection="column">
            <Heading text="Background" count={bg.length} color="suggestion" />
            {bg.map(t => (
              <Row key={t.id} task={t} />
            ))}
          </Box>
        )}

        {ended.length > 0 && (
          <Box flexDirection="column">
            <Heading text="Finished" count={ended.length} color="subtle" />
            {ended.map(t => (
              <Row key={t.id} task={t} />
            ))}
          </Box>
        )}
      </Box>
    )
  })

  // ── drawing: the meter, bottom right under the prompt ──
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    if (await read($, meterHidden)) return next(e)
    const m = await read($, meter)
    const sum = await read($, totals)
    const columns = e.viewport?.columns ?? 80
    if (m === null && sum.input + sum.output === 0) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const isWide = columns >= 110
    const isRoomy = columns >= 90

    const parts: unknown[] = []
    const dot = (k: string) => (
      <Text key={k} dimColor>
        {'  ·  '}
      </Text>
    )

    if (sum.input + sum.output > 0) {
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

    if (m?.fiveHourPercent !== undefined) {
      const p = Math.round(m.fiveHourPercent)
      const [on5, off5] = bar(p, 5)
      if (parts.length > 0) parts.push(dot('d1'))
      parts.push(
        <Text key="5h">
          <Text dimColor>5h </Text>
          {isRoomy && <Text color={levelColor(p)}>{on5}</Text>}
          {isRoomy && <Text dimColor>{off5} </Text>}
          <Text color={levelColor(p)} bold>{p}%</Text>
        </Text>,
      )
    }

    if (m !== null) {
      const p = m.contextPercent ?? 0
      const [onC, offC] = bar(p, isWide ? 10 : 6)
      if (parts.length > 0) parts.push(dot('d2'))
      parts.push(
        <Text key="ctx">
          <Text dimColor>context </Text>
          <Text color={levelColor(p)}>{onC}</Text>
          <Text dimColor>{offC} </Text>
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

    const engine = await next(e)
    return (
      <Box flexDirection="row" justifyContent="space-between">
        {engine}
        <Box flexShrink={0} marginLeft={2}>
          {parts as never}
        </Box>
      </Box>
    )
  })
}
