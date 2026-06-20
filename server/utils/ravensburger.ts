/**
 * Server-side client for the Ravensburger Play (Cardeio) public "TV" API.
 *
 * The browser cannot call this API directly: it only returns CORS headers to
 * tcg.ravensburgerplay.com, and it requires a custom `app-name` header that a
 * generic CORS proxy won't forward. So all upstream calls happen here, in Nitro,
 * and the page talks to our own /api/standings instead.
 */

export type RoundResult = 'W' | 'L' | 'D' | 'B' | 'P' // P = paired, not yet decided

export interface RoundMatch {
  round: number
  table: number | null
  opponent: string | null // null for a bye
  gamesFor: number
  gamesAgainst: number
  result: RoundResult
  bye: boolean
}

export interface CrewMember {
  name: string // the person's first name, how we refer to them
  playhub: string // their PlayHub login handle
  discord: string // Discord display name (may be empty)
  tv: string // exact display name as it appears in the official standings
  ink: string // fallback ink colour when the API has no profile image
}

export interface CrewStanding extends CrewMember {
  found: boolean
  rank: number | null
  wins: number
  losses: number
  draws: number
  points: number
  matchWinPct: number | null
  oppMatchWinPct: number | null
  gameWinPct: number | null
  liveInk: string[] // ink colours parsed from the official profile image, if any
  rounds: Record<number, RoundResult>
  matches: RoundMatch[] // per-round opponent + game record, for the expanded view
}

export interface RoundInfo {
  number: number
  status: string // UPCOMING | IN_PROGRESS | COMPLETE
  id: number
}

export interface EventState {
  name: string
  lifecycle: string
  phaseLabel: string
  startingPlayers: number
  registeredPlayers: number
  totalRounds: number
  activeRound: number | null
  rounds: RoundInfo[]
  // round timer (epoch ms; null when not set)
  timerRunning: boolean
  timerEndsAt: number | null
  timerPausedAt: number | null
  roundDurationMin: number | null
}

export interface LedgerPayload {
  event: EventState
  crew: CrewStanding[]
  updatedAt: string
  stale: boolean
}

// The crew. `tv` is the canonical display name confirmed against the live
// standings; `ink` is a fallback colour used only when a player has the default
// avatar (no ink in their profile image).
export const ROSTER: CrewMember[] = [
  { name: 'Nick', playhub: 'Chef_Nick', discord: '@Thoth1906', tv: 'Chef_Nick', ink: 'amber' },
  { name: 'Niki', playhub: 'disnerd_94', discord: '@Disnerd_94', tv: 'Disnerd_94', ink: 'amethyst' },
  { name: 'Jason', playhub: 'Izik', discord: '@izik', tv: 'izik', ink: 'sapphire' },
  { name: 'Sarah', playhub: 'Ladyreadsalot', discord: '@ladyreadsalot', tv: 'Ladyreadsalot (Sarah)', ink: 'amber' },
  { name: 'James', playhub: 'sleepy_sheeb', discord: '@3 rock trolls in a trenchcoat', tv: 'Sleepy_sheeb', ink: 'emerald' },
  { name: 'Alec', playhub: 'beelzebuth', discord: '@Alec G Wags', tv: 'Beelzebuth', ink: 'steel' },
  { name: 'Jeremy', playhub: 'JerpsDerps', discord: '@JerpsDerps', tv: 'JerpsDerps', ink: 'ruby' },
  { name: 'Matt', playhub: 'MOrrBridges', discord: '@MOrrBridges', tv: 'MOrrBridges', ink: 'emerald' },
  { name: 'Amy', playhub: 'AmyPond17', discord: '@AmyPond17', tv: 'AmyPond17', ink: 'sapphire' },
  { name: 'Charles', playhub: 'siimba', discord: '@Siimba 🦁', tv: 'Siimba (Charles)', ink: 'amethyst' },
  { name: 'Mike', playhub: 'BoLing4U', discord: '@Boling4u', tv: 'Boling4u (Michael)', ink: 'ruby' },
  { name: 'Fuchan', playhub: 'Richard Richey', discord: '', tv: 'Richard Richey', ink: 'steel' },
  { name: 'Max', playhub: 'littlei999', discord: '@littlei999', tv: 'Max “littlei999” Wendt', ink: 'ruby' },
  { name: 'Charlie', playhub: 'Charlie Wendt', discord: '', tv: 'Charlie Wendt', ink: 'amber' },
  { name: 'Justin', playhub: 'Malferon', discord: '@JCoogs', tv: 'Malferon', ink: 'sapphire' },
]

