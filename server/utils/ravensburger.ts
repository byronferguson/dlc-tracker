/**
 * Server-side client for the Ravensburger Play (Cardeio) public "TV" API.
 *
 * The browser cannot call this API directly: it only returns CORS headers to
 * tcg.ravensburgerplay.com and requires a custom `app-name` header. So all
 * upstream calls happen here, in Nitro, and the page talks to our /api/standings.
 *
 * The app is generic: the event id and the list of tracked players arrive with
 * each request. Heavy upstream data is cached per event id; matching the tracked
 * players against it is cheap and done per request.
 */
import { DEFAULT_PLAYERS, type TrackedPlayer } from '#shared/defaults'

export type { TrackedPlayer }

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

export interface CrewStanding {
  name: string // friendly label the user gave
  username: string // what they typed to match on
  matchedName: string | null // the official display name we matched
  found: boolean
  rank: number | null
  wins: number
  losses: number
  draws: number
  points: number
  matchWinPct: number | null
  oppMatchWinPct: number | null
  gameWinPct: number | null
  liveInk: string[]
  dropped: boolean // registration_status === DROPPED
  rounds: Record<number, RoundResult>
  matches: RoundMatch[]
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
  venue: string | null
  startISO: string | null
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

const INK_NAMES = ['Amber', 'Amethyst', 'Emerald', 'Ruby', 'Sapphire', 'Steel']

export function normName(s: string): string {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** Parse Ravensburger's loose timestamps to epoch ms (they vary in precision/offset). */
export function parseRbDate(s: string | null | undefined): number | null {
  if (!s) return null
  let v = String(s).trim()
  v = v.replace(/T(\d{2}:\d{2})(?=[+\-Z]|$)/, 'T$1:00')
  v = v.replace(/([+\-]\d{2})(\d{2})$/, '$1:$2')
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : t
}

/** Split a profile image filename like "AmberSteel.webp" into ["amber","steel"]. */
function inksFromImage(url: string | null | undefined): string[] {
  if (!url) return []
  const m = /\/profile\/([A-Za-z]+)\.webp/.exec(url)
  if (!m) return []
  const out: string[] = []
  let rest = m[1]
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

// ---------- page scrape (precise timer + venue + start), cached ----------
interface PageExtras {
  running: boolean
  endsAt: number | null
  pausedAt: number | null
  durationMin: number | null
  venue: string | null
  startISO: string | null
}

let extrasCache: { key: string; at: number; data: PageExtras } | null = null
const EXTRAS_TTL_MS = 90_000

async function fetchExtras(rb: RbFetch, eventId: string): Promise<PageExtras> {
  const nowMs = Date.now()
  if (extrasCache && extrasCache.key === eventId && nowMs - extrasCache.at < EXTRAS_TTL_MS) {
    return extrasCache.data
  }
  const data = await fetchExtrasUncached(rb, eventId)
  extrasCache = { key: eventId, at: nowMs, data }
  return data
}

async function fetchExtrasUncached(rb: RbFetch, eventId: string): Promise<PageExtras> {
  // The rendered page carries the full-precision timer plus venue/date — the same
  // source the official UI uses. The magic-events REST field truncates the timer.
  try {
    const html = await $fetch<string>(`https://tcg.ravensburgerplay.com/events/${eventId}`, {
      headers: { 'user-agent': 'Mozilla/5.0 (dlc-tracker)' },
      responseType: 'text',
      timeout: 20000,
      retry: 1,
    })
    const end = /timer_end_datetime\\?":\\?"([0-9T:+\-]+)/.exec(html)
    const paused = /timer_paused_at_datetime\\?":\\?"([0-9T:+\-]+)/.exec(html)
    const dur = /round_duration_in_minutes\\?":(\d+)/.exec(html)
    const venue = /store\\?":\{[^}]*?\\?"name\\?":\\?"([^"\\]+)/.exec(html)
    const start = /start_datetime\\?":\\?"([0-9T:+\-]+)/.exec(html)
    if (end || venue || start) {
      return {
        running: /timer_is_running\\?":true/.test(html),
        endsAt: end ? parseRbDate(end[1]) : null,
        pausedAt: paused ? parseRbDate(paused[1]) : null,
        durationMin: dur ? Number(dur[1]) : null,
        venue: venue ? venue[1] : null,
        startISO: start ? start[1] : null,
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
      venue: d?.store?.name ?? null,
      startISO: d?.aware_start_datetime ?? d?.start_datetime ?? null,
    }
  } catch {
    return { running: false, endsAt: null, pausedAt: null, durationMin: null, venue: null, startISO: null }
  }
}

async function fetchEventState(rb: RbFetch, eventId: string): Promise<EventState> {
  const [tv, extras] = await Promise.all([
    rb<any>(`/api/v2/player/events/${eventId}/tv/`),
    fetchExtras(rb, eventId),
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
    phaseLabel: activePhase?.round_type
      ? `${String(activePhase.round_type).replace(/_/g, ' ')} · ${activePhase.number_of_rounds} rounds`
      : '',
    startingPlayers: tv?.starting_player_count ?? 0,
    registeredPlayers: tv?.registered_user_count ?? 0,
    totalRounds: activePhase?.number_of_rounds ?? rounds.length,
    activeRound: active?.number ?? null,
    rounds,
    venue: extras.venue,
    startISO: extras.startISO,
    timerRunning: extras.running,
    timerEndsAt: extras.endsAt,
    timerPausedAt: extras.pausedAt,
    roundDurationMin: extras.durationMin,
  }
}

// ---------- matches (slim, completed rounds cached permanently) ----------
interface SlimMatch {
  table: number | null
  status: string
  bye: boolean
  players: { n: string; w: boolean; g: number }[]
}

const roundCache = new Map<string, SlimMatch[]>()

async function getRoundSlim(rb: RbFetch, eventId: string, round: RoundInfo): Promise<SlimMatch[]> {
  const cacheKey = `${eventId}:${round.id}`
  if (round.status === 'COMPLETE' && roundCache.has(cacheKey)) return roundCache.get(cacheKey)!
  let raw: any[] = []
  try {
    raw = await fetchAllPages<any>(rb, `/api/v2/player/events/${eventId}/tv/matches/?round_id=${round.id}`)
  } catch {
    return []
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

/** Index every player's per-round result/opponent so any tracked roster can look itself up. */
async function buildMatchIndex(rb: RbFetch, eventId: string, rounds: RoundInfo[]): Promise<Map<string, RoundMatch[]>> {
  const index = new Map<string, RoundMatch[]>()
  const live = rounds.filter((r) => r.status === 'COMPLETE' || r.status === 'IN_PROGRESS')

  await Promise.all(
    live.map(async (round) => {
      const matches = await getRoundSlim(rb, eventId, round)
      for (const m of matches) {
        const complete = m.status === 'COMPLETE'
        const someWinner = m.players.some((p) => p.w)
        for (const p of m.players) {
          const key = normName(p.n)
          if (!key) continue
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
          const list = index.get(key) ?? []
          list.push(entry)
          index.set(key, list)
        }
      }
    }),
  )
  for (const list of index.values()) list.sort((a, b) => a.round - b.round)
  return index
}

// ---------- per-event raw data, cached ----------
interface SlimStanding {
  rank: number
  wins: number
  losses: number
  draws: number
  points: number
  mwp: number | null
  omwp: number | null
  gwp: number | null
  ink: string[]
  dropped: boolean
}

interface EventRaw {
  event: EventState
  standings: Map<string, SlimStanding>
  keyToName: Map<string, string>
  keys: string[]
  keySet: Set<string>
  matchIndex: Map<string, RoundMatch[]>
}

async function buildEventRaw(eventId: string): Promise<EventRaw> {
  const rb = makeClient()
  const [event, rawStandings] = await Promise.all([
    fetchEventState(rb, eventId),
    fetchAllPages<any>(rb, `/api/v2/player/events/${eventId}/tv/standings/`),
  ])

  const standings = new Map<string, SlimStanding>()
  const keyToName = new Map<string, string>()
  for (const s of rawStandings) {
    const key = normName(s?.tv_display_name)
    if (!key) continue
    keyToName.set(key, s?.tv_display_name ?? key)
    standings.set(key, {
      rank: s?.rank ?? 0,
      wins: s?.matches_won ?? 0,
      losses: s?.matches_lost ?? 0,
      draws: s?.matches_drawn ?? 0,
      points: s?.total_match_points ?? 0,
      mwp: s?.match_win_percentage ?? null,
      omwp: s?.opponent_match_win_percentage ?? null,
      gwp: s?.game_win_percentage ?? null,
      ink: inksFromImage(s?.profile_image_url),
      dropped: s?.registration_status === 'DROPPED',
    })
  }

  const matchIndex = await buildMatchIndex(rb, eventId, event.rounds)
  const keys = Array.from(standings.keys())
  return { event, standings, keyToName, keys, keySet: new Set(keys), matchIndex }
}

let rawCache: { key: string; at: number; data: EventRaw } | null = null
const RAW_TTL_MS = 30_000

async function getEventRaw(eventId: string, force: boolean): Promise<{ raw: EventRaw; stale: boolean }> {
  const now = Date.now()
  if (!force && rawCache && rawCache.key === eventId && now - rawCache.at < RAW_TTL_MS) {
    return { raw: rawCache.data, stale: false }
  }
  try {
    const data = await buildEventRaw(eventId)
    rawCache = { key: eventId, at: now, data }
    return { raw: data, stale: false }
  } catch (err) {
    if (rawCache && rawCache.key === eventId) return { raw: rawCache.data, stale: true }
    throw err
  }
}

/** Match a tracked player to an official display-name key: exact, then prefix, then substring. */
function matchKey(keys: string[], keySet: Set<string>, username: string, name: string): string | null {
  const cands = [username, name].map(normName).filter(Boolean)
  for (const c of cands) if (keySet.has(c)) return c
  for (const mode of ['prefix', 'substr'] as const) {
    let best: string | null = null
    for (const c of cands) {
      if (c.length < 3) continue
      for (const k of keys) {
        const hit = mode === 'prefix' ? k.startsWith(c) : k.includes(c)
        if (hit && (!best || k.length < best.length)) best = k
      }
    }
    if (best) return best
  }
  return null
}

export async function getLedger(
  eventId: string,
  players: TrackedPlayer[],
  force = false,
): Promise<LedgerPayload> {
  const { raw, stale } = await getEventRaw(eventId, force)
  const roster = players.length ? players : DEFAULT_PLAYERS

  const crew: CrewStanding[] = roster.map((p) => {
    const key = matchKey(raw.keys, raw.keySet, p.username, p.name)
    const s = key ? raw.standings.get(key) : undefined
    const matches = key ? raw.matchIndex.get(key) ?? [] : []
    const rounds: Record<number, RoundResult> = {}
    for (const mm of matches) rounds[mm.round] = mm.result
    return {
      name: p.name || p.username,
      username: p.username,
      matchedName: key ? raw.keyToName.get(key) ?? null : null,
      found: !!s,
      rank: s?.rank ?? null,
      wins: s?.wins ?? 0,
      losses: s?.losses ?? 0,
      draws: s?.draws ?? 0,
      points: s?.points ?? 0,
      matchWinPct: s?.mwp ?? null,
      oppMatchWinPct: s?.omwp ?? null,
      gameWinPct: s?.gwp ?? null,
      liveInk: s?.ink ?? [],
      dropped: s?.dropped ?? false,
      rounds,
      matches,
    }
  })

  crew.sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity))

  return {
    event: raw.event,
    crew,
    updatedAt: new Date().toISOString(),
    stale,
  }
}
