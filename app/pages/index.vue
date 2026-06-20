<script setup lang="ts">
import type { LedgerPayload, CrewStanding, RoundResult } from '~~/server/utils/ravensburger'
import { DEFAULT_EVENT_ID, DEFAULT_PLAYERS, type TrackedPlayer } from '#shared/defaults'

const runtime = useRuntimeConfig()
const pollSeconds = Number(runtime.public.pollSeconds) || 60

interface TrackerConfig {
  eventId: string
  players: TrackedPlayer[]
}
const STORAGE_KEY = 'dlc-tracker-config'

// The tracked event + players live in the browser (localStorage) and ride along
// with each request — no database. Defaults are the original crew.
const config = useState<TrackerConfig>('cfg', () => ({
  eventId: DEFAULT_EVENT_ID,
  players: DEFAULT_PLAYERS.map((p) => ({ ...p })),
}))
const eventUrl = computed(() => `https://tcg.ravensburgerplay.com/events/${config.value.eventId}`)

const { data, pending, error, refresh } = await useFetch<LedgerPayload>('/api/standings', {
  method: 'POST',
  body: config,
  watch: [config],
  key: 'ledger',
})

const refreshing = ref(false)
const autoRefresh = ref(true)

async function reload(force = false) {
  refreshing.value = true
  try {
    if (force) {
      // bypass the server's short cache for an immediate, current snapshot
      data.value = await $fetch<LedgerPayload>('/api/standings', {
        method: 'POST',
        body: { ...config.value, force: true },
      })
    } else {
      await refresh()
    }
  } catch {
    flash('Couldn’t refresh — showing last update')
  } finally {
    refreshing.value = false
  }
}

// ---- config management (event id + tracked players) ----
const showConfig = ref(false)
const eventDraft = ref('')
const addName = ref('')
const addUser = ref('')
const csvText = ref('')

function openConfig() {
  eventDraft.value = config.value.eventId
  showConfig.value = !showConfig.value
}
function parseEventId(input: string): string {
  const m = input.match(/events\/(\d+)/) || input.match(/(\d{3,})/)
  return m ? m[1] : ''
}
function applyEvent() {
  const id = parseEventId(eventDraft.value.trim())
  if (!id) return flash('Enter a valid event ID or URL')
  if (id === config.value.eventId) return flash('Already tracking that event')
  config.value = { ...config.value, eventId: id }
  flash(`Tracking event ${id}`)
}
const normUser = (u: string) => u.toLowerCase().replace(/[^a-z0-9]/g, '')
function mergePlayers(existing: TrackedPlayer[], incoming: TrackedPlayer[]): TrackedPlayer[] {
  const seen = new Set(existing.map((p) => normUser(p.username)))
  const out = [...existing]
  for (const p of incoming) {
    const k = normUser(p.username)
    if (!k || seen.has(k)) continue
    seen.add(k)
    out.push(p)
  }
  return out
}
function addPlayer() {
  const username = addUser.value.trim()
  if (!username) return flash('Username is required')
  const name = addName.value.trim() || username
  config.value = { ...config.value, players: mergePlayers(config.value.players, [{ name, username }]) }
  addName.value = ''
  addUser.value = ''
}
function removePlayer(username: string) {
  config.value = { ...config.value, players: config.value.players.filter((p) => p.username !== username) }
}
function addFromCsv() {
  const rows: TrackedPlayer[] = []
  for (const line of csvText.value.split(/\r?\n/)) {
    const t = line.trim()
    if (!t) continue
    const parts = t.split(',').map((s) => s.trim())
    if (/^names?$/i.test(parts[0]) && /^user/i.test(parts[1] || '')) continue // header
    const username = parts[1] || parts[0]
    if (!username) continue
    rows.push({ name: parts[0] || username, username })
  }
  if (!rows.length) return flash('No rows found — use “Name, Username” per line')
  const before = config.value.players.length
  config.value = { ...config.value, players: mergePlayers(config.value.players, rows) }
  csvText.value = ''
  flash(`Added ${config.value.players.length - before} player(s)`)
}
function resetDefaults() {
  config.value = { eventId: DEFAULT_EVENT_ID, players: DEFAULT_PLAYERS.map((p) => ({ ...p })) }
  eventDraft.value = DEFAULT_EVENT_ID
  flash('Reset to defaults')
}
function clearPlayers() {
  config.value = { ...config.value, players: [] }
}

