// Shared between the Nitro server and the Vue client (Nuxt 4 `shared/` dir).
// These are only DEFAULTS — at runtime the tracked event and players come from
// the client's localStorage and are sent to the server with each request.

export interface TrackedPlayer {
  name: string // friendly label shown in the table
  username: string // PlayHub username/handle to match against the official standings
}

export const DEFAULT_EVENT_ID = '466655'

export const DEFAULT_PLAYERS: TrackedPlayer[] = [
  { name: 'Shaheed', username: 'Goodbuddy70461' },
  { name: 'Nick W', username: 'Wheels' },
  { name: 'Josh', username: 'PilgrimsProcess' },
  { name: 'Aaron W', username: 'AaronCWil' },
  { name: 'Maddy', username: 'MaddyI' },
  { name: 'Geoffrey', username: 'Firekraken91' },
  { name: 'Sara', username: 'SideQuestSara' },
  { name: 'Parker', username: 'OneWhoParks' },
]
