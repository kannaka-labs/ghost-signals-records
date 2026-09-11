'use strict';
// The desk: one turn of conversation with a visitor, wherever they are
// (the web page, the tower floor). The NPC core decides the state; this
// performs the side effects it asks for (title proposals, the quote, the
// checkout link) and persists the session.
const npc = require('./npc-core');
const { proposeAlbumTitles, proposeTrackTitles } = require('./lyrics');
const { TIERS } = require('./catalog');
const { freeAllowed, heldLine } = require('./free-core');

class Desk {
  /** `suno` is optional and used only to read the generator's credit balance
   *  for the free door; without it the door stays shut and says so. */
  constructor(cfg, orders, stripe, log = () => {}, suno = null) {
    this.cfg = cfg; this.orders = orders; this.stripe = stripe; this.log = log; this.suno = suno;
  }

  /** Ask the free policy about one order. Reads the generator's credits at
   *  most once a minute; a stale-but-recent number is fine for a door. */
  async freeCheck(order, { principal, sessionId }) {
    const f = this.cfg.free || {};
    const nowMs = Date.now();
    if (!this._credits || nowMs - this._creditsAt > 60000) {
      this._credits = this.suno ? await this.suno.credits() : null;
      this._creditsAt = nowMs;
    }
    const since = new Date(nowMs - (f.windowHours || 24) * 3600 * 1000).toISOString();
    return freeAllowed({
      mode: f.mode || 'auto',
      paymentsEnabled: this.stripe.enabled(),
      tier: order.tier,
      maxTier: f.maxTier || 'album',
      credits: this._credits,
      creditsPerTrack: f.creditsPerTrack,
      minCredits: f.minCredits,
      grantedToday: await this.orders.freeGrantedSince(since),
      dailyLimit: f.dailyLimit,
      grantedToVisitor: await this.orders.freeGrantedTo({ principal, sessionId }),
      visitorLimit: f.visitorLimit,
    });
  }

  /** Is the free door open at all? Cheap: mode and payments only, no counts.
   *  The full policy (caps, credits) runs at the quote. */
  freeDoorOpen() {
    const mode = (this.cfg.free || {}).mode || 'auto';
    if (mode === 'off') return false;
    if (mode === 'on') return true;
    return !this.stripe.enabled();
  }

  ctx(extra = {}) { return { npcName: this.cfg.npcName, prices: this.cfg.prices, freeOpen: this.freeDoorOpen(), ...extra }; }

  /** The opening line for a fresh session. */
  opening(session) { return npc.line(session.state, this.ctx()); }

  /** One turn. Returns { reply, session, order } with the session saved. */
  async turn(session, text, { principal, origin, email } = {}) {
    let { state, reply, needs } = npc.advance(session.state, text, this.ctx());
    let order = session.orderId ? await this.orders.get(session.orderId) : null;

    if (needs === 'propose_album_titles') {
      state.proposals.albumTitles = await proposeAlbumTitles(this.cfg.brain, { theme: state.brief.theme, style: state.brief.style }, 3);
      reply = npc.line(state, this.ctx());
    } else if (needs === 'propose_track_titles') {
      const n = TIERS[state.brief.tier].tracks;
      state.proposals.trackTitles = await proposeTrackTitles(this.cfg.brain, { albumTitle: state.brief.albumTitle, theme: state.brief.theme, style: state.brief.style }, n);
      reply = npc.line(state, this.ctx());
    } else if (needs === 'quote') {
      // The brief is complete: make the order, then the free door or the
      // payment link, in that order. The free door closes itself when
      // payments are configured, so the two never both open.
      if (!order || order.state !== 'quoted') {
        order = await this.orders.createFromBrief(state.brief, { principal, origin, email });
        await this.orders.saveSession(session.id, state, order.id);
      }
      const free = await this.freeCheck(order, { principal, sessionId: session.id });
      let checkoutUrl = null;
      if (free.ok) {
        const g = await this.orders.grantFree(order, free.reason);
        this.log(`free album ${order.publicId} (${order.tier}, est ${free.estimate} credits): ${g.ok ? 'granted' : g.reason}`);
        if (!g.ok) free.ok = false;
      }
      if (!free.ok) {
        try { checkoutUrl = await this.stripe.checkout(order, { email }); }
        catch (e) { this.log(`checkout unavailable for ${order.id}: ${e.message}`); }
      }
      order = await this.orders.get(order.id);
      const albumUrl = `${this.cfg.publicUrl}/album/${order.publicId}`;
      reply = npc.line(state, this.ctx({
        checkoutUrl: checkoutUrl || null,
        freeUrl: free.ok ? albumUrl : null,
        heldLine: !free.ok && !checkoutUrl ? heldLine(free.reason, order.publicId) : null,
      }));
    }
    await this.orders.saveSession(session.id, state, order ? order.id : null);
    return { reply, session: { ...session, state, orderId: order ? order.id : session.orderId }, order };
  }
}

module.exports = { Desk };
