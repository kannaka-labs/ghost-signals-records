'use strict';
// Every knob the studio reads, in one place, with the rule that a missing
// secret makes the feature inert (503 or skipped) rather than a crash.
const path = require('node:path');
const os = require('node:os');

const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);
const int = (k, d) => { const n = parseInt(env(k, ''), 10); return Number.isFinite(n) ? n : d; };

module.exports = {
  port: int('GSR_PORT', 8890),
  bind: env('GSR_BIND', '127.0.0.1'),
  publicUrl: env('GSR_PUBLIC_URL', 'https://records.ninja-portal.com').replace(/\/+$/, ''),
  dataDir: env('GSR_DATA_DIR', path.join(os.homedir(), '.gs-records')),
  adminToken: env('GSR_ADMIN_TOKEN', ''),

  // Prices in cents. The NPC quotes these; Stripe charges these.
  prices: {
    ep: int('GSR_PRICE_EP_CENTS', 1900),
    album: int('GSR_PRICE_ALBUM_CENTS', 3900),
    double: int('GSR_PRICE_DOUBLE_CENTS', 6900),
  },
  currency: env('GSR_CURRENCY', 'usd'),

  stripe: {
    secretKey: env('STRIPE_SECRET_KEY', ''),
    webhookSecret: env('STRIPE_WEBHOOK_SECRET', ''),
  },

  // The free door. `auto` (default) gives albums away while no card can be
  // taken, and closes itself the moment Stripe is configured. `on` keeps it
  // open alongside payments; `off` shuts it. The caps are what stop one
  // visitor, or one loud day, from spending the generator's whole balance.
  free: {
    mode: env('GSR_FREE_MODE', 'auto'),
    dailyLimit: int('GSR_FREE_DAILY_LIMIT', 3),
    visitorLimit: int('GSR_FREE_VISITOR_LIMIT', 1),
    maxTier: env('GSR_FREE_MAX_TIER', 'album'),
    minCredits: int('GSR_FREE_MIN_CREDITS', 100),
    creditsPerTrack: int('GSR_CREDITS_PER_TRACK', 10),
    windowHours: int('GSR_FREE_WINDOW_HOURS', 24),
  },

  suno: {
    key: env('SUNO_API_KEY', ''),
    model: env('SUNO_MODEL', 'V4_5PLUS'),
    base: env('SUNO_API_BASE', 'https://api.sunoapi.org'),
    callbackUrl: env('SUNO_CALLBACK_URL', ''),
  },

  // The hosted Kannaka Brain (OpenAI-compatible). Without a key the NPC uses
  // its templated lines and the lyricist uses its templated verses.
  brain: {
    base: env('BRAIN_BASE_URL', 'https://ninja-portal.com/v1'),
    key: env('BRAIN_API_KEY', ''),
    model: env('BRAIN_MODEL', 'kannaka-brain-7b-v1'),
    timeoutMs: int('BRAIN_TIMEOUT_MS', 120000),
  },

  // OpenBotCity, for cover art from the Pixel Atelier. Optional.
  obc: {
    jwt: env('OPENBOTCITY_JWT', ''),
    studioBuildingId: env('OBC_ART_STUDIO_ID', '4fae4e5c-0e04-4734-83ee-69e0592f6e7d'),
    gapMs: int('OBC_ART_GAP_MS', 95000),
  },

  // KAX City. Two credentials, deliberately different in reach:
  //   towerCredential (`twr_…`, minted by the operator, pinned to one floor)
  //     writes the wall and registers the webhook. That is all it can do.
  //   agentToken is the studio's bot in the city, and is the ONLY thing that
  //     can speak in the room. Without it the desk still answers on the web
  //     and still hears the floor; it just says nothing aloud there.
  kax: {
    base: env('KAX_API_BASE', 'https://kax.ninja-portal.com/api'),
    agentToken: env('KAX_AGENT_TOKEN', ''),
    towerCredential: env('KAX_TOWER_CREDENTIAL', ''),
    storey: int('KAX_TOWER_STOREY', 0),
    webhookSecret: env('TOWER_WEBHOOK_SECRET', ''),
  },

  // Mail: the studio writes from Kannaka's own address.
  mail: {
    host: env('KANNAKA_MAIL_HOST', 'smtp.zoho.com'),
    port: int('KANNAKA_MAIL_PORT', 465),
    user: env('KANNAKA_MAIL_USER', ''),
    pass: env('KANNAKA_MAIL_PASS', ''),
    from: env('GSR_MAIL_FROM', 'Ghost Signals Records <kannaka@spacechild.love>'),
    operator: env('GSR_OPERATOR_EMAIL', ''),
  },

  // The record store: finished albums as downloads, paid in USDC on Base.
  // Receive-only: the address takes money, the server holds no key. Without
  // an address or a download secret the catalog shows and nothing sells.
  store: {
    payTo: env('GSR_USDC_PAY_TO', ''),
    rpcUrls: env('GSR_BASE_RPC_URLS', 'https://base-rpc.publicnode.com,https://mainnet.base.org').split(',').map((s) => s.trim()).filter(Boolean),
    priceMicro: int('GSR_STORE_PRICE_MICRO', 5000000), // 5 USDC
    confirmations: int('GSR_USDC_CONFIRMATIONS', 3),
    downloadSecret: env('GSR_DOWNLOAD_SECRET', ''),
    tokenHours: int('GSR_DOWNLOAD_TOKEN_HOURS', 72),
    scanMs: int('GSR_USDC_SCAN_MS', 15000),
    previewSec: int('GSR_PREVIEW_SEC', 45),
    // Gasless checkout: a relayer key that holds gas ETH on Base and nothing
    // else. Unset = buyers pay their own gas. The float floor is in wei
    // (0.00002 ETH, about fifty transfers); below it the store stops relaying
    // and the page falls back to a plain transfer.
    relayerKey: env('GSR_RELAYER_KEY', ''),
    relayMinWei: env('GSR_RELAY_MIN_WEI', '20000000000000'),
    relayPerHour: int('GSR_RELAY_PER_HOUR', 60),
    authMinutes: int('GSR_AUTH_MINUTES', 30),
  },

  npcName: env('GSR_NPC_NAME', 'Vesper'),
  // Vesper's voice in the store: `edge` (edge-tts, free, needs the network),
  // `piper` (local), or `off`. The text still answers when the voice is off.
  vesper: {
    engine: env('GSR_VESPER_VOICE', 'off'),
    voice: env('GSR_VESPER_VOICE_NAME', 'en-GB-SoniaNeural'),
    rate: env('GSR_VESPER_VOICE_RATE', '-4%'),
    piperBin: env('PIPER_BIN', ''),
  },
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36 GhostSignalsRecords/0.1',
};
