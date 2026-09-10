# ADR-0001: Ghost Signals Records — a studio on a floor of the tower

**Status:** Proposed
**Date:** 2026-09-10
**Author:** Nick Flach / Kannaka

## Context

Nick's ask: a full record studio on an empty floor of Ghost Signals Tower in KAX City, as
a separate project with its own money. People and agents walk to the floor, talk to an
NPC who helps them settle a theme, a sound, titles and cover art, buy a complete album,
and the studio builds and delivers it. The Suno-direct pipeline and the `album-release`
operator playbook are the template: they have shipped nine albums by hand.

Facts that shape the design, each verified before writing:

- **A floor is a lease, not a deployment** (KAX-ADR-0005). Tenant code never runs in
  KAX. The floor's wall is a *panel*: a headline, six lines, one image from an
  allow-listed host (`.ninja-portal.com` is on the list), a CTA room. KAX delivers the
  floor's chat as signed `chat.said` events to the tenant's receiver.
- **An NPC can only speak in the room as a real KAX agent** (`/city/say` with an agent
  token). There is no tenant "say" route. So the desk is a bot the studio operates.
- **KAX credits have no peer transfer today** (`/ledger/grant|escrow|trade|payout`).
  Agents cannot pay the studio in credits without a KAX-side route.
- **Stripe keys are not on the box.** The radio's ad payments were built to be inert
  without them and reviewed for money safety; that code is the port.
- **The generator refuses artist names** at the style field, immediately.
- **The hosted brain is OpenAI-compatible** at `ninja-portal.com/v1`.

## Decision

One service, `ghost-signals-records`, on the Oracle box beside the radio, public at
`records.ninja-portal.com`, no framework, one dependency (sqlite3), inert wherever a
credential is missing.

**The desk is a state machine, not a model.** `npc-core.js` decides every step (theme,
sound, size, album title, track titles, cover, confirm, checkout) and reads every answer
deterministically. A model may propose titles and, later, rephrase lines; it never
decides state. The studio sells albums with no model at all, on templated lines and
templated lyrics, and says so in the manifest.

**The same desk answers everywhere.** On the web, a cookie names the session. On the
floor, the KAX principal names it: a `chat.said` addressed to the desk becomes a turn,
and the NPC answers in the room as the studio's own agent, split to the room's line
length. A visitor can start on the floor and finish on the web; the brief is the same
row.

**Money is one path with two doors.** A completed brief becomes an order in state
`quoted` with a price fixed at quote time. Stripe Checkout (cards only, one line item,
the order id in `client_reference_id` and metadata, one-hour expiry) is the door for
anyone with a card. The operator's `comp` is the door for agents and gifts, with a zero
ledger row. A webhook is verified over the raw body, classified, and applied under a
compare-and-set with an exactly-once ledger key; an amount that does not match the quote
is recorded as a mismatch and pays nothing. Refunds and disputes are recorded, never
acted on automatically. A KAX-credit door is a KAX-side route to be proposed separately.

**The build is the playbook, mechanised, resumable.** Per track: lyrics from the brain
or the template; one generate call; the longer of the two variants; download with a
browser UA. A style the generator refuses is rewritten once by the brain (or by
stripping proper-noun runs) and retried once. A cover from the Pixel Atelier as the
studio's OBC bot (enter the building, 95 s gap, three attempts), or a placeholder that
says it is one. Files under the order's directory, `album.json` beside them, then the
order is `delivered` and the buyer is mailed from Kannaka's own address. A failure sets
`failed` with the reason; the operator's retry requeues it and the worker resumes from
the tracks already done.

**Delivery is a private page.** `/album/<22-char id>` streams and downloads the tracks
and shows the cover; nothing lists these pages. Files are served only for orders in
`building` or `delivered`.

**Tenancy.** The studio applies for a floor as a first-party tenancy
(`tower/TENANCY.md` in this repo, mirrored into Agent-Kax `tower/tenancies/gs-records/`).
Capabilities: `tower:panel:write` (the latest cover on the wall, the desk's hours),
`tower:webhook:receive` (the floor's chat). The tower guidelines ask for an OSI license;
this repository is under the Space Child License like the rest of the constellation, and
the operator, who is also the landlord, decides whether that gate applies to his own
tenancy.

## Consequences

- Nothing here depends on a model being up, a key being set, or KAX being reachable.
  Each absence degrades one feature and logs it.
- Every price, name and tier is configuration. The desk's name defaults to Vesper.
- The build takes an hour or two of wall time per album on the generator's side and
  costs a few dollars of generator credit; prices default to $19 / $39 / $69 and are
  the operator's to set.
- Agents can brief and be comped today; they cannot pay in credits until KAX gains a
  transfer route. That is the next proposal, not this one.

## Not decided here

Radio premieres of delivered albums, YouTube videos, and OBC gallery publication are
phases 2, 4 and 5 of the playbook and are deliberately outside v1. The delivered
directory has everything they need.
