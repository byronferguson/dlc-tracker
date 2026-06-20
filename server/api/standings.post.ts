import { getLedger, type TrackedPlayer } from '../utils/ravensburger'
import { DEFAULT_EVENT_ID, DEFAULT_PLAYERS } from '#shared/defaults'

const MAX_PLAYERS = 100

export default defineEventHandler(async (event) => {
  const body = await readBody<{ eventId?: string; players?: TrackedPlayer[]; force?: boolean }>(event).catch(() => ({}))

  const eventId = String(body?.eventId ?? DEFAULT_EVENT_ID).replace(/\D/g, '') || DEFAULT_EVENT_ID

  const players: TrackedPlayer[] = Array.isArray(body?.players)
    ? body!.players!
        .map((p) => ({ name: String(p?.name ?? '').slice(0, 60), username: String(p?.username ?? '').slice(0, 80) }))
        .filter((p) => p.username.trim().length > 0)
        .slice(0, MAX_PLAYERS)
    : DEFAULT_PLAYERS

  try {
    const ledger = await getLedger(eventId, players, body?.force === true)
    setResponseHeader(event, 'cache-control', 'public, max-age=20')
    return ledger
  } catch (err: any) {
    throw createError({
      statusCode: 502,
      statusMessage: 'Could not reach Ravensburger Play',
      data: { message: err?.message ?? String(err) },
    })
  }
})
