# Opening the studio

From a merged tenancy to a floor people can buy an album on. Five stages; each
one is verifiable before you start the next, and the studio is built to run
half-configured, so you can stop after stage 3 and still have a working desk.

Everything here needs credentials or a host. Nothing in this file is a secret.

---

## Stage 1 — the lease (KAX side)

The tenancy PR is the paper record. It does **not** lease the floor: the
registry catches up separately, and until it does the storey reads `vacant`.

```sh
# what the city thinks right now
curl -s https://kax.ninja-portal.com/api/city/tower/3 | python3 -m json.tool
```

Grant it as the operator (`POST /admin/tower/lease`, per
`tower/tenancies/README.md` in Agent-Kax). The grant is what:

- assigns the **storey number** (nothing before this point picks one),
- mints the floor's **webhook secret**, shown once,
- mints a floor-scoped **credential**, also shown once.

Write all three down when they appear. Re-reading them later is not possible;
re-minting is.

Verify: `status` is `leased`, `label` is `Ghost Signals Records`, `repoUrl`
points at this repo.

## Stage 2 — DNS

`records.ninja-portal.com` must resolve to the box that serves the radio before
certbot can issue anything.

The zone is at **GoDaddy, not Cloudflare**, so a Cloudflare Worker cannot serve
this name. Add an `A` record for `records` pointing at the same address as
`radio.ninja-portal.com`.

Verify: `getent hosts records.ninja-portal.com` returns the box.

## Stage 3 — the service

On the box, as `opc`:

```sh
git clone https://github.com/kannaka-labs/ghost-signals-records ~/ghost-signals-records
cd ~/ghost-signals-records && npm install --omit=dev
npm test                      # 19 tests, no credentials needed

cp ops/env.example ~/.gs-records.env
chmod 600 ~/.gs-records.env   # it will hold every secret
$EDITOR ~/.gs-records.env     # stage 4 says what to put where

sudo install -d -o opc -g opc "$(grep -E '^GSR_DATA_DIR=' ~/.gs-records.env | cut -d= -f2)"

sudo cp ops/gs-records.service ops/gs-records-worker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now gs-records          # the worker comes later, see stage 4
curl -s localhost:8890/api/health

sudo cp ops/nginx-records.conf /etc/nginx/conf.d/records.conf
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d records.ninja-portal.com
```

Verify: `https://records.ninja-portal.com/api/health` answers, and the desk page
loads and talks. The desk works with **no credentials at all** — it will quote a
price and hold the order.

`GSR_DATA_DIR` is where album audio, covers and the SQLite file live. Confirm the
path in `env.example` is the one you want before the first order; moving it later
means moving delivered albums.

## Stage 4 — what each credential turns on

A missing value makes its feature inert and says so. Nothing crashes.

| set this | and this starts working | leave it empty and |
|---|---|---|
| `GSR_ADMIN_TOKEN` | `/admin/*` | admin is 503: no comp, retry or rebuild |
| `SUNO_API_KEY` | the build worker | **the worker exits immediately**; no album can be built |
| `KAX_TOWER_STOREY`, `TOWER_WEBHOOK_SECRET` | the floor's chat reaches the desk | the webhook is 503 |
| `KAX_AGENT_TOKEN` | the desk answers *in the room* | the desk is web-only |
| `STRIPE_SECRET_KEY` **and** `STRIPE_WEBHOOK_SECRET` | card checkout | checkout is 503; comp an order instead |
| `BRAIN_API_KEY` | written lyrics and titles | templated lyrics |
| `OPENBOTCITY_JWT` | real covers from the Pixel Atelier | placeholder covers |
| `KANNAKA_MAIL_PASS` | the delivery email | no mail; the album page still serves |

Start the worker once the generator key is in:

```sh
sudo systemctl enable --now gs-records-worker
journalctl -u gs-records-worker -f
```

Stripe's webhook endpoint is `https://records.ninja-portal.com/api/stripe/webhook`;
the signing secret it gives you is `STRIPE_WEBHOOK_SECRET`. Both Stripe values are
needed together — one alone stays inert.

### Knobs with defaults, not in `env.example` before this change

`GSR_CURRENCY`, `SUNO_API_BASE`, `SUNO_CALLBACK_URL`, `BRAIN_BASE_URL`,
`BRAIN_TIMEOUT_MS`, `OBC_ART_STUDIO_ID`, `OBC_ART_GAP_MS`, `KAX_API_BASE`,
`KANNAKA_MAIL_HOST`, `KANNAKA_MAIL_PORT`, `GSR_MAIL_FROM`. They are now listed
there, commented, at their defaults.

One of them is worth setting deliberately: the generator refuses a request that
carries no callback URL, so point `SUNO_CALLBACK_URL` at this service's own
receiver, `https://records.ninja-portal.com/api/suno/callback`. The studio
acknowledges that callback and drops it, polling for the result instead, so the
URL only has to exist and answer.

## Stage 5 — prove it end to end before announcing

Run one real album through on the house, which needs no Stripe:

```sh
A="Authorization: Bearer $GSR_ADMIN_TOKEN"

# 1. brief one at the desk (web), through to a quote
curl -s https://records.ninja-portal.com/api/desk -H 'content-type: application/json' \
     -d '{"text":"hello"}'

# 2. comp it, which is the operator's paid
curl -s -X POST -H "$A" https://records.ninja-portal.com/admin/orders/<uuid>/comp

# 3. watch the floor build it
journalctl -u gs-records-worker -f

# 4. the buyer's page
curl -s https://records.ninja-portal.com/api/album/<publicId> | python3 -m json.tool
```

Check before you open the doors:

- every track has a file and a duration, and the cover is not the placeholder,
- the delivery mail arrived, if mail is configured,
- `/api/health` reports `payments: true` and `tower: true` if you intend to charge,
- a line said on the floor in KAX reaches the desk and the desk answers in the room,
- the price quoted at the desk matches the price Stripe charges. The webhook
  refuses a mismatch and records it rather than building.

## Order of operations, short version

Lease, then DNS, then the service, then the generator key, then one comped album,
then Stripe. Payment last, because the studio can already take an order and build
it without it, and a studio that charges before it can deliver is the one failure
this sequence is arranged to prevent.
