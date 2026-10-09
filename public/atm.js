/* The USDC ATM: an address, an amount, and a Coinbase Onramp session minted for it. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var BASE_HEX = '0x2105';
  var cfg = null, amount = 20;
  function say(t) { $('said').textContent = t; }
  function isAddr(a) { return /^0x[0-9a-fA-F]{40}$/.test(a); }

  function renderAmounts() {
    var box = $('amounts'); box.textContent = '';
    cfg.onramp.amounts.forEach(function (a) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'btn ghost small amount' + (a === amount ? ' on' : ''); b.textContent = '$' + a;
      b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', a === amount ? 'true' : 'false');
      b.addEventListener('click', function () { amount = a; renderAmounts(); });
      box.appendChild(b);
    });
  }

  function render() {
    renderAmounts();
    $('fee-line').textContent = cfg.onramp.fee;
    if (!cfg.onramp.ready) {
      $('atm-note').hidden = false;
      $('atm-note').textContent = 'The card and bank leg is not open yet. Until it is: buy USDC on any exchange and withdraw it on the Base network to your address, or hold ETH on Base and use the swap desk when it opens.';
      $('go').disabled = true;
    }
    $('swap-fee').textContent = cfg.swap.note;
    var sel = $('sell-token'); sel.textContent = '';
    (cfg.swap.tokens || []).forEach(function (t) { var o = document.createElement('option'); o.value = t.key; o.textContent = t.label; sel.appendChild(o); });
    if (!cfg.swap.ready) {
      $('swap-note').textContent = 'The swap desk is not open yet. It will take ETH or any token on Base and hand back USDC, with the ATM keeping a small cut of each swap.';
      $('quote').disabled = true;
    }
  }

  // ---- the swap desk ----
  var swapAccount = null, firmQuote = null;
  function swapSay(t) { $('swap-said').textContent = t; }
  function connectWallet() {
    var eth = window.ethereum;
    if (!eth) return Promise.reject(new Error('No wallet found in this browser.'));
    return eth.request({ method: 'eth_requestAccounts' }).then(function (accts) {
      swapAccount = accts[0];
      return eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: BASE_HEX }] }).catch(function (e) {
        if (e && e.code === 4902) return eth.request({ method: 'wallet_addEthereumChain', params: [{ chainId: BASE_HEX, chainName: 'Base', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://mainnet.base.org'], blockExplorerUrls: ['https://basescan.org'] }] });
        throw e;
      });
    }).then(function () { return swapAccount; });
  }
  function showQuote(q) {
    $('q-buy').textContent = q.buy.amount; $('q-min').textContent = q.buy.minAmount;
    $('q-fee').textContent = q.fee.amount || '0'; $('q-bps').textContent = (q.fee.bps / 100) + '%';
    $('swap-quote').hidden = false;
  }
  $('quote').addEventListener('click', function () {
    firmQuote = null; $('swap-quote').hidden = true;
    var tok = $('sell-token').value, amt = $('sell-amount').value.trim();
    if (!/^\d+(\.\d+)?$/.test(amt) || Number(amt) <= 0) { swapSay('Enter an amount, like 0.01.'); return; }
    swapSay('Asking for a price…');
    fetch('/api/atm/swap?sellToken=' + encodeURIComponent(tok) + '&sellAmount=' + encodeURIComponent(amt) + (swapAccount ? '&taker=' + swapAccount : ''))
      .then(function (r) { return r.json(); })
      .then(function (q) {
        if (!q.ok) { swapSay({ no_liquidity: 'No route for that amount right now.', bad_amount: 'That amount could not be read.', swap_not_configured: 'The swap desk is not open yet.' }[q.reason] || 'No price came back.'); return; }
        showQuote(q); swapSay('Indicative price. The wallet quote is firm for about a minute.');
      }).catch(function () { swapSay('The desk could not be reached.'); });
  });
  $('swap-go').addEventListener('click', function () {
    var tok = $('sell-token').value, amt = $('sell-amount').value.trim();
    var eth = window.ethereum;
    swapSay('Opening your wallet…');
    connectWallet().then(function (from) {
      return fetch('/api/atm/swap', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sellToken: tok, sellAmount: amt, taker: from }) })
        .then(function (r) { return r.json(); })
        .then(function (q) {
          if (!q.ok) throw new Error({ no_liquidity: 'No route for that amount right now.', bad_taker: 'The wallet address did not come through.' }[q.reason] || 'The firm quote failed.');
          if (q.balanceShort) throw new Error('That wallet does not hold ' + q.sell.amount + ' ' + q.sell.token + ' on Base.');
          firmQuote = q; showQuote(q);
          // An ERC-20 sell needs a one-time approval of 0x's allowance holder; ETH does not.
          if (q.allowance && BigInt(q.allowance.actual) < BigInt(q.allowance.needed)) {
            swapSay('First, approve ' + q.sell.token + ' for the swap in your wallet…');
            var amount64 = BigInt(q.allowance.needed).toString(16).padStart(64, '0');
            var data = '0x095ea7b3' + q.allowance.spender.slice(2).toLowerCase().padStart(64, '0') + amount64;
            return eth.request({ method: 'eth_sendTransaction', params: [{ from: from, to: q.allowance.token, data: data, value: '0x0' }] })
              .then(function () { swapSay('Approved. Now confirm the swap…'); return q; });
          }
          swapSay('Confirm the swap in your wallet…');
          return q;
        })
        .then(function (q) {
          var tx = { from: from, to: q.transaction.to, data: q.transaction.data, value: q.transaction.value };
          if (q.transaction.gas) tx.gas = q.transaction.gas;
          return eth.request({ method: 'eth_sendTransaction', params: [tx] });
        })
        .then(function (hash) { swapSay('Sent. The USDC lands in your wallet when the chain confirms it. Transaction ' + hash.slice(0, 12) + '… (basescan.org/tx/' + hash + ')'); });
    }).catch(function (e) { swapSay(e && e.code === 4001 ? 'Cancelled in the wallet.' : (e && e.message) || 'The swap did not complete.'); });
  });

  $('connect').addEventListener('click', function () {
    var eth = window.ethereum;
    if (!eth) { say('No wallet found in this browser. Paste your address instead.'); return; }
    eth.request({ method: 'eth_requestAccounts' }).then(function (accts) {
      $('addr').value = accts[0];
      return eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: BASE_HEX }] }).catch(function () {});
    }).then(function () { say('That is the address the USDC will go to.'); })
      .catch(function (e) { say(e && e.code === 4001 ? 'Cancelled in the wallet.' : 'The wallet did not answer.'); });
  });

  $('go').addEventListener('click', function () {
    var addr = $('addr').value.trim();
    if (!isAddr(addr)) { say('That is not a wallet address. It starts with 0x and is 42 characters long.'); return; }
    say('Opening a session with Coinbase…');
    $('go').disabled = true;
    fetch('/api/atm/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: addr, amount: amount, currency: cfg.onramp.currency }) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        $('go').disabled = !cfg.onramp.ready;
        if (!d.ok) {
          var words = {
            onramp_not_configured: 'The card and bank leg is not open yet.',
            onramp_rejected_key: 'Coinbase refused our key; the operator has been told.',
            onramp_unreachable: 'Coinbase could not be reached. Try again in a moment.',
            bad_address: 'That is not a wallet address.',
          };
          say(words[d.reason] || 'The session could not be opened.');
          return;
        }
        say('Coinbase is open in a new tab for $' + d.amount + ' of USDC to ' + d.address.slice(0, 8) + '…. The session lasts five minutes.');
        var w = window.open(d.url, '_blank', 'noopener');
        if (!w) { var a = document.createElement('a'); a.href = d.url; a.textContent = 'Open Coinbase'; a.target = '_blank'; a.rel = 'noopener'; $('said').appendChild(document.createTextNode(' ')); $('said').appendChild(a); }
      })
      .catch(function () { $('go').disabled = false; say('The ATM could not be reached. Try again in a moment.'); });
  });

  fetch('/api/atm').then(function (r) { return r.json(); }).then(function (c) { cfg = c; render(); })
    .catch(function () { $('atm-note').hidden = false; $('atm-note').textContent = 'The ATM could not be loaded. Refresh to try again.'; });
})();
