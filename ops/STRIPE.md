# Turning payments on

Ten minutes in the Stripe dashboard and one restart. Until you do this the studio
runs on the free door: albums on the house while the generator has credit. The moment
both values below are set, the free door closes itself and the desk hands out payment
links instead. Nothing else changes.

Do it in **test mode first**. The dashboard has a test/live toggle; everything below
exists twice, once per mode, with different keys. A test-mode run proves the whole
path with a fake card and costs nothing.

## 1. The webhook endpoint

Developers → Webhooks → **Add endpoint**.

| field | value |
|---|---|
| Endpoint URL | `https://records.ninja-portal.com/api/stripe/webhook` |
| Description | Ghost Signals Records |
| Events to send | the four below, nothing else |

Select exactly these events:

```
checkout.session.completed
payment_intent.succeeded
charge.refunded
charge.dispute.created
```

Why four and not one: `checkout.session.completed` is the normal signal;
`payment_intent.succeeded` is the backstop if the first is ever lost, and the studio
treats them as the same fact keyed on the order, so a duplicate is not a double
build. The refund and dispute events are recorded and acted on by a person, never
automatically.

Save the endpoint, then click **Reveal** under "Signing secret". It starts `whsec_`.
That is `STRIPE_WEBHOOK_SECRET`.

## 2. The secret key

Developers → API keys → Secret key → Reveal. It starts `sk_test_` in test mode and
`sk_live_` in live mode. That is `STRIPE_SECRET_KEY`.

Never paste either value into a chat, a commit, or a shell command that lands in
history. Put them straight into the env file in step 3.

## 3. Both values onto the box

On the Oracle host, edit `/home/opc/.gs-records.env` (mode 600) and fill the two
lines that are already there:

```
STRIPE_SECRET_KEY=sk_test_…
STRIPE_WEBHOOK_SECRET=whsec_…
```

Then:

```sh
sudo systemctl restart gs-records gs-records-worker
curl -s https://records.ninja-portal.com/api/health
```

`"payments": true` and `"free": {"open": false, …}` is the whole confirmation.

## 4. Prove it

**The webhook.** Back in the dashboard, on the endpoint page, **Send test webhook**
with `checkout.session.completed`. Expect **200** and the body
`no order reference; ignored`: the synthetic event names no order of ours, and the
studio says so rather than pretending it paid something. If you get 400, the signing
secret is wrong. If 503, the service did not pick up the env; restart it.

**A real purchase, test mode.** Open `https://records.ninja-portal.com/desk`, brief a
four-track EP, confirm, and pay on the link with Stripe's test card
`4242 4242 4242 4242`, any future expiry, any CVC. Then:

```sh
curl -s https://records.ninja-portal.com/api/album/<public id>
```

`"state": "paid"` within a few seconds, then `building`, then `delivered`. On the box,
`sudo journalctl -u gs-records-worker -f` shows each track as it finishes.

**What the studio refuses.** A charge whose amount does not match the quoted price is
recorded as a mismatch and pays nothing; a second copy of the same event pays nothing
twice. Both are tested, and both are things you want to be true before live mode.

## 5. Going live

Flip the dashboard to live mode and repeat steps 1 and 2 there: a live endpoint with
the same four events, and the live secret key. Replace both values in the env file,
restart, and check `/api/health` again. Test-mode keys never charge a real card, and
live-mode keys never accept the test card, so a mix-up fails loudly rather than
quietly.

## Keeping the free door open alongside payments

Set `GSR_FREE_MODE=on` in the env file. Then a visitor gets an album on the house
while the caps and the credit floor allow it, and a payment link only when they do
not. `GSR_FREE_MODE=off` shuts the door entirely and makes the studio paid-only.
