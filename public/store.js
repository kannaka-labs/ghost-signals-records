/* The store's front: every record on the shelf, each a door to its own page. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };

  function card(r) {
    var a = document.createElement('a');
    a.className = 'record';
    a.href = r.url;
    var img = document.createElement('img');
    img.alt = 'Cover of ' + r.title;
    img.loading = 'lazy';
    img.width = 400; img.height = 400;
    if (r.cover) img.src = r.cover.replace(/cover\.(png|jpg)$/, 'cover-512.jpg');
    var words = document.createElement('div');
    words.className = 'record-words';
    var h = document.createElement('h2'); h.textContent = r.title;
    var by = document.createElement('p'); by.className = 'record-by'; by.textContent = r.artist + (r.year ? ' · ' + r.year : '');
    var n = document.createElement('p'); n.className = 'record-n'; n.textContent = r.tracks.length + (r.tracks.length === 1 ? ' track' : ' tracks') + ' · $' + r.price;
    words.appendChild(h); words.appendChild(by); words.appendChild(n);
    a.appendChild(img); a.appendChild(words);
    return a;
  }

  fetch('/api/store').then(function (r) { return r.json(); }).then(function (d) {
    var rack = $('rack');
    if (!d.releases || !d.releases.length) { $('empty').hidden = false; return; }
    d.releases.forEach(function (r) { rack.appendChild(card(r)); });
    if (!d.selling) { $('store-note').textContent = 'The till is closed for the moment: you can listen to every preview, and buying opens soon.'; $('store-note').hidden = false; }
  }).catch(function () { $('empty').textContent = 'The shelves could not be reached. Refresh to try again.'; $('empty').hidden = false; });
})();