const INK_NAMES = ['Amber', 'Amethyst', 'Emerald', 'Ruby', 'Sapphire', 'Steel']

export function normName(s: string): string {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * Parse Ravensburger's loose timestamps to epoch ms.
 * They come like "2026-06-20T09:07-0500" — sometimes missing seconds and with a
 * colon-less offset, which Date can't parse reliably across runtimes.
 */
export function parseRbDate(s: string | null | undefined): number | null {
  if (!s) return null
  let v = String(s).trim()
  // add seconds if only HH:MM is present after the T
  v = v.replace(/T(\d{2}:\d{2})(?=[+\-Z]|$)/, 'T$1:00')
  // add a colon to a 4-digit timezone offset (-0500 -> -05:00)
  v = v.replace(/([+\-]\d{2})(\d{2})$/, '$1:$2')
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : t
}

/** Split a profile image filename like "AmberSteel.webp" into ["amber","steel"]. */
function inksFromImage(url: string | null | undefined): string[] {
  if (!url) return []
  const m = /\/profile\/([A-Za-z]+)\.webp/.exec(url)
  if (!m) return []
  const raw = m[1]
  const out: string[] = []
  let rest = raw
  // greedily peel known ink names off the front
  while (rest.length) {
    const hit = INK_NAMES.find((n) => rest.startsWith(n))
    if (!hit) break
    out.push(hit.toLowerCase())
    rest = rest.slice(hit.length)
  }
  return out
}

type RbFetch = <T = any>(path: string) => Promise<T>

function makeClient(): RbFetch {
  const cfg = useRuntimeConfig()
  return <T>(path: string) =>
    $fetch<T>(`${cfg.rbApiBase}${path}`, {
      headers: {
        'app-name': cfg.rbAppName,
        accept: 'application/json',
        'user-agent': 'Mozilla/5.0 (dlc-tracker)',
      },
      timeout: 20000,
      retry: 1,
    })
}

interface Paged<T> {
  results: T[]
  next: number | null
  next_page_number: number | null
}

async function fetchAllPages<T>(rb: RbFetch, basePath: string): Promise<T[]> {
  const out: T[] = []
  let page = 1
  // hard cap so a misbehaving API can never loop forever (1746 / 500 = 4 pages)
  for (let guard = 0; guard < 12; guard++) {
    const sep = basePath.includes('?') ? '&' : '?'
    const data = await rb<Paged<T>>(`${basePath}${sep}page=${page}`)
    if (Array.isArray(data?.results)) out.push(...data.results)
    const next = data?.next_page_number ?? data?.next ?? null
    if (!next) break
    page = next
  }
  return out
}

interface TimerInfo {
  running: boolean
  endsAt: number | null
  pausedAt: number | null
  durationMin: number | null
}

/**
 * The /api/magic-events REST field truncates timer_end_datetime to the whole
 * minute (e.g. "10:36"), so a countdown built from it runs up to ~59s behind the
 * official clock. The rendered event page embeds the full-precision value
 * ("2026-06-20T15:36:59+00:00") — the same source the official UI uses — so we
 * scrape that first and fall back to the lossy REST field only if needed.
 */
// Scraping the ~1 MB event page is the most expensive part of a rebuild, and the
// round's end time barely changes within a round, so cache it for a while.
let timerCache: { key: string; at: number; data: TimerInfo } | null = null
const TIMER_TTL_MS = 90_000

async function fetchTimer(rb: RbFetch, eventId: string): Promise<TimerInfo> {
  const nowMs = Date.now()
  if (timerCache && timerCache.key === eventId && nowMs - timerCache.at < TIMER_TTL_MS) {
    return timerCache.data
  }
  const data = await fetchTimerUncached(rb, eventId)
  timerCache = { key: eventId, at: nowMs, data }
  return data
}

async function fetchTimerUncached(rb: RbFetch, eventId: string): Promise<TimerInfo> {
  try {
    const html = await $fetch<string>(`https://tcg.ravensburgerplay.com/events/${eventId}`, {
      headers: { 'user-agent': 'Mozilla/5.0 (dlc-tracker)' },
      responseType: 'text',
      timeout: 20000,
      retry: 1,
    })
    const end = /timer_end_datetime\\?":\\?"([0-9T:+\-]+)/.exec(html)
    if (end) {
      const paused = /timer_paused_at_datetime\\?":\\?"([0-9T:+\-]+)/.exec(html)
      const dur = /round_duration_in_minutes\\?":(\d+)/.exec(html)
      return {
        running: /timer_is_running\\?":true/.test(html),
        endsAt: parseRbDate(end[1]),
        pausedAt: paused ? parseRbDate(paused[1]) : null,
        durationMin: dur ? Number(dur[1]) : null,
      }
    }
  } catch {
    // fall through to the REST field
  }
  try {
    const d = await rb<any>(`/api/magic-events/${eventId}/`)
    return {
      running: !!d?.timer_is_running,
      endsAt: parseRbDate(d?.timer_end_datetime),
      pausedAt: parseRbDate(d?.timer_paused_at_datetime),
      durationMin: d?.settings?.round_duration_in_minutes ?? null,
    }
  } catch {
    return { running: false, endsAt: null, pausedAt: null, durationMin: null }
  }
}

async function fetchEventState(rb: RbFetch, eventId: string): Promise<EventState> {
  // tv/ holds phases/rounds; the rendered page holds the precise round timer.
  const [tv, timer] = await Promise.all([
    rb<any>(`/api/v2/player/events/${eventId}/tv/`),
    fetchTimer(rb, eventId),
  ])
  const phases: any[] = Array.isArray(tv?.tournament_phases) ? tv.tournament_phases : []
  const activePhase = phases.find((p) => p?.status === 'IN_PROGRESS') ?? phases[phases.length - 1] ?? null

  const rounds: RoundInfo[] = (activePhase?.rounds ?? []).map((r: any) => ({
    number: r.round_number,
    status: r.status,
    id: r.id,
  }))
  const active = rounds.find((r) => r.status === 'IN_PROGRESS')

  return {
    name: tv?.name ?? 'Event',
    lifecycle: tv?.lifecycle_status ?? '',
    phaseLabel: activePhase?.round_type ? `${activePhase.round_type} · ${activePhase.number_of_rounds} rounds` : '',
    startingPlayers: tv?.starting_player_count ?? 0,
    registeredPlayers: tv?.registered_user_count ?? 0,
    totalRounds: activePhase?.number_of_rounds ?? rounds.length,
    activeRound: active?.number ?? null,
    rounds,
    timerRunning: timer.running,
    timerEndsAt: timer.endsAt,
    timerPausedAt: timer.pausedAt,
    roundDurationMin: timer.durationMin,
  }
}

// Minimal shape we keep from each match — drops everything we don't render so the
// cache stays small and iteration stays cheap.
interface SlimMatch {
  table: number | null
  status: string
  bye: boolean
  players: { n: string; w: boolean; g: number }[]
}

// Completed rounds never change, so cache their (slim) matches permanently; the
// active round is re-fetched each rebuild. This keeps per-rebuild work to ~one round.
const roundCache = new Map<string, SlimMatch[]>()

async function getRoundSlim(rb: RbFetch, eventId: string, round: RoundInfo): Promise<SlimMatch[]> {
  const cacheKey = `${eventId}:${round.id}`
  if (round.status === 'COMPLETE' && roundCache.has(cacheKey)) return roundCache.get(cacheKey)!
  let raw: any[] = []
  try {
    raw = await fetchAllPages<any>(rb, `/api/v2/player/events/${eventId}/tv/matches/?round_id=${round.id}`)
  } catch {
    return [] // round may 404 before pairings post
  }
  const slim: SlimMatch[] = raw.map((m) => ({
    table: m?.table_number ?? null,
    status: m?.status,
    bye: !!m?.match_is_bye,
    players: (Array.isArray(m?.players) ? m.players : []).map((p: any) => ({
      n: p?.tv_display_name ?? '',
      w: !!p?.is_winner,
      g: p?.games_won ?? 0,
    })),
  }))
  if (round.status === 'COMPLETE') roundCache.set(cacheKey, slim)
  return slim
}

/** Build normName -> RoundMatch[] (opponent + game record per round) from each decided/active round. */
async function fetchRoundMatches(
  rb: RbFetch,
  eventId: string,
  rounds: RoundInfo[],
  crewKeys: Set<string>,
): Promise<Map<string, RoundMatch[]>> {
  const byPlayer = new Map<string, RoundMatch[]>()
  const live = rounds.filter((r) => r.status === 'COMPLETE' || r.status === 'IN_PROGRESS')

  await Promise.all(
    live.map(async (round) => {
      const matches = await getRoundSlim(rb, eventId, round)
      for (const m of matches) {
        const complete = m.status === 'COMPLETE'
        const someWinner = m.players.some((p) => p.w)
        for (const p of m.players) {
          const key = normName(p.n)
          if (!crewKeys.has(key)) continue
          const opp = m.players.find((x) => normName(x.n) !== key)
          let result: RoundResult
          if (m.bye) result = 'B'
          else if (p.w) result = 'W'
          else if (someWinner) result = 'L'
          else if (complete) result = 'D'
          else result = 'P'
          const entry: RoundMatch = {
            round: round.number,
            table: m.table,
            opponent: m.bye ? null : opp?.n ?? null,
            gamesFor: p.g,
            gamesAgainst: m.bye ? 0 : opp?.g ?? 0,
            result,
            bye: m.bye,
          }
          const list = byPlayer.get(key) ?? []
          list.push(entry)
          byPlayer.set(key, list)
        }
      }
    }),
  )
  for (const list of byPlayer.values()) list.sort((a, b) => a.round - b.round)
  return byPlayer
}

export async function buildLedger(eventId: string): Promise<LedgerPayload> {
  const rb = makeClient()
  const crewKeys = new Set(ROSTER.map((m) => normName(m.tv)))

  const [event, standings] = await Promise.all([
    fetchEventState(rb, eventId),
    fetchAllPages<any>(rb, `/api/v2/player/events/${eventId}/tv/standings/`),
  ])

  const standingByKey = new Map<string, any>()
  for (const s of standings) standingByKey.set(normName(s?.tv_display_name), s)

  const matchesByKey = await fetchRoundMatches(rb, eventId, event.rounds, crewKeys)

  const crew: CrewStanding[] = ROSTER.map((m) => {
    const key = normName(m.tv)
    const s = standingByKey.get(key)
    const liveInk = inksFromImage(s?.profile_image_url)
    const matches = matchesByKey.get(key) ?? []
    const rounds: Record<number, RoundResult> = {}
    for (const mm of matches) rounds[mm.round] = mm.result
    return {
      ...m,
      found: !!s,
      rank: s?.rank ?? null,
      wins: s?.matches_won ?? 0,
      losses: s?.matches_lost ?? 0,
      draws: s?.matches_drawn ?? 0,
      points: s?.total_match_points ?? 0,
      matchWinPct: s ? s.match_win_percentage ?? null : null,
      oppMatchWinPct: s ? s.opponent_match_win_percentage ?? null : null,
      gameWinPct: s ? s.game_win_percentage ?? null : null,
      liveInk,
      rounds,
      matches,
    }
  })

  // sort by official rank; unfound players sink to the bottom
  crew.sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity))

  return {
    event,
    crew,
    updatedAt: new Date().toISOString(),
    stale: false,
  }
}

// --- tiny in-memory cache so rapid polling doesn't hammer the upstream API ---
let cache: { key: string; at: number; data: LedgerPayload } | null = null
const TTL_MS = 30_000

export async function getLedger(eventId: string, force = false): Promise<LedgerPayload> {
  const now = Date.now()
  if (!force && cache && cache.key === eventId && now - cache.at < TTL_MS) {
    return { ...cache.data, stale: false }
  }
  try {
    const data = await buildLedger(eventId)
    cache = { key: eventId, at: now, data }
    return data
  } catch (err) {
    if (cache && cache.key === eventId) {
      // serve the last good snapshot if the upstream hiccups
      return { ...cache.data, stale: true }
    }
    throw err
  }
}