// --- live clock for "updated N s ago" ---
const now = ref(Date.now())
let clock: ReturnType<typeof setInterval> | undefined
let poller: ReturnType<typeof setTimeout> | undefined

// How long to wait before the next poll, ramped to the round clock: results
// trickle in slowly early and flood in near time / in overtime, so poll lazily
// when there's lots of time left and tighten as it runs down — then idle once
// every tracked player's result is in. Thresholds scale off the round length
// (fractions of the round remaining), so any format tunes itself.
function pollDelayMs(): number {
  if (error.value) return 60_000
  if (!activeRound.value) return 180_000 // between rounds / event not in progress
  if (allResultsIn.value) return 300_000 // every tracked player is done this round
  const ms = timerMs.value
  if (ms == null) return pollSeconds * 1000 // no timer info → base cadence
  const durMs = (event.value?.roundDurationMin || 50) * 60_000
  const frac = ms / durMs // fraction of the round still on the clock (<0 = overtime)
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
  if (frac > 0.3) return clamp(durMs * 0.06, 90_000, 300_000) // plenty of time left
  if (frac > 0.1) return clamp(durMs * 0.04, 75_000, 180_000)
  if (frac > 0.04) return 75_000 // closing in
  if (frac > 0) return 45_000 // final stretch
  return 30_000 // overtime — results landing fast
}
function scheduleNext() {
  clearTimeout(poller)
  poller = setTimeout(async () => {
    if (autoRefresh.value && document.visibilityState === 'visible') await reload(false)
    if (autoRefresh.value) scheduleNext()
  }, pollDelayMs())
}
function onVisible() {
  // snap to current data when the tab returns, then re-evaluate the cadence
  if (autoRefresh.value && document.visibilityState === 'visible') {
    reload(false)
    scheduleNext()
  }
}

onMounted(() => {
  // hydrate config from localStorage (replacing the SSR defaults if present)
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) {
      const c = JSON.parse(saved)
      if (c && typeof c.eventId === 'string' && Array.isArray(c.players)) {
        config.value = {
          eventId: c.eventId.replace(/\D/g, '') || DEFAULT_EVENT_ID,
          players: c.players
            .filter((p: any) => p && typeof p.username === 'string' && p.username.trim())
            .map((p: any) => ({ name: String(p.name ?? p.username), username: String(p.username) })),
        }
      }
    }
  } catch {
    /* ignore bad storage */
  }
  clock = setInterval(() => (now.value = Date.now()), 1000)
  scheduleNext()
  document.addEventListener('visibilitychange', onVisible)
})
watch(
  config,
  (c) => {
    if (import.meta.client) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(c))
      } catch {
        /* storage may be full/blocked */
      }
    }
  },
  { deep: true },
)
onBeforeUnmount(() => {
  clearInterval(clock)
  clearTimeout(poller)
  document.removeEventListener('visibilitychange', onVisible)
})
watch(autoRefresh, (on) => {
  if (on) {
    reload(false)
    scheduleNext()
  } else {
    clearTimeout(poller)
  }
})

const event = computed(() => data.value?.event ?? null)
const crew = computed<CrewStanding[]>(() => data.value?.crew ?? [])
const rounds = computed(() => event.value?.rounds ?? [])
const activeRound = computed(() => event.value?.activeRound ?? null)

