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
}

export type Totals = { input: number; output: number }

declare module 'claude-code' {
  interface PluginState {
    'task-monitor': {
      tasks: Shaped<Task[]>
      main: Shaped<MainTurn | null>
      meter: Shaped<Meter | null>
      totals: Shaped<Totals>
      meterHidden: boolean
    }
  }
}
