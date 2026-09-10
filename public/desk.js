(function () {
  'use strict';
  var log = document.getElementById('log');
  var form = document.getElementById('say');
  var input = document.getElementById('text');
  var email = document.getElementById('email');
  var reset = document.getElementById('reset');
  var orderBox = document.getElementById('order');
  var session = null;

  function line(who, text) {
    var d = document.createElement('div');
    d.className = 'line ' + who;
    var w = document.createElement('span'); w.className = 'who'; w.textContent = who === 'npc' ? '' : 'you';
    var t = document.createElement('span'); t.className = 'text';
    // Turn bare https links into anchors, nothing else.
    var parts = String(text).split(/(https?:\/\/[^\s]+)/g);
    parts.forEach(function (p) {
      if (/^https?:\/\//.test(p)) { var a = document.createElement('a'); a.href = p; a.textContent = p; a.rel = 'noopener'; a.target = '_blank'; t.appendChild(a); }
      else t.appendChild(document.createTextNode(p));
    });
    d.appendChild(w); d.appendChild(t);
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
  }

  function showBrief(b, order) {
    if (b) {
      document.querySelectorAll('#brief dd').forEach(function (dd) {
        var k = dd.getAttribute('data-k');
        var v = b[k];
        if (Array.isArray(v)) v = v.length ? v.map(function (t, i) { return (i + 1) + '. ' + t; }).join('\n') : '';
        dd.textContent = v || '—';
      });
    }
    orderBox.innerHTML = '';
    if (order) {
      var p = document.createElement('p');
      p.textContent = 'Order ' + order.publicId + ' · ' + order.state + (order.priceCents ? ' · $' + (order.priceCents / 100).toFixed(2) : '');
      orderBox.appendChild(p);
      if (order.checkoutUrl) { var a = document.createElement('a'); a.className = 'pay'; a.href = order.checkoutUrl; a.textContent = 'Pay and start the build'; orderBox.appendChild(a); }
      var s = document.createElement('a'); s.href = '/album/' + order.publicId; s.textContent = 'album page'; s.className = 'small'; orderBox.appendChild(s);
    }
  }

  function post(body) {
    return fetch('/api/desk', { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body) })
      .then(function (r) { return r.json(); });
  }

  fetch('/api/catalog').then(function (r) { return r.json(); }).then(function (c) {
    document.getElementById('prices').textContent = c.tiers.map(function (t) { return t.label + ' $' + (t.priceCents / 100).toFixed(0); }).join(' · ');
  }).catch(function () {});

  post({}).then(function (r) { session = r.session; line('npc', r.reply); }).catch(function () { line('npc', 'The desk is not answering. Try again in a moment.'); });

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var text = input.value.trim();
    if (!text) return;
    line('you', text);
    input.value = '';
    post({ session: session, text: text, email: email.value.trim() || undefined }).then(function (r) {
      session = r.session;
      line('npc', r.reply);
      showBrief(r.brief, r.order);
    }).catch(function () { line('npc', 'Lost the thread; say that again.'); });
  });

  reset.addEventListener('click', function () {
    post({ reset: true }).then(function (r) { session = r.session; log.innerHTML = ''; showBrief({}, null); line('npc', r.reply); });
  });
})();
