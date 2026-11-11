import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'task-monitor',
  component: 'Pane',
  requestId: 'task-monitor',
  props: {
    title: 'Tasks',
    isFocused: false,
    bodyColumns: 44,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const HINT = {
  plugin: 'task-monitor',
  component: 'PromptHint',
  requestId: 'hint',
  props: { isDraft: false, isWorking: true, hint: 'esc to interrupt' },
  viewport: { columns: 140, rows: 40 },
} as const

test('the panel lists foreground and background tasks', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  on('command.register', () => ({ value: { command: 'task-monitor' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.list', () => ({ value: [] }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: 76000, window: 200000, percent: 38 }, rateLimits: [{ kind: 'five_hour', percentUsed: 42 }] },
  }))
  on('tool.call', (_, e) =>
    String(e.tool) === 'Bash' ? { result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1' } } : { result: {} },
  )

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'npm test', description: 'Correr pruebas', run_in_background: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Background/ }))).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /Correr pruebas/ }))).toBeDefined()
  await ui.unmount()
})

test('the empty panel says so', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Nothing running/ }))).toBeDefined()
  await ui.unmount()
})

test('the meter under the prompt shows context and the 5h limit', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  on('command.register', () => ({ value: { command: 'task-monitor' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: 76000, window: 200000, percent: 38 }, rateLimits: [{ kind: 'five_hour', percentUsed: 42 }] },
  }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...HINT, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /38%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /42%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /76k\/200k/ })).toBeDefined()
  await ui.unmount()
})

test('"/task-monitor meter" hides the meter', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  on('command.register', () => ({ value: { command: 'task-monitor' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: 76000, window: 200000, percent: 38 }, rateLimits: [] },
  }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'task-monitor', args: 'meter' })

  const ui = await $.ui.mount({ ...HINT, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /38%/ })).toBeUndefined()
  await ui.unmount()
})
