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
| `GSR_COVER_TOKEN` | the cover runner (kannaka-art on qBraid, see *Covers* below) | the runner is refused; covers get a house sleeve at the deadline |
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
`BRAIN_TIMEOUT_MS`, `KAX_API_BASE`,
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

- every track has a file and a duration, and the cover arrived (`GET /admin/covers`),
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


## Covers — kannaka-art on a qBraid GPU (replaces the Pixel Atelier)

The worker queues a cover job when it claims an order (`cover_jobs`, `server/covers.js`);
the picture is painted while the tracks build, and delivery never waits for it. The painter
is a runner on **debain2** (`ops/cover-runner/`), which pulls work over HTTPS because
debain2 cannot ssh to this box. A job still pending after `GSR_COVER_DEADLINE_HOURS` (8),
3 failed pods, or 2 "every image too small" pods gets a **house sleeve**: one of the
label's own generic images in `$GSR_DATA_DIR/house-sleeves/`, the same one per order.
A late real cover still replaces it. The worker never writes a placeholder.

Operator: every painted cover mails `GSR_OPERATOR_EMAIL` with the link, the re-roll
command (`POST /admin/orders/<id>/cover`, answers 202; the old cover stays until the new
one lands) and the shelf approval (`POST /admin/orders/<id>/cover/ok`; a painted cover is
not shown on `/api/showcase` until then). `GET /admin/covers` lists the queue.

What v1 does NOT catch automatically: a face or pseudo-lettering in a painted cover. The
subject asks for a silhouette, the base-mode negative prompt forbids faces and text, two
candidates are painted per job, and the store crops 40 px off the sides and 80 off the
bottom (corner signatures). Past album batches still needed 3-4 rejects in 22-28 by eye,
so expect about one delivered cover in eight to need a re-roll until someone looks. The
operator mail is the backstop.

### Install (O1, after the PR is merged)

```sh
cd ~/ghost-signals-records && git pull && npm install --omit=dev && npm test
echo "GSR_COVER_TOKEN=$(openssl rand -hex 32)" >> ~/.gs-records.env   # never print it
install -d /var/oled/gs-records/house-sleeves      # copy the reviewed sleeves in (gsr-house-NN.png)

# nginx: the 4m location goes in the 443 server (see ops/nginx-records.conf)
sudo cp /etc/nginx/conf.d/records.conf ~/records.conf.bak-$(date +%Y%m%d)
sudoedit /etc/nginx/conf.d/records.conf && sudo nginx -t && sudo systemctl reload nginx

sudo systemctl restart gs-records gs-records-worker     # BOTH
curl -s 127.0.0.1:8890/api/covers/status               # {"queued":0,"leased":0,"oldestQueuedMinutes":0}
```

Gatus (`~/gatus/config/config.yaml`), in the same change as the cron:

```yaml
# endpoints: (group page)
  - name: gsr cover queue
    group: page
    url: http://127.0.0.1:8890/api/covers/status
    interval: 10m
    conditions: ["[STATUS] == 200", "[BODY].oldestQueuedMinutes < 360"]
    alerts: [{type: email, description: "a records cover has waited 6 h (house sleeve at 8 h): debain2 runner, qBraid or credits"}]
# external-endpoints:
  - {name: gsr-cover-runner, group: notice, token: "${GATUS_PUSH_TOKEN}", heartbeat: {interval: 30m}, alerts: [{type: email, description: "the GSR cover runner on debain2 has not reported for 30 minutes, or reported a failure (credits, day cap, pod hygiene)"}]}
```

### Install (debain2)

```sh
ssh debain2 'mkdir -p ~/gsr-covers && chmod 700 ~/gsr-covers'
scp ops/cover-runner/{gsr_cover_runner.py,gsr.json,gsr-cover-tick.sh} debain2:gsr-covers/
ssh debain2 'sed -i "s/\r$//" ~/gsr-covers/*.sh ~/gsr-covers/*.py && chmod +x ~/gsr-covers/gsr-cover-tick.sh'
# the token: the same value as GSR_COVER_TOKEN on O1, piped, never echoed
ssh -n -i ~/.ssh/ninja-portal-ed25519 opc@170.9.238.136 'grep ^GSR_COVER_TOKEN= ~/.gs-records.env | cut -d= -f2-' \
  | ssh debain2 'umask 077; cat > ~/.gsr-cover-token'
ssh debain2 '~/qbraid-venv2/bin/python ~/gsr-covers/gsr_cover_runner.py dry-run'   # plans one sample job, no pod
ssh debain2 '(crontab -l; echo "*/10 * * * * \$HOME/gsr-covers/gsr-cover-tick.sh") | crontab -'
```

The runner needs `~/kannaka-art/{kannaka_art.py,qbraid_run.sh}` (already deployed for the
albums) and `~/qbraid-venv2`. Knobs (env): `GSR_COVER_MIN_CREDITS` (150),
`GSR_COVER_MAX_PODS_DAY` (8 provisioned pods, re-checked before each pod),
`GSR_COVER_DAY_CREDITS` (40: no new lease once the account has spent that much since the
runner's first reading of the UTC day), `GSR_COVER_HELD_MAX_MIN` (90: a session older than
this, or one whose 10/60 cutoff did not take, turns the heartbeat red at once and on every
held tick, naming the instance), `GSR_COVER_PROFILES` (`gpu-rtx-4090,gpu-l4,gpu-a10`). Tests: `python -m unittest discover -s ops/cover-runner`
(set `KANNAKA_ART_DIR` to run the real-planner tests).

When covers arrive end to end: remove `OPENBOTCITY_JWT` from `~/.gs-records.env` (nothing
reads it any more) and restart both units.
