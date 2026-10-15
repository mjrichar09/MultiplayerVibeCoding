import { expect, mock, test } from 'claude-code/testing'

const BOARD = {
  setUp: true,
  me: 'bob',
  members: [
    {
      user: 'alice',
      claims: [
        {
          slug: 'redo-checkout',
          task: 'Redo checkout flow',
          paths: ['src/checkout/**'],
          branch: 'alice/redo-checkout',
          device: 'laptop',
          started: '2026-10-15T08:00:00.000Z',
          updated: '2026-10-15T10:00:00.000Z',
          stale: false,
          mergedPr: null,
        },
      ],
    },
    { user: 'bob', claims: [] },
    { user: 'carol', claims: [] },
  ],
  notes: [{ user: 'carol', title: 'Staging DB is down', created: '2026-10-15T09:00:00.000Z' }],
  handoffs: [{ from: 'carol', to: ['bob'], title: 'Finish the email fixes', created: '2026-10-15T09:30:00.000Z' }],
}

const BAND = {
  plugin: 'multiplayer',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 9 },
    view: {},
  },
} as const


test('the band shows the whole team once the board has loaded', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-15T12:00:00.000Z') })
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('session.root', async () => ({ value: '/work/app' }))
  on('ui.render', async ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('process.run', async (_$, e) => {
    expect(e.argv.slice(2, 4)).toEqual(['board', '--json'])
    expect(e.argv).not.toContain('--sync') // a command answers from what this clone knows
    return { value: { exitCode: 0, stdout: JSON.stringify(BOARD), stderr: '' } }
  })
  await $.command.run({ command: 'team-board', args: '' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /Redo checkout flow/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /alice/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /src\/checkout\/\*\* · 2h/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /no claims: you, carol · 1 handoff for you · 1 team note/ })).toBeDefined()
    await ui.unmount()
  }
})

test('the band stays out of the way until there is a team to show', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-15T12:00:00.000Z') })
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('session.root', async () => ({ value: '/work/app' }))
  on('ui.render', async ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('process.run', async () => ({ value: { exitCode: 0, stdout: JSON.stringify({ setUp: false }), stderr: '' } }))
  await $.command.run({ command: 'team-board', args: '' })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /claims/ })).toBeUndefined()
  await ui.unmount()
})

test('/team-board opens a pane with everyone, handoffs, and notes', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-15T12:00:00.000Z') })
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('session.root', async () => ({ value: '/work/app' }))
  on('process.run', async () => ({ value: { exitCode: 0, stdout: JSON.stringify(BOARD), stderr: '' } }))
  expect(await $.command.run({ command: 'team-board', args: '' })).toEqual({ text: 'Opened the team board.' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'multiplayer',
      surface,
      component: 'Pane',
      requestId: 'team-board',
      props: { title: 'Team', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
    })
    expect(await ui.find({ type: 'Text', text: 'bob (you)' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /alice\/redo-checkout · updated 2h ago/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /carol → bob: Finish the email fixes/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /carol: Staging DB is down/ })).toBeDefined()
    await ui.unmount()
  }
})