// --- round timer (ticks via the `now` clock below) ---
const timerMs = computed<number | null>(() => {
  const e = event.value
  if (!e || e.timerEndsAt == null) return null
  // when paused, the remaining time is frozen at the pause moment
  if (e.timerPausedAt != null) return e.timerEndsAt - e.timerPausedAt
  return e.timerEndsAt - now.value
})
const timerState = computed<'running' | 'overtime' | 'paused' | 'off'>(() => {
  const e = event.value
  if (!e || e.timerEndsAt == null || (!e.timerRunning && e.timerPausedAt == null)) return 'off'
  if (e.timerPausedAt != null) return 'paused'
  // past zero the official clock keeps counting up into the negative ("overtime")
  return (timerMs.value ?? 0) < 0 ? 'overtime' : 'running'
})
const timerText = computed(() => {
  const ms = timerMs.value
  if (ms == null) return ''
  // counting down: round up so "0:01" shows through the final second (matches a
  // conventional clock and the official site). counting up in overtime: floor the
  // elapsed time so it reads "-21:08" while 21:08 has elapsed.
  const neg = ms < 0
  const s = neg ? Math.floor(-ms / 1000) : Math.ceil(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  const body = h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`
  return neg ? `-${body}` : body
})
// red + pulsing once the round is in its final 2 minutes or has gone overtime
const timerLow = computed(() => {
  const st = timerState.value
  return (st === 'running' && (timerMs.value ?? Infinity) <= 120_000) || st === 'overtime'
})

const agoText = computed(() => {
  if (!data.value?.updatedAt) return ''
  const secs = Math.max(0, Math.round((now.value - new Date(data.value.updatedAt).getTime()) / 1000))
  if (secs < 5) return 'just now'
  if (secs < 60) return `${secs}s ago`
  const m = Math.floor(secs / 60)
  return `${m}m ${secs % 60}s ago`
})

// --- dashboard ---
const found = computed(() => crew.value.filter((c) => c.found))
// the latest round any crew member has a result for
const lastRound = computed(() => {
  let max = 0
  for (const c of found.value) for (const k of Object.keys(c.rounds)) max = Math.max(max, Number(k))
  return max || null
})
// how many won that round (a bye counts as a win)
const wonLast = computed(() => {
  const r = lastRound.value
  if (!r) return 0
  return found.value.filter((c) => c.rounds[r] === 'W' || c.rounds[r] === 'B').length
})
const undefeated = computed(
  () => found.value.filter((c) => !c.dropped && c.losses === 0 && c.wins + c.draws > 0).length,
)

// every still-active (non-dropped) tracked player has a decided result this round
const allResultsIn = computed(() => {
  const r = activeRound.value
  const active = found.value.filter((c) => !c.dropped)
  if (!r || !active.length) return false
  return active.every((c) => {
    const v = c.rounds[r]
    return !!v && v !== 'P'
  })
})
const pollLabel = computed(() => {
  if (!autoRefresh.value) return 'Auto'
  if (activeRound.value && allResultsIn.value) return 'Auto · idle'
  if (!activeRound.value) return 'Auto · slow'
  return `Auto · ${Math.round(pollDelayMs() / 1000)}s`
})
const pollTitle = computed(() => {
  if (!autoRefresh.value) return 'Auto-refresh is off'
  if (activeRound.value && allResultsIn.value)
    return `All tracked results are in for round ${activeRound.value} — checking every 5 min for the next round`
  if (!activeRound.value) return 'No active round — checking occasionally'
  return `Refreshing every ${Math.round(pollDelayMs() / 1000)}s — more often as the round clock winds down`
})
const leader = computed(() => found.value.find((c) => c.rank != null) ?? null)
const crewBest = computed(() => (leader.value?.rank ? `#${leader.value.rank.toLocaleString()}` : '—'))

// --- helpers ---
function hasInk(c: CrewStanding): boolean {
  return !!(c.liveInk && c.liveInk.length)
}
function sigilStyle(c: CrewStanding) {
  if (!hasInk(c)) return { background: 'rgba(154,163,200,0.3)' } // ink unknown (default avatar)
  const list = c.liveInk
  if (list.length >= 2) {
    return { background: `linear-gradient(135deg, var(--${list[0]}) 0 50%, var(--${list[1]}) 50% 100%)` }
  }
  return { background: `var(--${list[0]})` }
}
function inkTitle(c: CrewStanding): string {
  if (!hasInk(c)) return 'Deck ink unknown'
  const caps = c.liveInk.map((i) => i[0].toUpperCase() + i.slice(1))
  return caps.join(' / ') + (caps.length > 1 ? ' inks' : ' ink')
}
function pct(v: number | null): string {
  return v == null ? '—' : `${Math.round(v * 100)}%`
}
const roundLabel: Record<RoundResult, string> = { W: 'W', L: 'L', D: 'D', B: 'BYE', P: '·' }

// --- accordion: expanded rows (by tv display name) ---
const expanded = ref<Set<string>>(new Set())
function toggleRow(key: string) {
  const next = new Set(expanded.value)
  next.has(key) ? next.delete(key) : next.add(key)
  expanded.value = next
}

// --- copy + toast ---
const toast = ref('')
let toastT: ReturnType<typeof setTimeout> | undefined
function flash(msg: string) {
  toast.value = msg
  clearTimeout(toastT)
  toastT = setTimeout(() => (toast.value = ''), 1700)
}
async function copy(text: string, label: string) {
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    /* clipboard may be blocked; ignore */
  }
  flash(`Copied ${label}`)
}

const startDate = computed(() => {
  const iso = event.value?.startISO
  if (!iso) return ''
  const t = Date.parse(iso.replace(/([+\-]\d{2})(\d{2})$/, '$1:$2'))
  if (Number.isNaN(t)) return ''
  return new Date(t).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
})
</script>

<template>
  <div class="wrap">
    <header>
      <p class="eyebrow">The Crew Ledger</p>
      <h1><span class="city">{{ event?.name || 'Lorcana Tracker' }}</span></h1>

      <div class="meta">
        <span v-if="event?.lifecycle === 'EVENT_IN_PROGRESS'" class="live-dot"><i></i> Live</span>
        <span class="dot" v-if="event?.lifecycle === 'EVENT_IN_PROGRESS' && (startDate || event?.venue)">·</span>
        <span v-if="startDate"><b>{{ startDate }}</b></span>
        <span class="dot" v-if="startDate && event?.venue">·</span>
        <span v-if="event?.venue">{{ event.venue }}</span>
        <span class="dot" v-if="event && (startDate || event.venue)">·</span>
        <span v-if="event"><b>{{ event.startingPlayers.toLocaleString() }}</b> players</span>
        <span class="dot" v-if="event">·</span>
        <span v-if="event">
          <template v-if="activeRound">Round <b>{{ activeRound }}</b> of {{ event.totalRounds }}</template>
          <template v-else>{{ event.phaseLabel || 'Swiss' }}</template>
        </span>
      </div>
    </header>

    <section class="dash" aria-label="Crew summary">
      <div class="stat">
        <div class="k">{{ found.length }}<span style="font-size:0.5em;color:var(--faint)"> / {{ crew.length }}</span></div>
        <div class="l">Illumineers found</div>
      </div>
      <div class="stat">
        <div class="k teal">{{ wonLast }}</div>
        <div class="l">{{ lastRound ? 'Won round ' + lastRound : 'Won last round' }}</div>
      </div>
      <div class="stat">
        <div class="k">{{ undefeated }}</div>
        <div class="l">Still undefeated</div>
      </div>
      <div class="stat">
        <div class="k">{{ crewBest }}</div>
        <div class="l">Crew leader{{ leader ? ' · ' + leader.name : '' }}</div>
      </div>
    </section>

    <div class="controls">
      <div class="controls-left">
        <h2>The Ledger</h2>
        <div
          v-if="event && timerState !== 'off'"
          class="round-timer"
          :class="{ low: timerLow, paused: timerState === 'paused' }"
          :title="`Round ${activeRound} timer`"
        >
          <span class="clock" aria-hidden="true">⏱</span>
          <span class="t">{{ timerText }}</span>
          <span class="lbl">
            <template v-if="timerState === 'paused'">paused · R{{ activeRound }}</template>
            <template v-else-if="timerState === 'overtime'">over · R{{ activeRound }}</template>
            <template v-else>left in R{{ activeRound }}</template>
          </span>
        </div>
      </div>
      <div class="ctl-group">
        <span class="updated" :class="{ stale: data?.stale }">
          <template v-if="data?.stale">cached · upstream unreachable</template>
          <template v-else>updated {{ agoText }}</template>
        </span>
        <label class="toggle" :title="pollTitle">
          <input type="checkbox" v-model="autoRefresh" />
          <span class="track"></span>
          <span>{{ pollLabel }}</span>
        </label>
        <button class="btn ghost" type="button" :disabled="refreshing" @click="reload(true)">
          <span v-if="refreshing" class="spin"></span>
          {{ refreshing ? 'Refreshing' : 'Refresh' }}
        </button>
        <button class="btn ghost" type="button" :class="{ on: showConfig }" @click="openConfig">⚙ Configure</button>
      </div>
    </div>

    <section v-if="showConfig" class="config">
      <div class="config-head">
        <h3>Configure tracker</h3>
        <button class="x" type="button" aria-label="Close" @click="showConfig = false">✕</button>
      </div>

      <div class="config-row">
        <label class="fld grow">
          <span class="fld-l">Event ID or URL</span>
          <input v-model="eventDraft" class="inp" placeholder="508677  or  https://…/events/508677" @keydown.enter="applyEvent" />
        </label>
        <button class="btn" type="button" @click="applyEvent">Track event</button>
      </div>
      <p class="hint">
        Tracking <b>{{ config.eventId }}</b><template v-if="event"> · {{ event.name }}</template>
      </p>

      <div class="cp-head">Players <span class="muted">({{ config.players.length }})</span></div>
      <ul class="cp-list">
        <li v-for="p in config.players" :key="p.username" class="cp-item">
          <span class="cp-name">{{ p.name }}</span>
          <span class="cp-user">{{ p.username }}</span>
          <button class="x" type="button" :aria-label="`Remove ${p.name}`" @click="removePlayer(p.username)">✕</button>
        </li>
        <li v-if="!config.players.length" class="cp-empty">No players yet — add below, paste a CSV, or reset to defaults.</li>
      </ul>

      <div class="config-row">
        <label class="fld grow">
          <span class="fld-l">Name</span>
          <input v-model="addName" class="inp" placeholder="Friendly name" @keydown.enter="addPlayer" />
        </label>
        <label class="fld grow">
          <span class="fld-l">PlayHub username</span>
          <input v-model="addUser" class="inp" placeholder="username" @keydown.enter="addPlayer" />
        </label>
        <button class="btn ghost" type="button" @click="addPlayer">Add</button>
      </div>

      <label class="fld block">
        <span class="fld-l">Bulk add — one per line: <code>Name, Username</code></span>
        <textarea v-model="csvText" class="inp ta" rows="4" placeholder="Sarah, Ladyreadsalot&#10;Jason, Izik&#10;Charlie Wendt"></textarea>
      </label>
      <div class="config-actions">
        <button class="btn" type="button" @click="addFromCsv">Add from CSV</button>
        <span class="grow"></span>
        <button class="link-btn" type="button" @click="clearPlayers">Clear all</button>
        <button class="link-btn" type="button" @click="resetDefaults">Reset to defaults</button>
      </div>
    </section>

    <div v-if="error" class="notice error">
      Couldn’t reach Ravensburger Play. The event API may be briefly down — try Refresh in a moment.
    </div>

    <div v-else-if="pending && !data" class="notice">
      <div class="skeleton" style="width:40%;margin-bottom:12px"></div>
      <div class="skeleton" style="width:75%;margin-bottom:12px"></div>
      <div class="skeleton" style="width:60%"></div>
    </div>

    <div v-else class="ledger-scroll">
      <table>
        <thead>
          <tr>
            <th class="c col-rank">#</th>
            <th class="col-who">Illumineer</th>
            <th class="c">Record</th>
            <th class="c">Pts</th>
            <th class="c">OMW</th>
            <th
              v-for="r in rounds"
              :key="r.id"
              class="c round"
              :class="{ active: r.number === activeRound }"
            >
              R{{ r.number }}
            </th>
          </tr>
        </thead>
        <tbody>
          <template v-for="c in crew" :key="c.username">
            <tr
              class="row"
              :class="{ missing: !c.found, dropped: c.dropped, open: expanded.has(c.username) }"
              :aria-expanded="expanded.has(c.username)"
              tabindex="0"
              @click="toggleRow(c.username)"
              @keydown.enter.prevent="toggleRow(c.username)"
              @keydown.space.prevent="toggleRow(c.username)"
            >
              <td class="c col-rank">
                <div class="rank" :class="{ top: c.rank != null && c.rank <= 100 }">
                  <template v-if="c.rank">
                    <span class="big">{{ c.rank.toLocaleString() }}</span>
                    <span class="of">of {{ (event?.startingPlayers || 1746).toLocaleString() }}</span>
                  </template>
                  <template v-else>—</template>
                </div>
              </td>

              <td class="col-who">
                <div class="who">
                  <span class="caret" :class="{ open: expanded.has(c.username) }" aria-hidden="true">▸</span>
                  <span class="sigil" :class="{ duo: (c.liveInk?.length || 0) >= 2 }" :style="sigilStyle(c)" :title="inkTitle(c)"></span>
                  <button class="copy" type="button" :title="`Copy ${c.username}`" @click.stop="copy(c.username, c.username)">
                    <span class="name">
                      {{ c.name }}<span v-if="c.dropped" class="drop-tag" title="Dropped from the event">dropped</span>
                      <span class="sub">{{ c.username }}</span>
                    </span>
                  </button>
                </div>
              </td>

              <td class="c">
                <span class="record">
                  <span class="w">{{ c.wins }}</span>–<span class="l">{{ c.losses }}</span><template v-if="c.draws">–<span class="d">{{ c.draws }}</span></template>
                </span>
              </td>

              <td class="pts">
                {{ c.points }}<span class="x"> pt{{ c.points === 1 ? '' : 's' }}</span>
              </td>

              <td class="tb">{{ pct(c.oppMatchWinPct) }}</td>

              <td
                v-for="r in rounds"
                :key="r.id"
                class="c cell"
                :class="{ active: r.number === activeRound }"
              >
                <span class="cell-mark" :data-v="c.rounds[r.number] || ''">
                  {{ c.rounds[r.number] ? roundLabel[c.rounds[r.number]] : '' }}
                </span>
              </td>
            </tr>

            <tr v-if="expanded.has(c.username)" class="detail-row">
              <td :colspan="5 + rounds.length">
                <div class="detail">
                  <div class="detail-title">
                    Match history · {{ c.name }}
                    <span v-if="c.found && c.matchedName" class="sub">{{ c.matchedName }}</span>
                    <span v-else class="sub not-found">not found in this event</span>
                  </div>
                  <div v-if="!c.matches.length" class="detail-empty">
                    {{ c.found ? 'No matches reported yet.' : 'No player matched this username in the standings.' }}
                  </div>
                  <ol v-else class="match-list">
                    <li v-for="mm in c.matches" :key="mm.round" class="match">
                      <span class="m-round">R{{ mm.round }}</span>
                      <span class="cell-mark m-res" :data-v="mm.result">{{ roundLabel[mm.result] }}</span>
                      <span class="m-vs">
                        <template v-if="mm.bye"><b>Bye</b></template>
                        <template v-else>vs <b>{{ mm.opponent || 'TBD' }}</b></template>
                        <em v-if="mm.result === 'P'"> · in progress</em>
                      </span>
                      <span v-if="!mm.bye" class="m-score">{{ mm.gamesFor }}–{{ mm.gamesAgainst }} <span class="g">games</span></span>
                      <span v-if="mm.table" class="m-table">Table {{ mm.table }}</span>
                    </li>
                  </ol>
                </div>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>

    <div class="foot">
      <div class="legend">
        <span><i style="background:var(--win)"></i> Win · 3</span>
        <span><i style="background:var(--loss)"></i> Loss</span>
        <span><i style="background:var(--draw)"></i> Draw · 1</span>
        <span><i style="background:var(--bye)"></i> Bye · 3</span>
        <span><i style="background:var(--pending);border:1px dashed var(--accent-2)"></i> Paired</span>
      </div>
      <span>·</span>
      <span>OMW = opponents’ match-win %. Hexagon = deck ink. Pulled live from
        <a :href="eventUrl" target="_blank" rel="noopener">ravensburgerplay.com ↗</a>
      </span>
    </div>

    <div id="toast" :class="{ show: !!toast }" role="status" aria-live="polite">{{ toast }}</div>
  </div>
</template>
