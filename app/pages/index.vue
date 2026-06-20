<script setup lang="ts">
import type { LedgerPayload, CrewStanding, RoundResult } from '~~/server/utils/ravensburger'

const config = useRuntimeConfig()
const pollSeconds = Number(config.public.pollSeconds) || 60
const eventUrl = `https://tcg.ravensburgerplay.com/events/${config.public.eventId}`

const { data, pending, error, refresh } = await useFetch<LedgerPayload>('/api/standings', {
  key: 'ledger',
})

const refreshing = ref(false)
const autoRefresh = ref(true)

async function reload(force = false) {
  refreshing.value = true
  try {
    await refresh({ ...(force ? ({ query: { force: 1 } } as any) : {}) })
  } finally {
    refreshing.value = false
  }
}

// --- live clock for "updated N s ago" ---
const now = ref(Date.now())
let clock: ReturnType<typeof setInterval> | undefined
let poller: ReturnType<typeof setInterval> | undefined

onMounted(() => {
  clock = setInterval(() => (now.value = Date.now()), 1000)
  poller = setInterval(() => {
    if (autoRefresh.value && document.visibilityState === 'visible') reload(true)
  }, pollSeconds * 1000)
})
onBeforeUnmount(() => {
  clearInterval(clock)
  clearInterval(poller)
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
const winning = computed(() => found.value.filter((c) => c.wins > c.losses).length)
const undefeated = computed(() => found.value.filter((c) => c.losses === 0 && c.wins + c.draws > 0).length)
const leader = computed(() => found.value.find((c) => c.rank != null) ?? null)
const crewBest = computed(() => (leader.value?.rank ? `#${leader.value.rank.toLocaleString()}` : '—'))

// --- helpers ---
function inks(c: CrewStanding): string[] {
  return c.liveInk && c.liveInk.length ? c.liveInk : [c.ink]
}
function sigilStyle(c: CrewStanding) {
  const list = inks(c)
  if (list.length >= 2) {
    return { background: `linear-gradient(135deg, var(--${list[0]}) 0 50%, var(--${list[1]}) 50% 100%)` }
  }
  return { background: `var(--${list[0]})`, boxShadow: `0 0 10px -2px var(--${list[0]})` }
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

const startDate = 'Sat Jun 20, 2026'
</script>

<template>
  <div class="wrap">
    <header>
      <p class="eyebrow">Disney Lorcana Challenge · Infinity Constructed</p>
      <h1>The Crew Ledger<span class="city">Indianapolis</span></h1>

      <div class="meta">
        <span v-if="event?.lifecycle === 'EVENT_IN_PROGRESS'" class="live-dot"><i></i> Live</span>
        <span class="dot" v-if="event?.lifecycle === 'EVENT_IN_PROGRESS'">·</span>
        <span><b>{{ startDate }}</b></span>
        <span class="dot">·</span>
        <span>Pastimes Events, Indianapolis IN</span>
        <span class="dot">·</span>
        <span><b>{{ (event?.startingPlayers || 1746).toLocaleString() }}</b> players</span>
        <span class="dot">·</span>
        <span>
          <template v-if="activeRound">Round <b>{{ activeRound }}</b> of {{ event?.totalRounds }}</template>
          <template v-else-if="event">{{ event.phaseLabel || 'Swiss' }}</template>
        </span>
      </div>
    </header>

    <section class="dash" aria-label="Crew summary">
      <div class="stat">
        <div class="k">{{ found.length }}<span style="font-size:0.5em;color:var(--faint)"> / {{ crew.length || 15 }}</span></div>
        <div class="l">Illumineers found</div>
      </div>
      <div class="stat">
        <div class="k teal">{{ winning }}</div>
        <div class="l">Winning records</div>
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
        <label class="toggle">
          <input type="checkbox" v-model="autoRefresh" />
          <span class="track"></span>
          <span>Auto · {{ pollSeconds }}s</span>
        </label>
        <button class="btn ghost" type="button" :disabled="refreshing" @click="reload(true)">
          <span v-if="refreshing" class="spin"></span>
          {{ refreshing ? 'Refreshing' : 'Refresh' }}
        </button>
      </div>
    </div>

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
          <template v-for="c in crew" :key="c.tv">
            <tr
              class="row"
              :class="{ missing: !c.found, open: expanded.has(c.tv) }"
              :aria-expanded="expanded.has(c.tv)"
              tabindex="0"
              @click="toggleRow(c.tv)"
              @keydown.enter.prevent="toggleRow(c.tv)"
              @keydown.space.prevent="toggleRow(c.tv)"
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
                  <span class="caret" :class="{ open: expanded.has(c.tv) }" aria-hidden="true">▸</span>
                  <span class="sigil" :class="{ duo: inks(c).length >= 2 }" :style="sigilStyle(c)"></span>
                  <button class="copy" type="button" :title="`Copy ${c.playhub}`" @click.stop="copy(c.playhub, c.playhub)">
                    <span class="name">
                      {{ c.name }}
                      <span class="sub">{{ c.playhub }}</span>
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

            <tr v-if="expanded.has(c.tv)" class="detail-row">
              <td :colspan="5 + rounds.length">
                <div class="detail">
                  <div class="detail-title">Match history · {{ c.name }} <span class="sub">{{ c.tv }}</span></div>
                  <div v-if="!c.matches.length" class="detail-empty">No matches reported yet.</div>
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
      <span>OMW = opponents’ match-win %. Sigil = deck inks. Pulled live from
        <a :href="eventUrl" target="_blank" rel="noopener">ravensburgerplay.com ↗</a>
      </span>
    </div>

    <div id="toast" :class="{ show: !!toast }" role="status" aria-live="polite">{{ toast }}</div>
  </div>
</template>
