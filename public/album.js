/* An album's own page: play it, and decide what the world sees of it. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var id = document.querySelector('main.album-page').dataset.id;
  var album = null;

  function fmt(s) { s = Math.round(s || 0); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }

  // ---- player (the same transport the front page uses) ----
  var audio = $('audio'), player = $('player'), current = null;
  function playTrack(t) {
    current = t;
    audio.src = t.file;
    audio.play().catch(function () {});
    player.hidden = false;
    $('now-track').textContent = t.title;
    $('now-album').textContent = album ? album.album : '';
    mark();
  }
  function mark() {
    var rows = document.querySelectorAll('#tracks li');
    for (var i = 0; i < rows.length; i++) {
      rows[i].dataset.playing = (current && String(rows[i].dataset.n) === String(current.n) && !audio.paused) ? 'true' : 'false';
    }
  }
  $('transport').addEventListener('click', function () {
    if (!current) {
      var first = ((album && album.tracks) || []).filter(function (t) { return t.file; })[0];
      if (first) playTrack(first);
      return;
    }
    if (audio.paused) audio.play(); else audio.pause();
  });
  $('player-close').addEventListener('click', function () { audio.pause(); player.hidden = true; });
  audio.addEventListener('play', function () { $('transport-glyph').innerHTML = '&#10073;&#10073;'; mark(); });
  audio.addEventListener('pause', function () { $('transport-glyph').innerHTML = '&#9654;'; mark(); });
  audio.addEventListener('timeupdate', function () {
    var pct = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
    $('meter-fill').style.width = pct + '%';
    $('clock').textContent = fmt(audio.currentTime);
  });
  $('meter').addEventListener('click', function (ev) {
    var r = this.getBoundingClientRect();
    if (audio.duration) audio.currentTime = ((ev.clientX - r.left) / r.width) * audio.duration;
  });

  // ---- the page ----
  var WORDS = {
    quoted: 'Waiting for payment. The studio starts the moment it clears.',
    paid: 'Paid. The studio starts shortly.',
    building: 'Building now. Tracks appear here as they finish.',
    delivered: 'Finished.',
    failed: 'The build hit a problem and the operator has been told.',
    cancelled: 'Cancelled.',
    briefing: 'Still at the desk.',
  };

  function render(a) {
    album = a;
    $('title').textContent = a.album;
    $('state').textContent = (a.tier ? a.tier + '. ' : '') + (WORDS[a.state] || a.state);
    if (a.cover) { $('cover').src = a.cover; $('cover').alt = 'Cover of ' + a.album; $('cover-empty').hidden = true; }

    var ol = $('tracks');
    ol.textContent = '';
    a.tracks.forEach(function (t) {
      var li = document.createElement('li');
      li.dataset.n = t.n;
      var num = document.createElement('span'); num.className = 'num'; num.textContent = String(t.n).padStart(2, '0');
      var mid;
      if (t.file) {
        mid = document.createElement('button'); mid.className = 'name'; mid.type = 'button'; mid.textContent = t.title;
        var bars = document.createElement('span'); bars.className = 'bars'; bars.setAttribute('aria-hidden', 'true');
        bars.innerHTML = '<i></i><i></i><i></i>'; mid.appendChild(bars);
        mid.addEventListener('click', function () { playTrack(t); });
      } else {
        mid = document.createElement('span'); mid.className = 'name'; mid.textContent = t.title;
      }
      var right = document.createElement('span'); right.className = 'dur';
      right.textContent = t.file ? fmt(t.duration) : t.status;
      li.appendChild(num); li.appendChild(mid); li.appendChild(right);
      if (t.file) {
        var dl = document.createElement('a'); dl.className = 'dl'; dl.href = t.file + '?dl=1'; dl.textContent = 'download';
        li.appendChild(dl);
      }
      ol.appendChild(li);
    });

    $('pay').textContent = '';
    if (a.checkoutUrl) {
      var b = document.createElement('a'); b.className = 'btn'; b.href = a.checkoutUrl; b.textContent = 'Pay and start the build';
      $('pay').appendChild(b);
    }

    if (a.state === 'delivered') {
      $('owner').hidden = false;
      $('feature-on').checked = Boolean(a.featured);
      if (a.note) $('feature-note').value = a.note;
      var sel = $('radio-track');
      if (!sel.options.length) {
        a.tracks.filter(function (t) { return t.file; }).forEach(function (t) {
          var o = document.createElement('option'); o.value = t.n; o.textContent = t.n + '. ' + t.title; sel.appendChild(o);
        });
      }
      if (a.radioTrack) sel.value = a.radioTrack;
      if (a.radioAired) {
        $('radio-said').textContent = 'Track ' + a.radioTrack + ' has had its spin.';
        $('radio-send').disabled = true; sel.disabled = true;
      } else if (a.radioTrack) {
        $('radio-said').textContent = 'Track ' + a.radioTrack + ' is queued. You can change it until it airs.';
      }
    }

    mark();
    // While the floor is still working, look again in twenty seconds.
    if (a.state === 'building' || a.state === 'paid') setTimeout(load, 20000);
  }

  function load() {
    fetch('/api/album/' + id).then(function (r) { return r.json(); }).then(function (a) {
      if (a.error) { $('state').textContent = a.error; return; }
      render(a);
    }).catch(function () { $('state').textContent = 'Could not load this page. Refresh to try again.'; });
  }
  load();

  // ---- the owner's two decisions ----
  function say(el, text) { el.textContent = text; }

  $('feature-on').addEventListener('change', function () {
    var on = this.checked;
    fetch('/api/album/' + id + '/feature', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ on: on, note: $('feature-note').value.trim() || undefined }),
    }).then(function (r) { return r.json(); }).then(function () { load(); });
  });
  $('feature-note').addEventListener('change', function () {
    if (!$('feature-on').checked) return;
    fetch('/api/album/' + id + '/feature', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ on: true, note: this.value.trim() || undefined }),
    });
  });

  $('radio-send').addEventListener('click', function () {
    var n = Number($('radio-track').value);
    if (!n) return;
    say($('radio-said'), 'Sending…');
    fetch('/api/album/' + id + '/radio', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ track: n }),
    }).then(function (r) { return r.json(); }).then(function (d) {
      say($('radio-said'), d.ok
        ? 'Queued: “' + d.title + '”. We will write when it airs.'
        : (d.error || 'That could not be queued.'));
    }).catch(function () { say($('radio-said'), 'That could not be queued.'); });
  });
})();
