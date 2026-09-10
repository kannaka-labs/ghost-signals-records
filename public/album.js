(function () {
  'use strict';
  var main = document.querySelector('main.album');
  var id = main.getAttribute('data-id');
  var tracks = document.getElementById('tracks');
  var state = document.getElementById('state');
  var pay = document.getElementById('pay');
  var cover = document.getElementById('cover');
  var paidHint = /[?&]paid=1/.test(location.search);

  function fmt(s) { s = Math.round(s || 0); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }

  function render(a) {
    var msg = { quoted: 'Waiting for payment.', paid: 'Paid. The studio starts shortly.', building: 'Building. Tracks appear here as they finish.', delivered: 'Delivered.', failed: 'The build hit a problem; the operator has been told.', cancelled: 'Cancelled.', briefing: 'Still at the desk.' };
    state.textContent = (a.tier ? a.tier + ' · ' : '') + (msg[a.state] || a.state) + (paidHint && a.state === 'quoted' ? ' (payment received; confirming…)' : '');
    tracks.innerHTML = '';
    a.tracks.forEach(function (t) {
      var li = document.createElement('li');
      var title = document.createElement('span'); title.className = 'ttl'; title.textContent = t.title;
      li.appendChild(title);
      if (t.file) {
        var au = document.createElement('audio'); au.controls = true; au.preload = 'none'; au.src = t.file; li.appendChild(au);
        var dl = document.createElement('a'); dl.href = t.file + '?dl=1'; dl.textContent = 'download' + (t.duration ? ' · ' + fmt(t.duration) : ''); dl.className = 'small'; li.appendChild(dl);
      } else {
        var st = document.createElement('span'); st.className = 'small'; st.textContent = t.status; li.appendChild(st);
      }
      tracks.appendChild(li);
    });
    cover.innerHTML = '';
    if (a.cover) { var img = document.createElement('img'); img.src = a.cover; img.alt = 'cover'; cover.appendChild(img); }
    pay.innerHTML = '';
    if (a.checkoutUrl) { var b = document.createElement('a'); b.className = 'pay'; b.href = a.checkoutUrl; b.textContent = 'Pay and start the build'; pay.appendChild(b); }
  }

  function load() {
    fetch('/api/album/' + id).then(function (r) { return r.json(); }).then(function (a) {
      if (a.error) { state.textContent = a.error; return; }
      render(a);
      if (a.state === 'building' || a.state === 'paid' || (paidHint && a.state === 'quoted')) setTimeout(load, 20000);
    }).catch(function () { state.textContent = 'Could not load; refresh.'; });
  }
  load();
})();
