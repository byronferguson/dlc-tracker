import { getLedger } from '../utils/ravensburger'

export default defineEventHandler(async (event) => {
  const cfg = useRuntimeConfig(event)
  const q = getQuery(event)
  const eventId = String(q.eventId ?? cfg.public.eventId)
  const force = q.force === '1' || q.force === 'true'

  try {
    const ledger = await getLedger(eventId, force)
    // let Cloudflare's edge cache hold it briefly too
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
