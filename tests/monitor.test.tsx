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


test('the panel lists foreground and background tasks, and folds a section', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  on('ui.status', () => ({ value: undefined }))
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

  // The section title folds the section, and opens it again.
  await ui.press({ key: 'section-bg' })
  expect((await ui.find({ type: 'Text', text: /Background/ }))).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /Correr pruebas/ }))).toBeUndefined()
  await ui.press({ key: 'section-bg' })
  expect((await ui.find({ type: 'Text', text: /Correr pruebas/ }))).toBeDefined()
  await ui.unmount()
})

test('a folded section stays folded in the next session', async ($, on) => {
  mock.clock(on)
  mock.store(on, { collapsed: ['bg'] })
  on('ui.status', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'task-monitor' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.list', () => ({ value: [] }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] } }))
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1' } }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'npm test', description: 'Correr pruebas', run_in_background: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Background/ }))).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /Correr pruebas/ }))).toBeUndefined()
  await ui.unmount()
})

test('the empty panel says so', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Nothing running/ }))).toBeDefined()
  await ui.unmount()
})

const HINT = {
  plugin: 'task-monitor',
  component: 'PromptHint',
  requestId: 'hint',
  props: { isDraft: false, isWorking: true, hint: 'esc to interrupt' },
  viewport: { columns: 140, rows: 40 },
} as const

const NOW = Date.parse('2026-11-12T10:00:00Z')

test('the meter shows context, the 5h and weekly limits with their resets, compacts and hides', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  on('ui.status', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'task-monitor' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  const inMinutes = (m: number) => new Date(NOW + m * 60_000).toISOString()
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: 76000, window: 200000, percent: 38 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 42, resetsAt: inMinutes(134) },
        { kind: 'seven_day', percentUsed: 18, resetsAt: inMinutes(3 * 24 * 60 + 4 * 60) },
        { kind: 'seven_day_overage_included', percentUsed: 27, resetsAt: inMinutes(5 * 24 * 60) },
      ],
    },
  }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  let ui = await $.ui.mount({ ...HINT, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /38%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /42%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /76k\/200k/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /2h 14m/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /18%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /3d 4h/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /fable/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /27%/ })).toBeDefined()

  // The button at its end compacts it: percentages stay, bars and counts go.
  await ui.press({ key: 'meter-size' })
  expect(await ui.find({ type: 'Text', text: /38%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /76k\/200k/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /▰/ })).toBeUndefined()
  await ui.press({ key: 'meter-size' })
  expect(await ui.find({ type: 'Text', text: /76k\/200k/ })).toBeDefined()
  await ui.unmount()

  await $.command.run({ command: 'task-monitor', args: 'meter' } as never)
  ui = await $.ui.mount({ ...HINT, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /38%/ })).toBeUndefined()
  await ui.unmount()
})

test('the plan shows its progress', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  on('tool.call', () => ({ result: { oldTodos: [], newTodos: [] } }))
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'Set up the repo', status: 'completed', activeForm: 'Setting up the repo' },
      { content: 'Write the tests', status: 'in_progress', activeForm: 'Writing the tests' },
      { content: 'Publish', status: 'pending', activeForm: 'Publishing' },
    ],
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /1\/3/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /33%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Writing the tests/ })).toBeDefined()
  await ui.unmount()
})

test('the panel shows the session memory at its bottom, and swap only when used', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  on('ui.status', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'task-monitor' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.list', () => ({ value: [] }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] } }))
  let stdout = '91112 383665688 75448320\n17179869184 2516090880\n'
  on('process.run', () => ({
    value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(5000)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^366 MB$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^72 MB$/ })).toBeDefined()
  // The machine's memory still available.
  expect(await ui.find({ type: 'Text', text: /^2\.3 GB$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: / of 16\.0 GB/ })).toBeDefined()
  await ui.unmount()

  stdout = '91112 1288490188 0\n'
  await clock.advance(5000)
  const later = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await later.find({ type: 'Text', text: /^1\.2 GB$/ })).toBeDefined()
  expect(await later.find({ type: 'Text', text: /swap/ })).toBeUndefined()
  await later.unmount()
})
