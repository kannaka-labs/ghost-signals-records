/* One record: hear the previews, buy it with USDC on Base, download it. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var main = document.querySelector('main.release-page');
  var sku = main.dataset.sku;
  var pid = main.dataset.pid || null;
  var release = null, payment = null, pollTimer = null;
  var BASE_HEX = '0x2105';

  function fmt(s) { s = Math.round(s || 0); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
  function say(text) { $('buy-said').textContent = text; }

  // ---- player ----
  var audio = $('audio'), player = $('player'), current = null;
  function playTrack(t) {
    current = t; audio.src = t.preview; audio.play().catch(function () {});
    player.hidden = false; $('now-track').textContent = t.title + ' (preview)'; $('now-album').textContent = release ? release.title : ''; mark();
  }
  function mark() {
    var rows = document.querySelectorAll('#tracks li');
    for (var i = 0; i < rows.length; i++) rows[i].dataset.playing = (current && String(rows[i].dataset.n) === String(current.n) && !audio.paused) ? 'true' : 'false';
  }
  $('transport').addEventListener('click', function () {
    if (!current) { var first = (release.tracks || []).filter(function (t) { return t.preview; })[0]; if (first) playTrack(first); return; }
    if (audio.paused) audio.play(); else audio.pause();
  });
  $('player-close').addEventListener('click', function () { audio.pause(); player.hidden = true; });
  audio.addEventListener('play', function () { $('transport-glyph').innerHTML = '&#10073;&#10073;'; mark(); });
  audio.addEventListener('pause', function () { $('transport-glyph').innerHTML = '&#9654;'; mark(); });
  audio.addEventListener('ended', function () {
    var next = (release.tracks || []).filter(function (t) { return t.preview && t.n > current.n; })[0];
    if (next) playTrack(next);
  });
  audio.addEventListener('timeupdate', function () {
    $('meter-fill').style.width = (audio.duration ? (audio.currentTime / audio.duration) * 100 : 0) + '%';
    $('clock').textContent = fmt(audio.currentTime);
  });
  $('meter').addEventListener('click', function (ev) { var r = this.getBoundingClientRect(); if (audio.duration) audio.currentTime = ((ev.clientX - r.left) / r.width) * audio.duration; });

  // ---- the record ----
  function renderRelease(r) {
    release = r;
    $('title').textContent = r.title;
    $('by').textContent = r.artist + (r.year ? ', ' + r.year : '') + ' · ' + r.tracks.length + ' tracks';
    $('blurb').textContent = r.blurb || '';
    if (r.cover) { $('cover').src = r.cover; $('cover').alt = 'Cover of ' + r.title; }
    var ol = $('tracks'); ol.textContent = '';
    r.tracks.forEach(function (t) {
      var li = document.createElement('li'); li.dataset.n = t.n;
      var num = document.createElement('span'); num.className = 'num'; num.textContent = String(t.n).padStart(2, '0');
      var mid;
      if (t.preview) {
        mid = document.createElement('button'); mid.className = 'name'; mid.type = 'button'; mid.textContent = t.title;
        var bars = document.createElement('span'); bars.className = 'bars'; bars.setAttribute('aria-hidden', 'true'); bars.innerHTML = '<i></i><i></i><i></i>'; mid.appendChild(bars);
        mid.addEventListener('click', function () { playTrack(t); });
      } else { mid = document.createElement('span'); mid.className = 'name'; mid.textContent = t.title; }
      var dur = document.createElement('span'); dur.className = 'dur'; dur.textContent = t.duration ? fmt(t.duration) : '';
      li.appendChild(num); li.appendChild(mid); li.appendChild(dur); ol.appendChild(li);
    });
    $('price').textContent = '$' + r.price;
    if (!pid) { $('buy').hidden = !r.selling; if (!r.selling) { say(''); } }
  }

  // ---- buying ----
  function showPayment(p, pay) {
    payment = pay;
    $('manual').hidden = false;
    $('m-amount').textContent = pay.amount;
    $('m-addr').textContent = pay.payTo;
  }
  function showBought(p) {
    $('buy').hidden = true;
    $('bought').hidden = false;
    $('bought-said').textContent = 'Paid' + (p.txHash ? ' on Base (' + p.txHash.slice(0, 10) + '…)' : '') + '. Thank you.';
    $('download').href = p.download;
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  }
  function poll() {
    if (!pid) return;
    fetch('/api/purchase/' + pid).then(function (r) { return r.json(); }).then(function (d) {
      if (d.error) { say(d.error); return; }
      if (d.release && !release) renderRelease(d.release);
      if (d.purchase.state === 'paid') { showBought(d.purchase); return; }
      if (d.payment) { $('buy').hidden = false; showPayment(d.purchase, d.payment); }
      pollTimer = setTimeout(poll, 6000);
    }).catch(function () { pollTimer = setTimeout(poll, 10000); });
  }
  function openPurchase(from) {
    return fetch('/api/store/' + sku + '/buy', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: $('email').value.trim() || undefined, from: from || undefined }) })
      .then(function (r) { return r.json().then(function (j) { if (r.status !== 402 || !j.purchase) throw new Error(j.error || 'could not open the purchase'); return j; }); })
      .then(function (j) {
        pid = j.purchase.publicId;
        history.replaceState(null, '', '/p/' + pid);
        showPayment(j.purchase, j.payment);
        return j;
      });
  }
  function claim(hash) {
    say('Checking the chain…');
    return fetch('/api/purchase/' + pid + '/tx', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hash: hash }) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.ok) { if (d.purchase.state === 'paid') showBought(d.purchase); else say('Recorded.'); return; }
        var words = {
          pending: 'Not mined yet. We keep watching; this page updates itself.',
          unconfirmed: 'Mined. Waiting for a few more blocks to make it final.',
          wrong_amount: 'That transfer is not for ' + (payment ? payment.amount : 'the asked') + ' USDC.',
          wrong_recipient: 'That transfer did not go to the store address.',
          wrong_token: 'That transfer is not USDC.',
          wrong_sender: 'That transfer came from a different wallet than this purchase named.',
          too_early: 'That transfer is older than this purchase.',
          transfer_already_used: 'That transfer already paid for something.',
          tx_failed: 'That transaction failed on the chain.',
          bad_hash: 'That is not a transaction hash.',
          no_transfer_to_us: 'No USDC transfer to the store is in that transaction.',
        };
        say(words[d.reason] || d.reason || 'That could not be checked.');
        // The watcher settles it on its own; the status poll will show it.
        // Ask again by hash only now and then, as a second route to the same answer.
        if (d.reason === 'pending' || d.reason === 'unconfirmed') { if (!pollTimer) pollTimer = setTimeout(poll, 6000); setTimeout(function () { claim(hash); }, 30000); }
      }).catch(function () { say('The chain could not be reached. Try again in a moment.'); });
  }

  $('pay-wallet').addEventListener('click', function () {
    var eth = window.ethereum;
    if (!eth) { say('No wallet found in this browser. Use the other way below, or open this page in a wallet app.'); $('manual').hidden = false; return; }
    say('Asking your wallet…');
    var from;
    eth.request({ method: 'eth_requestAccounts' }).then(function (accts) {
      from = accts[0];
      return eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: BASE_HEX }] }).catch(function (e) {
        if (e && e.code === 4902) return eth.request({ method: 'wallet_addEthereumChain', params: [{ chainId: BASE_HEX, chainName: 'Base', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://mainnet.base.org'], blockExplorerUrls: ['https://basescan.org'] }] });
        throw e;
      });
    }).then(function () { return pid ? fetch('/api/purchase/' + pid).then(function (r) { return r.json(); }) : openPurchase(from); })
      .then(function (j) {
        payment = j.payment; if (!payment) throw new Error('this purchase is already settled');
        var g = payment.gasless;
        if (g && g.enabled && g.typedData) return payGasless(eth, from, g);
        return paySelf(eth, from);
      })
      .then(function (hash) { say('Sent. Waiting for the chain…'); $('tx').value = hash; poll(); return claim(hash); })
      .catch(function (e) { say(e && e.code === 4001 ? 'Cancelled in the wallet.' : (e && e.message) || 'The wallet did not complete the payment.'); });
  });

  // The buyer pays the gas: a plain USDC transfer from their wallet.
  function paySelf(eth, from) {
    say('Confirm the transfer of ' + payment.amount + ' USDC in your wallet. (This way needs a little ETH on Base for the network fee.)');
    return eth.request({ method: 'eth_sendTransaction', params: [{ from: from, to: payment.asset, data: payment.calldata, value: '0x0' }] });
  }

  // The store pays the gas: the buyer signs an authorization (no transaction,
  // no ETH) and the store's relayer submits it. If the wallet cannot sign
  // typed data, or the store declines (relayer dry), fall back to paySelf.
  function payGasless(eth, from, g) {
    var td = JSON.parse(JSON.stringify(g.typedData));
    td.message.from = from;
    say('Sign the payment of ' + payment.amount + ' USDC in your wallet. No ETH needed: the store pays the network fee.');
    return eth.request({ method: 'eth_signTypedData_v4', params: [from, JSON.stringify(td)] })
      .catch(function (e) {
        if (e && e.code === 4001) throw e;
        say('Your wallet could not sign that; paying the usual way instead.');
        return null;
      })
      .then(function (signature) {
        if (!signature) return paySelf(eth, from);
        say('Signed. Sending it to the chain for you…');
        return fetch('/api/purchase/' + pid + '/authorize', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: from, signature: signature }) })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            if (d.ok && d.txHash) return d.txHash;
            if (d.ok && d.purchase && d.purchase.state === 'paid') { showBought(d.purchase); throw { code: 4001, message: 'already paid' }; }
            var why = {
              insufficient_usdc: 'That wallet does not hold ' + payment.amount + ' USDC on Base.',
              expired: 'That authorization expired; reload the page and sign again.',
              wrong_sender: 'This purchase was opened for a different wallet.',
              bad_signature: 'The signature did not match; try again.',
              authorization_used: 'That authorization was already used.',
              // USDC refused the signed transfer. Paying the plain way could
              // pay twice if the authorization already went through, so stop.
              send_reverted: 'USDC refused that transfer, so nothing was sent. Reload the page to check the purchase before paying again.',
            };
            if (why[d.reason]) throw new Error(why[d.reason]);
            // relayer_dry, relayer_busy, send_failed, disabled: the store cannot pay the fee right now.
            say('The store could not cover the fee just now; paying the usual way instead.');
            return paySelf(eth, from);
          });
      });
  }
  $('pay-other').addEventListener('click', function () {
    if (pid) { $('manual').hidden = false; return; }
    say('');
    openPurchase(null).then(function () { poll(); }).catch(function (e) { say(e.message); });
  });
  $('copy-addr').addEventListener('click', function () { navigator.clipboard.writeText($('m-addr').textContent).then(function () { $('copy-addr').textContent = 'copied'; }); });
  $('claim').addEventListener('click', function () { var h = $('tx').value.trim(); if (h) claim(h); });

  // ---- load ----
  if (pid) {
    $('preview-note').hidden = false;
    poll();
  }
  fetch('/api/store/' + sku).then(function (r) { return r.json(); }).then(function (r) { if (!r.error) renderRelease(r); })
    .catch(function () { $('by').textContent = 'This record could not be loaded. Refresh to try again.'; });
})();
