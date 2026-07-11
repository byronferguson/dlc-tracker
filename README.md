# The Crew Ledger — Lorcana event tracker

A one-page live standings tracker for our crew at a [Ravensburger Play](https://tcg.ravensburgerplay.com)
Disney Lorcana event. It pulls the official standings, matches our 8 players by their
registered display names, and shows each one's rank, record, points, tiebreakers, and
per-round results — auto-refreshing during the event. No manual entry.

Currently tracking **[Disney Lorcana CCQ Tournament](https://tcg.ravensburgerplay.com/events/466655)**.

## How it works

The Ravensburger Play API (Cardeio platform) is public but can't be called from a browser:
it only returns CORS headers to its own domain and requires a custom `app-name: phoenix`
header that generic CORS proxies won't forward. So a Nitro server route does the talking:

```
browser ──▶ /api/standings ──▶ tv/  +  tv/standings/  +  tv/matches/   (Ravensburger)
            (our Nitro proxy)        event state         standings        per-round results
```

- `server/utils/ravensburger.ts` — fetch + match logic and the crew roster.
- `server/api/standings.get.ts` — the endpoint the page polls (20s in-memory cache).
- `app/pages/index.vue` — the ledger UI (summary first, rounds after, active round highlighted).

Results are cached server-side for 20s so polling can't hammer the upstream API.

## Develop

```bash
pnpm install
pnpm dev          # http://localhost:3000
```

## Deploy to Cloudflare Pages

The project is preset for Cloudflare (`nitro.preset = 'cloudflare-pages'`).

```bash
pnpm build
npx wrangler pages deploy dist     # or: npx wrangler pages dev dist  (local preview)
```

Or connect the repo in the Cloudflare dashboard with:
- **Build command:** `pnpm build`
- **Output directory:** `dist`

Cloudflare auto-detects Nuxt; `wrangler.toml` pins `nodejs_compat` and the output dir.

## Point it at a different event

Change `runtimeConfig.public.eventId` in `nuxt.config.ts`, or set
`NUXT_PUBLIC_EVENT_ID` (e.g. as a Cloudflare variable). The crew roster in
`server/utils/ravensburger.ts` (`ROSTER`) is event-specific — each member's `tv`
field is the exact display name as it appears in that event's standings.
