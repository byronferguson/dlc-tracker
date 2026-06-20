// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-06-01',
  future: { compatibilityVersion: 4 },
  devtools: { enabled: false },
  css: ['~/assets/css/main.css'],

  // Deploy target: Cloudflare Pages (Nitro spins up a Worker for /api/*).
  // Local `nuxt dev` ignores the preset and runs on Node as usual.
  nitro: {
    preset: 'cloudflare-pages',
  },

  runtimeConfig: {
    // server-only — used by the Nitro proxy that talks to Ravensburger Play
    rbApiBase: 'https://api.cloudflare.ravensburgerplay.com/hydraproxy',
    rbAppName: 'phoenix',
    public: {
      // the event this tracker follows; override with NUXT_PUBLIC_EVENT_ID
      eventId: '508677',
      // base poll cadence (seconds) while a round's results are still coming in;
      // the client backs off automatically once all tracked results are in
      pollSeconds: 60,
    },
  },

  app: {
    head: {
      htmlAttrs: { lang: 'en' },
      title: 'The Crew Ledger · Lorcana Challenge Indianapolis',
      meta: [
        { charset: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        { name: 'description', content: 'Live standings for our crew at the Disney Lorcana Challenge: Indianapolis.' },
        { name: 'color-scheme', content: 'dark' },
      ],
    },
  },
})
