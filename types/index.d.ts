export type TaskKind = 'agent' | 'shell' | 'tool'
export type TaskStatus = 'running' | 'waiting' | 'done' | 'failed' | 'killed'

export type Task = {
  id: string
  kind: TaskKind
  label: string
  detail: string
  isBackground: boolean
  status: TaskStatus
  startedAt: number
  endedAt?: number
  /** Context of the latest model request (input + cache), for agents. */
  context: number
  /** Output tokens summed over the agent's requests. */
  output: number
  steps: number
  /** What the agent is doing right now (its running tool), if anything. */
  activity?: string
}

export type MainTurn = {
  startedAt: number
  endedAt?: number
  steps: number
  context: number
  output: number
}

export type Meter = {
  contextTokens?: number
  contextWindow: number
  contextPercent?: number
  fiveHourPercent?: number
  fiveHourResetsAt?: string
  weekPercent?: number
  weekResetsAt?: string
  // Model windows beside the weekly one (Fable, Opus, Sonnet), when the plan has them.
  models?: { kind: string; percentUsed: number; resetsAt?: string }[]
}

export type Totals = { input: number; output: number }

/** The Claude Code process's memory, as the system reports it. */
export type Memory = {
  pid: number
  /** Memory in use: the footprint Activity Monitor shows on macOS, the resident set on Linux. */
  bytes: number
  /** Of it, swapped out (on macOS also compressed: the system does not tell the two apart per process). */
  swapped: number
  /** The machine's physical memory, and how much of it is still available. */
  systemTotal?: number
  systemAvailable?: number
}

export type Todo = {
  id: string
  subject: string
  activeForm?: string
  status: 'pending' | 'in_progress' | 'completed'
}

declare module 'claude-code' {
  interface PluginState {
    'task-monitor': {
      tasks: Shaped<Task[]>
      main: Shaped<MainTurn | null>
      meter: Shaped<Meter | null>
      totals: Shaped<Totals>
      meterHidden: boolean
      meterCompact: boolean
      todos: Shaped<Todo[]>
      collapsed: Shaped<string[]>
      memory: Shaped<Memory | null>
    }
  }
}
