/* Ghost Signals Records — the front page.
   Three jobs: show the shelf, play a record, and talk to the desk. No
   framework, no dependencies; every element it touches exists in index.html. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var albums = [];
  var selected = null;

  function fmt(sec) {
    sec = Math.round(sec || 0);
    return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
  }

  // ------------------------------------------------------------- player
  var audio = $('audio');
  var player = $('player');
  var current = null; // { album, track }

  function playTrack(album, track) {
    current = { album: album, track: track };
    audio.src = track.file;
    audio.play().catch(function () { /* the browser wants a gesture; the button is one */ });
    player.hidden = false;
    $('now-track').textContent = track.title;
    $('now-album').textContent = album.album;
    $('transport-glyph').innerHTML = '&#10073;&#10073;';
    $('transport').setAttribute('aria-label', 'Pause');
    markPlaying();
  }

  function markPlaying() {
    var rows = document.querySelectorAll('#tracklist li');
    for (var i = 0; i < rows.length; i++) {
      var on = Boolean(current) && selected && current.album.publicId === selected.publicId
        && String(rows[i].dataset.n) === String(current.track.n) && !audio.paused;
      rows[i].dataset.playing = on ? 'true' : 'false';
    }
  }

  $('transport').addEventListener('click', function () {
    if (!current) { if (selected && selected.tracks.length) playTrack(selected, selected.tracks[0]); return; }
    if (audio.paused) audio.play(); else audio.pause();
  });
  $('player-close').addEventListener('click', function () { audio.pause(); player.hidden = true; });
  audio.addEventListener('play', function () { $('transport-glyph').innerHTML = '&#10073;&#10073;'; markPlaying(); });
  audio.addEventListener('pause', function () { $('transport-glyph').innerHTML = '&#9654;'; markPlaying(); });
  audio.addEventListener('ended', function () {
    if (!current) return;
    var list = current.album.tracks;
    var i = list.findIndex(function (t) { return t.n === current.track.n; });
    if (i > -1 && i + 1 < list.length) playTrack(current.album, list[i + 1]);
    else markPlaying();
  });
  audio.addEventListener('timeupdate', function () {
    var pct = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
    $('meter-fill').style.width = pct + '%';
    $('meter').setAttribute('aria-valuenow', Math.round(pct));
    $('clock').textContent = fmt(audio.currentTime);
  });
  function seekFromEvent(ev) {
    var r = $('meter').getBoundingClientRect();
    var x = (ev.clientX - r.left) / r.width;
    if (audio.duration) audio.currentTime = Math.max(0, Math.min(1, x)) * audio.duration;
  }
  $('meter').addEventListener('click', seekFromEvent);
  $('meter').addEventListener('keydown', function (ev) {
    if (!audio.duration) return;
    if (ev.key === 'ArrowRight') { audio.currentTime = Math.min(audio.duration, audio.currentTime + 5); ev.preventDefault(); }
    if (ev.key === 'ArrowLeft') { audio.currentTime = Math.max(0, audio.currentTime - 5); ev.preventDefault(); }
  });

  // ------------------------------------------------------------- the record on show
  function show(album) {
    selected = album;
    $('b-theme').textContent = album.theme || '—';
    $('b-style').textContent = album.style || '—';
    $('b-tier').textContent = album.tier + ', ' + album.tracks.length + ' tracks';
    $('b-note').textContent = album.note ? '“' + album.note + '”' : '';
    $('hero-play-title').textContent = album.album;

    var cover = $('hero-cover');
    if (album.cover) { cover.src = album.cover; cover.alt = 'Cover of ' + album.album; $('hero-empty').hidden = true; }

    var ol = $('tracklist');
    ol.textContent = '';
    album.tracks.forEach(function (t) {
      var li = document.createElement('li');
      li.dataset.n = t.n;
      var num = document.createElement('span'); num.className = 'num'; num.textContent = String(t.n).padStart(2, '0');
      var btn = document.createElement('button'); btn.className = 'name'; btn.type = 'button'; btn.textContent = t.title;
      var bars = document.createElement('span'); bars.className = 'bars'; bars.setAttribute('aria-hidden', 'true');
      bars.innerHTML = '<i></i><i></i><i></i>';
      btn.appendChild(bars);
      btn.addEventListener('click', function () { playTrack(album, t); });
      var dur = document.createElement('span'); dur.className = 'dur'; dur.textContent = fmt(t.duration);
      li.appendChild(num); li.appendChild(btn); li.appendChild(dur);
      ol.appendChild(li);
    });

    var items = document.querySelectorAll('.rack-item');
    for (var i = 0; i < items.length; i++) {
      items[i].setAttribute('aria-current', items[i].dataset.id === album.publicId ? 'true' : 'false');
    }
    markPlaying();
  }

  function buildShelf() {
    var rack = $('shelf-rack');
    rack.textContent = '';
    albums.forEach(function (a) {
      var b = document.createElement('button');
      b.className = 'rack-item'; b.type = 'button'; b.dataset.id = a.publicId; b.setAttribute('role', 'listitem');
      var sleeve = document.createElement('div'); sleeve.className = 'sleeve';
      if (a.cover) {
        var img = document.createElement('img'); img.src = a.cover; img.alt = ''; img.loading = 'lazy';
        img.width = 320; img.height = 320; sleeve.appendChild(img);
      }
      var title = document.createElement('p'); title.className = 'rack-title'; title.textContent = a.album;
      var meta = document.createElement('p'); meta.className = 'rack-meta';
      meta.textContent = a.tracks.length + ' tracks' + (a.radioAired ? ', aired on the radio' : '');
      b.appendChild(sleeve); b.appendChild(title); b.appendChild(meta);
      b.addEventListener('click', function () { show(a); document.getElementById('record').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
      rack.appendChild(b);
    });
  }

  $('hero-play').addEventListener('click', function () {
    if (selected && selected.tracks.length) playTrack(selected, selected.tracks[0]);
  });

  fetch('/api/showcase').then(function (r) { return r.json(); }).then(function (d) {
    albums = (d.albums || []).filter(function (a) { return a.tracks.length; });
    if (!albums.length) {
      $('shelf-empty').hidden = false;
      document.getElementById('record').hidden = true;
      $('hero-play').disabled = true;
      $('hero-play-title').textContent = 'the first record';
      $('hero-fine').textContent = 'The shelf is empty. The first record made here will be someone’s own.';
      return;
    }
    buildShelf();
    show(albums[0]);
    $('hero-fine').textContent = albums.length === 1
      ? 'One record on the shelf so far.'
      : albums.length + ' records on the shelf, chosen by the people who own them.';
  }).catch(function () {
    $('hero-fine').textContent = 'The shelf could not be read just now.';
  });

  // ------------------------------------------------------------- prices
  fetch('/api/catalog').then(function (r) { return r.json(); }).then(function (c) {
    var ul = $('prices');
    ul.textContent = '';
    c.tiers.forEach(function (t) {
      var li = document.createElement('li');
      var what = document.createElement('p'); what.className = 'what';
      what.textContent = t.label;
      var many = document.createElement('span'); many.className = 'how-many';
      many.textContent = t.blurb;
      what.appendChild(many);
      var amt = document.createElement('span'); amt.className = 'amount';
      var free = c.freeOpen && (t.key === 'ep' || t.key === c.freeMaxTier || (c.freeMaxTier === 'double'));
      if (free) { amt.classList.add('free'); amt.textContent = 'on the house'; }
      else amt.textContent = '$' + (t.priceCents / 100).toFixed(0);
      li.appendChild(what); li.appendChild(amt);
      ul.appendChild(li);
    });
    $('cost-note').textContent = c.freeOpen
      ? 'While the studio has generator credit, records up to ' + c.freeMaxTier + ' size are on the house, one to a customer. When that runs out the prices above apply.'
      : 'Paid once, by card. The record and everything in it is yours; nothing recurring.';
  }).catch(function () {});

  // ------------------------------------------------------------- the desk
  var log = $('log'), form = $('say'), input = $('text'), email = $('email');
  var session = null;

  function line(who, text) {
    var d = document.createElement('p');
    d.className = 'line ' + who;
    String(text).split(/(https?:\/\/[^\s]+)/g).forEach(function (p) {
      if (/^https?:\/\//.test(p)) {
        var a = document.createElement('a'); a.href = p; a.textContent = p; a.rel = 'noopener'; d.appendChild(a);
      } else d.appendChild(document.createTextNode(p));
    });
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
  }

  function showBrief(b, order) {
    var panel = $('brief-panel');
    if (b) {
      panel.hidden = false;
      var dds = panel.querySelectorAll('dd');
      for (var i = 0; i < dds.length; i++) {
        var k = dds[i].getAttribute('data-k');
        var v = b[k];
        if (Array.isArray(v)) v = v.length ? v.map(function (t, n) { return (n + 1) + '. ' + t; }).join('\n') : '';
        dds[i].textContent = v || '—';
      }
    }
    var box = $('order-state');
    box.textContent = '';
    if (!order) return;
    var p = document.createElement('p');
    p.textContent = 'Order ' + order.publicId + ', ' + order.state;
    box.appendChild(p);
    if (order.checkoutUrl) {
      var a = document.createElement('a'); a.className = 'btn'; a.href = order.checkoutUrl; a.textContent = 'Pay and start the build';
      box.appendChild(a);
    }
    var page = document.createElement('a'); page.href = '/album/' + order.publicId; page.textContent = 'Your album page';
    box.appendChild(page);
  }

  function post(body) {
    return fetch('/api/desk', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      credentials: 'same-origin', body: JSON.stringify(body),
    }).then(function (r) { return r.json(); });
  }

  post({}).then(function (r) { session = r.session; line('npc', r.reply); })
    .catch(function () { line('npc', 'The desk is not answering. Try again in a moment.'); });

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
    }).catch(function () { line('npc', 'Lost the thread. Say that again.'); });
  });

  $('reset').addEventListener('click', function () {
    post({ reset: true }).then(function (r) {
      session = r.session; log.textContent = ''; $('brief-panel').hidden = true; line('npc', r.reply);
    });
  });
})();
