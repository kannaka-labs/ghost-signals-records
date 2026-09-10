'use strict';
// The desk: one turn of conversation with a visitor, wherever they are
// (the web page, the tower floor). The NPC core decides the state; this
// performs the side effects it asks for (title proposals, the quote, the
// checkout link) and persists the session.
const npc = require('./npc-core');
const { proposeAlbumTitles, proposeTrackTitles } = require('./lyrics');
const { TIERS } = require('./catalog');

class Desk {
  constructor(cfg, orders, stripe, log = () => {}) { this.cfg = cfg; this.orders = orders; this.stripe = stripe; this.log = log; }

  ctx(extra = {}) { return { npcName: this.cfg.npcName, prices: this.cfg.prices, ...extra }; }

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
      // The brief is complete: make the order and the payment link.
      if (!order || order.state !== 'quoted') {
        order = await this.orders.createFromBrief(state.brief, { principal, origin, email });
      }
      let checkoutUrl = null;
      try { checkoutUrl = await this.stripe.checkout(order, { email }); }
      catch (e) { this.log(`checkout unavailable for ${order.id}: ${e.message}`); }
      order = await this.orders.get(order.id);
      reply = npc.line(state, this.ctx({ checkoutUrl: checkoutUrl || null }));
      if (!checkoutUrl) reply += ` Your order is held as ${order.publicId}; the operator can also comp it.`;
    }
    await this.orders.saveSession(session.id, state, order ? order.id : null);
    return { reply, session: { ...session, state, orderId: order ? order.id : session.orderId }, order };
  }
}

module.exports = { Desk };
