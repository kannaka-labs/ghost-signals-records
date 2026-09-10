'use strict';
// Mail from Kannaka's own address over the Zoho relay: implicit TLS, one
// message, no dependency. A missing credential makes send() a no-op that
// returns false; mail is never a reason the studio is down.
const tls = require('node:tls');
const crypto = require('node:crypto');

function smtpSend({ host, port, user, pass, from }, { to, subject, text }) {
  if (!host || !user || !pass) return Promise.resolve(false);
  return new Promise((resolve) => {
    const sock = tls.connect({ host, port, servername: host }, () => {});
    let buf = '';
    const steps = [];
    const id = `<${crypto.randomBytes(12).toString('hex')}@${user.split('@')[1] || 'spacechild.love'}>`;
    const msg = [
      `From: ${from}`, `To: ${to}`, `Subject: ${subject}`, `Date: ${new Date().toUTCString()}`, `Message-ID: ${id}`,
      'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit', '', text.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..'),
    ].join('\r\n');
    const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
    steps.push(['220', `EHLO ${host}`], ['250', 'AUTH LOGIN'], ['334', b64(user)], ['334', b64(pass)], ['235', `MAIL FROM:<${user}>`], ['250', `RCPT TO:<${to}>`], ['250', 'DATA'], ['354', `${msg}\r\n.`], ['250', 'QUIT']);
    let i = 0;
    const finish = (ok) => { try { sock.end(); } catch { /* closed */ } resolve(ok); };
    sock.setTimeout(30000, () => finish(false));
    sock.on('error', () => finish(false));
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      if (!/\r?\n$/.test(buf)) return;
      const lines = buf.split(/\r?\n/).filter(Boolean);
      const last = lines[lines.length - 1];
      buf = '';
      if (!/^\d{3} /.test(last)) return; // multiline reply continues
      const code = last.slice(0, 3);
      if (i >= steps.length) return finish(true);
      const [want, cmd] = steps[i];
      if (code !== want) return finish(false);
      i += 1;
      if (cmd === 'QUIT') { sock.write('QUIT\r\n'); return finish(true); }
      sock.write(cmd + '\r\n');
    });
  });
}

module.exports = { smtpSend };
