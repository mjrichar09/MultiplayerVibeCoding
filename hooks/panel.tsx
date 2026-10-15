// The team panel (PLAN §2.10): an always-visible band above the prompt showing
// who on the team is working on what, plus a fuller pane on /team-board. It
// reads `multiplayer board --json`: locally after each turn (instant), and with
// a pull of teammates' changes every minute.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Board, BoardClaim } from '../types'

const board = atom({ plugin: 'multiplayer', key: 'board' } as const, null)
const PANE = 'team-board'
const SYNC_EVERY_MS = 60_000

function ago(iso: string, now: number): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`
}

const files = (c: BoardClaim, max: number) =>
  c.paths.slice(0, max).join(', ') + (c.paths.length > max ? ` +${c.paths.length - max}` : '')

let running = false

async function refresh($: EngineInterface, sync: boolean) {
  if (running) return
  running = true
  try {
    const cli = `${$.plugin.root}/scripts/multiplayer.mjs`
    const { exitCode, stdout } = await $.process.run(
      ['node', cli, 'board', '--json', ...(sync ? ['--sync'] : [])],
      { cwd: await $.session.root(), timeoutMs: 30_000 },
    )
    if (exitCode !== 0) return // not a git repo, or the plugin broke: keep what we had
    const next = JSON.parse(stdout) as Board
    await update($, board, () => next)
  } catch {
    // Offline or slow: the next tick tries again.
  } finally {
    running = false
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'team-board',
      description: "Open a pane with the team's claims, handoffs, and notes",
    })
    await refresh($, false) // what this clone already knows: instant
    // Pulls of teammates' changes run on timers, which outlive this hook.
    $.clock.after(0, () => void refresh($, true))
    $.clock.every(SYNC_EVERY_MS, () => void refresh($, true))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    await refresh($, false) // my own claims change during a turn
    return next(e)
  })

  on('command.run', { command: 'team-board' }, async $ => {
    await refresh($, false)
    await $.ui.open({ id: PANE, title: 'Team' })
    return { text: 'Opened the team board.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const b = await read($, board)
    if (e.props.hasSurvey || !b?.setUp || !b.members?.length) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    const width = e.props.bodyColumns
    const nameWidth = Math.min(12, Math.max(...b.members.map(m => m.user.length)) + 1)
    const working = b.members.filter(m => m.claims.length)
    const idle = b.members.filter(m => !m.claims.length).map(m => (m.user === b.me ? 'you' : m.user))
    const forMe = (b.handoffs ?? []).filter(handoff => b.me && handoff.to.includes(b.me))
    const extras = [
      forMe.length && `${forMe.length} handoff${forMe.length > 1 ? 's' : ''} for you`,
      b.notes?.length && `${b.notes.length} team note${b.notes.length > 1 ? 's' : ''}`,
    ].filter(Boolean)

    return (
      <Box flexDirection="column" width={width}>
        {working.flatMap(m =>
          m.claims.map((c, i) => (
            <Box key={`${m.user}-${c.slug}`}>
              <Text bold={m.user === b.me} wrap="truncate-end">
                {(i === 0 ? (m.user === b.me ? 'you' : m.user) : '').padEnd(nameWidth)}
              </Text>
              <Text wrap="truncate-end">
                {c.task}
                <Text dimColor> {files(c, 2)} · {ago(c.updated, now)}</Text>
                {c.stale && <Text color="yellow"> stale</Text>}
                {c.mergedPr !== null && <Text dimColor> (PR #{c.mergedPr} merged)</Text>}
              </Text>
            </Box>
          )),
        )}
        {working.length === 0 && <Text dimColor>Nobody has claimed any work right now.</Text>}
        {(idle.length > 0 || extras.length > 0) && (
          <Text dimColor wrap="truncate-end">
            {[idle.length ? `no claims: ${idle.join(', ')}` : '', ...extras, '/team-board for more']
              .filter(Boolean)
              .join(' · ')}
          </Text>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const b = await read($, board)
    if (!b) return <Text dimColor>Loading the team board…</Text>
    if (!b.setUp) return <Text dimColor>This repository has no multiplayer team yet.</Text>
    const now = await $.clock.now()
    return (
      <Box flexDirection="column">
        {(b.members ?? []).map(m => (
          <Box key={m.user} flexDirection="column" marginBottom={1}>
            <Text bold>{m.user === b.me ? `${m.user} (you)` : m.user}</Text>
            {m.claims.length === 0 && <Text dimColor>  no claims</Text>}
            {m.claims.map(c => (
              <Box key={c.slug} flexDirection="column">
                <Text>
                  {'  '}
                  {c.task}
                  {c.stale && <Text color="yellow"> (stale)</Text>}
                  {c.mergedPr !== null && <Text dimColor> (PR #{c.mergedPr} merged)</Text>}
                </Text>
                <Text dimColor wrap="truncate-end">
                  {'    '}
                  {files(c, 6)}
                  {c.branch ? ` · ${c.branch}` : ''} · updated {ago(c.updated, now)} ago
                </Text>
              </Box>
            ))}
          </Box>
        ))}
        {(b.handoffs?.length ?? 0) > 0 && (
          <Box flexDirection="column" marginBottom={1}>
            <Text bold>Handoffs waiting</Text>
            {b.handoffs!.map(handoff => (
              <Text key={`${handoff.from}-${handoff.created}`} wrap="truncate-end">
                {'  '}
                {handoff.from} → {handoff.to.join(', ')}: {handoff.title}
              </Text>
            ))}
          </Box>
        )}
        {(b.notes?.length ?? 0) > 0 && (
          <Box flexDirection="column">
            <Text bold>Team notes</Text>
            {b.notes!.map(n => (
              <Text key={`${n.user}-${n.created}`} wrap="truncate-end">
                {'  '}
                {n.user}: {n.title} <Text dimColor>({ago(n.created, now)} ago)</Text>
              </Text>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}
