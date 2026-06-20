// Shared between the Nitro server and the Vue client (Nuxt 4 `shared/` dir).
// These are only DEFAULTS — at runtime the tracked event and players come from
// the client's localStorage and are sent to the server with each request.

export interface TrackedPlayer {
  name: string // friendly label shown in the table
  username: string // PlayHub username/handle to match against the official standings
}

export const DEFAULT_EVENT_ID = '508677'

// The original crew (Disney Lorcana Challenge: Indianapolis).
export const DEFAULT_PLAYERS: TrackedPlayer[] = [
  { name: 'Nick', username: 'Chef_Nick' },
  { name: 'Niki', username: 'disnerd_94' },
  { name: 'Jason', username: 'Izik' },
  { name: 'Sarah', username: 'Ladyreadsalot' },
  { name: 'James', username: 'sleepy_sheeb' },
  { name: 'Alec', username: 'beelzebuth' },
  { name: 'Jeremy', username: 'JerpsDerps' },
  { name: 'Matt', username: 'MOrrBridges' },
  { name: 'Amy', username: 'AmyPond17' },
  { name: 'Charles', username: 'siimba' },
  { name: 'Mike', username: 'BoLing4U' },
  { name: 'Fuchan', username: 'Richard Richey' },
  { name: 'Max', username: 'littlei999' },
  { name: 'Charlie', username: 'Charlie Wendt' },
  { name: 'Justin', username: 'Malferon' },
]
