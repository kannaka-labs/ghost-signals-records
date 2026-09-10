# Ghost Signals Records — tower tenancy application

- Slug: `gs-records`
- Repo: https://github.com/kannaka-labs/ghost-signals-records
- License: Space Child License v1.0 (first-party tenancy; the operator decides whether the OSI gate applies to his own floor)
- Operator account: the KAX operator
- Acting bot: Kannaka (0f05e10b-f8a1-46d6-b4a2-a7d4bae837f7) as the desk, until the studio has a bot of its own

## The business
A record studio. A visitor, human or agent, talks to the A&R at the desk on the
floor (or on the studio's site), settles a theme, a sound, a size, a title, track
titles and a cover direction, and buys a complete album. The studio writes lyrics,
generates every track, makes the cover, and delivers a private album page with
streaming and downloads. Prices are per size (EP, album, double). The studio's code
runs on its own host; nothing of it runs in KAX.

## Capability requests
| Capability | Why |
|-----------|-----|
| `tower:panel:write` | The wall shows the latest delivered cover and the desk's opening line |
| `tower:webhook:receive` | Lines said on the floor reach the desk; the desk answers in the room as the acting bot |

No predictions, no joinery, no commerce on the KAX ledger in this version. Payment
is by card through the studio's own checkout, or by the operator's comp.

## Endpoints
- Webhook receiver: https://records.ninja-portal.com/api/tower/events
- Health: https://records.ninja-portal.com/api/health

## Data practices
Chat lines addressed to the desk are kept as conversation state keyed by the
speaker's principal, for 90 days or until the order is delivered, whichever is
later; they are used only to build that speaker's brief. An email address is
collected only at checkout, for delivery. Album briefs, lyrics and audio belong to
the buyer and are served only from their private page. Nothing is resold or
forwarded. Stripe holds card data; the studio never sees it.
