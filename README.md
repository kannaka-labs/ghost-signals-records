# Ghost Signals Records

A record studio on a floor of Ghost Signals Tower in KAX City. A visitor, human or
agent, talks to the A&R at the desk, settles a theme, a sound, a size, a title, track
titles and a cover, and buys a complete album. The studio writes the lyrics, generates
every track, makes the cover, and delivers a private page with streaming and downloads.

Read [`docs/adr/ADR-0001-ghost-signals-records.md`](docs/adr/ADR-0001-ghost-signals-records.md)
for why it is shaped this way, and [`tower/TENANCY.md`](tower/TENANCY.md) for what the
floor is.

## What is here

| file | role |
|---|---|
| `server/npc-core.js` | the desk as a pure state machine: what it asks, how it reads an answer, what comes next. A model may propose titles; it never decides state |
| `server/order-core.js` | order states and the only moves between them; brief validation; the artist-name check |
| `server/stripe-core.js`, `server/stripe.js` | Checkout and the webhook over plain HTTPS: raw-body signature, exactly-once ledger, amount must match the quote |
| `server/orders.js`, `server/db.js` | orders, sessions, tracks, events, ledger on one SQLite file |
| `server/desk.js` | one turn of conversation with its side effects (proposals, the quote, the link) |
| `server/tower.js`, `server/kax.js` | the floor: signed events in, the NPC's lines out as the studio's own agent, the wall |
| `server/worker.js`, `server/suno.js`, `server/lyrics.js`, `server/art.js` | the build: lyrics, generation, the longer variant, the cover, delivery, mail |
| `server/index.js` | the front door: the web desk, album pages, both webhooks, admin |
| `public/` | the desk page and the album page, no framework |
| `ops/` | systemd units, nginx, the env template |

One dependency (`sqlite3`). Node 20+. `npm test` runs everything against temp
databases with the generator, the brain and Stripe stubbed.

## Running it

```sh
npm install
cp ops/env.example ~/.gs-records.env   # fill what you have; the rest stays inert
set -a; . ~/.gs-records.env; set +a
node server/index.js                    # the desk, on :8890
node server/worker.js                   # the studio floor (needs SUNO_API_KEY)
```

`GET /api/health` says which features are live. The desk works with nothing set; the
worker needs the generator key; payments need both Stripe values; the floor needs the
tower's webhook secret and, to speak in the room, an agent token and the storey.

## The desk, from a shell

```sh
curl -s localhost:8890/api/desk -d '{}'                        # the opening line + a session id
curl -s localhost:8890/api/desk -d '{"session":"…","text":"A record about a lighthouse keeper who stops writing letters."}'
```

Steps: theme → sound (instrument, tempo, era, mood; artist names are refused) → size
(4 / 8 / 12) → album title (three proposed) → track titles (a running order proposed)
→ cover → confirm → the payment link. An order exists from the confirm; the album page
exists from then on and fills in as the studio builds.

## Operating it

- `GET /admin/orders`, `POST /admin/orders/:id/comp|retry|cancel`, `POST /admin/panel`
  with `Authorization: Bearer $GSR_ADMIN_TOKEN`.
- A failed build mails the operator with the reason and the retry command; retry
  requeues and the worker resumes from the tracks already done.
- Delivered files live under `$GSR_DATA_DIR/orders/<public id>/` with `album.json`,
  `brief.json`, the lyrics, the cover and the tracks: everything the radio, YouTube and
  gallery phases of the playbook need.

## Traps written down

- The generator refuses any style naming a real artist or band, at once. The desk
  checks the obvious shape; the worker rewrites once on the generator's refusal.
- The audio CDN and the API both refuse a library user agent; a browser one is sent.
- The Pixel Atelier needs the bot inside the building and about 95 s between images.
- A webhook body is read as one buffer and decoded once; string concatenation of chunks
  once corrupted a signature permanently.
- `%h` in a system unit is root's home; the units use absolute paths.
