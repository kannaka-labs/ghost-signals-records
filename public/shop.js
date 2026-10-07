/* The record store, in three dimensions. A long narrow shop: records face out
   on wall racks either side of the aisle, a counter and a lamp at the far end,
   Vesper behind it. Walk the aisle, pull a record down, hear it, buy it.
   Everything the shop knows comes from /api/store; buying happens on the
   record's own page. Without WebGL the same page shows a plain rack. */
import * as THREE from '/vendor/three.module.min.js';

(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const canvas = $('shop');
  const prefersReduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------------------------------------------------------------- data
  let catalog = [];
  let selling = false;

  // ---------------------------------------------------------------- audio
  const audio = $('audio'), voice = $('voice');
  const player = $('player');
  let current = null, currentRelease = null;
  const fmt = (s) => { s = Math.round(s || 0); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  function playTrack(r, t) {
    if (!t.preview) return;
    current = t; currentRelease = r;
    audio.src = t.preview; audio.volume = voice.paused ? 1 : 0.25;
    audio.play().catch(() => {});
    player.hidden = false;
    $('now-track').textContent = `${t.title} (preview)`;
    $('now-album').textContent = r.title;
    markPlaying();
  }
  function markPlaying() {
    document.querySelectorAll('#hold-tracks li').forEach((li) => {
      li.dataset.playing = current && String(li.dataset.n) === String(current.n) && !audio.paused ? 'true' : 'false';
    });
  }
  $('transport').addEventListener('click', () => {
    if (!current) { if (held) { const first = held.release.tracks.find((t) => t.preview); if (first) playTrack(held.release, first); } return; }
    if (audio.paused) audio.play(); else audio.pause();
  });
  $('player-close').addEventListener('click', () => { audio.pause(); player.hidden = true; });
  audio.addEventListener('play', () => { $('transport-glyph').innerHTML = '&#10073;&#10073;'; markPlaying(); });
  audio.addEventListener('pause', () => { $('transport-glyph').innerHTML = '&#9654;'; markPlaying(); });
  audio.addEventListener('ended', () => {
    if (!currentRelease || !current) return;
    const next = currentRelease.tracks.find((t) => t.preview && t.n > current.n);
    if (next) playTrack(currentRelease, next);
  });
  audio.addEventListener('timeupdate', () => {
    $('meter-fill').style.width = `${audio.duration ? (audio.currentTime / audio.duration) * 100 : 0}%`;
    $('clock').textContent = fmt(audio.currentTime);
  });
  $('meter').addEventListener('click', function (ev) { const r = this.getBoundingClientRect(); if (audio.duration) audio.currentTime = ((ev.clientX - r.left) / r.width) * audio.duration; });
  // Vesper talks over the music the way a clerk does: the record ducks, then comes back.
  voice.addEventListener('play', () => { audio.volume = 0.25; });
  voice.addEventListener('ended', () => { audio.volume = 1; });
  voice.addEventListener('pause', () => { audio.volume = 1; });

  // ---------------------------------------------------------------- the record in hand (DOM)
  const hold = $('hold');
  let held = null;
  function showHold(r) {
    $('hold-by').textContent = `${r.artist}${r.year ? `, ${r.year}` : ''} · ${r.tracks.length} ${r.tracks.length === 1 ? 'track' : 'tracks'}`;
    $('hold-title').textContent = r.title;
    $('hold-blurb').textContent = r.blurb || '';
    const ol = $('hold-tracks'); ol.textContent = '';
    r.tracks.forEach((t) => {
      const li = document.createElement('li'); li.dataset.n = t.n;
      const num = document.createElement('span'); num.className = 'num'; num.textContent = String(t.n).padStart(2, '0');
      const name = document.createElement(t.preview ? 'button' : 'span'); name.className = 'name'; name.textContent = t.title;
      if (t.preview) {
        name.type = 'button';
        const bars = document.createElement('span'); bars.className = 'bars'; bars.setAttribute('aria-hidden', 'true'); bars.innerHTML = '<i></i><i></i><i></i>'; name.appendChild(bars);
        name.addEventListener('click', () => playTrack(r, t));
      }
      const dur = document.createElement('span'); dur.className = 'dur'; dur.textContent = t.duration ? fmt(t.duration) : '';
      li.appendChild(num); li.appendChild(name); li.appendChild(dur); ol.appendChild(li);
    });
    $('hold-buy').href = r.url;
    $('hold-buy').textContent = selling ? `Buy this record · $${r.price} USDC` : 'Open the record';
    hold.hidden = false;
    markPlaying();
  }
  $('hold-close').addEventListener('click', () => putBack());
  $('hold-ask').addEventListener('click', () => { if (held) ask('Tell me about this one.', held.release.sku); });

  // ---------------------------------------------------------------- Vesper (DOM)
  const clerk = $('clerk'), log = $('clerk-log');
  let clerkFolded = false;
  function say(who, text, pending) {
    const p = document.createElement('p');
    p.className = who === 'you' ? 'you' : 'her';
    p.textContent = text;
    if (pending) p.dataset.pending = 'true';
    log.appendChild(p);
    while (log.children.length > 8) log.removeChild(log.firstChild);
    log.scrollTop = log.scrollHeight;
    return p;
  }
  function speak(url) {
    if (!url || !$('voice-on').checked) return;
    voice.src = url; voice.play().catch(() => {});
  }
  async function ask(text, about) {
    if (!text.trim()) return;
    say('you', text);
    const pend = say('her', '…', true);
    try {
      const r = await fetch('/api/vesper/say', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, about, voice: $('voice-on').checked }) });
      const d = await r.json();
      pend.textContent = d.reply || d.error || 'Say that again?';
      delete pend.dataset.pending;
      speak(d.audio);
    } catch { pend.textContent = 'The counter is quiet for a moment. Try again.'; delete pend.dataset.pending; }
  }
  $('clerk-form').addEventListener('submit', (ev) => { ev.preventDefault(); const i = $('clerk-input'); const t = i.value; i.value = ''; ask(t, held ? held.release.sku : undefined); });
  // The counter stays small until you lean on it: the full conversation shows
  // while the input has focus or the log is tapped, so it never hides the shelves.
  $('clerk-input').addEventListener('focus', () => clerk.classList.add('open'));
  log.addEventListener('click', () => clerk.classList.toggle('open'));
  canvas.addEventListener('pointerdown', () => clerk.classList.remove('open'));
  $('clerk-min').addEventListener('click', () => { clerkFolded = !clerkFolded; clerk.classList.toggle('folded', clerkFolded); $('clerk-min').textContent = clerkFolded ? '+' : '–'; });

  // ---------------------------------------------------------------- fallback rack
  function renderRack() {
    const rack = $('rack'); rack.textContent = '';
    catalog.forEach((r) => {
      const a = document.createElement('a'); a.className = 'record'; a.href = r.url;
      const img = document.createElement('img'); img.alt = `Cover of ${r.title}`; img.loading = 'lazy'; img.width = 400; img.height = 400; img.src = r.cover ? r.cover.replace(/cover\.(png|jpg)$/, 'cover-512.jpg') : '';
      const words = document.createElement('div'); words.className = 'record-words';
      const h = document.createElement('h2'); h.textContent = r.title;
      const by = document.createElement('p'); by.className = 'record-by'; by.textContent = `${r.artist}${r.year ? ` · ${r.year}` : ''}`;
      const n = document.createElement('p'); n.className = 'record-n'; n.textContent = `${r.tracks.length} ${r.tracks.length === 1 ? 'track' : 'tracks'} · $${r.price}`;
      words.appendChild(h); words.appendChild(by); words.appendChild(n); a.appendChild(img); a.appendChild(words); rack.appendChild(a);
    });
    $('fallback').hidden = false;
    document.body.classList.add('flat');
    $('door').hidden = true;
  }

  // ---------------------------------------------------------------- the scene
  let renderer, scene, camera, raycaster;
  const records = []; // { mesh, release, home: {pos, quat} }
  let zMin = 0, zMax = 0, camZ = 0, yaw = 0, pitch = 0, targetYaw = 0, targetPitch = 0, targetZ = 0;
  const EYE = 1.6;
  const COL = { oxide: 0x15100d, sleeve: 0x1f1815, wood: 0x3a2a1c, bone: 0xece3d4, amber: 0xe0872f, onair: 0x5ad07f };

  function plankTexture() {
    const c = document.createElement('canvas'); c.width = 512; c.height = 512;
    const g = c.getContext('2d');
    for (let x = 0; x < 512; x += 64) {
      const shade = 26 + Math.floor(Math.random() * 14);
      g.fillStyle = `rgb(${shade + 10},${shade},${Math.max(8, shade - 10)})`;
      g.fillRect(x, 0, 64, 512);
      g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(x, 0, 2, 512);
      for (let i = 0; i < 30; i++) { g.fillStyle = `rgba(255,220,180,${Math.random() * 0.05})`; g.fillRect(x + Math.random() * 60, Math.random() * 512, 1 + Math.random() * 2, 20 + Math.random() * 120); }
    }
    const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; return t;
  }
  function wallTexture() {
    const c = document.createElement('canvas'); c.width = 256; c.height = 256;
    const g = c.getContext('2d'); g.fillStyle = '#1a1310'; g.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 4000; i++) { g.fillStyle = `rgba(255,230,200,${Math.random() * 0.04})`; g.fillRect(Math.random() * 256, Math.random() * 256, 1, 1); }
    const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; return t;
  }
  function averageColor(img) {
    try {
      const c = document.createElement('canvas'); c.width = 8; c.height = 8;
      const g = c.getContext('2d'); g.drawImage(img, 0, 0, 8, 8);
      const d = g.getImageData(0, 0, 8, 8).data; let r = 0, gg = 0, b = 0;
      for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; }
      const n = d.length / 4; return new THREE.Color(r / n / 255, gg / n / 255, b / n / 255).multiplyScalar(0.6);
    } catch { return new THREE.Color(COL.sleeve); }
  }

  function build() {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.35;
    scene = new THREE.Scene();
    scene.background = new THREE.Color(COL.oxide);
    camera = new THREE.PerspectiveCamera(58, 1, 0.05, 80);
    raycaster = new THREE.Raycaster();

    // The shop is as long as its stock: two racks per wall, columns every 1.3 m.
    const perWall = Math.ceil(catalog.length / 2);
    const cols = Math.max(4, Math.ceil(perWall / 2));
    const STEP = 1.3;
    const L = cols * STEP + 9;
    const W = 4.6;
    zMax = L / 2 - 1.2;      // the door
    zMin = -L / 2 + 4.0;     // just before the counter
    camZ = targetZ = zMax;
    scene.fog = new THREE.Fog(COL.oxide, 6, L + 6);

    const floorT = plankTexture(); floorT.repeat.set(W / 2, L / 2);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, L), new THREE.MeshStandardMaterial({ map: floorT, roughness: 0.85, metalness: 0.05 }));
    floor.rotation.x = -Math.PI / 2; scene.add(floor);
    const wallT = wallTexture(); wallT.repeat.set(L / 2, 2);
    const wallMat = new THREE.MeshStandardMaterial({ map: wallT, roughness: 0.95 });
    const H = 3.4;
    const left = new THREE.Mesh(new THREE.PlaneGeometry(L, H), wallMat); left.position.set(-W / 2, H / 2, 0); left.rotation.y = Math.PI / 2; scene.add(left);
    const right = new THREE.Mesh(new THREE.PlaneGeometry(L, H), wallMat); right.position.set(W / 2, H / 2, 0); right.rotation.y = -Math.PI / 2; scene.add(right);
    const back = new THREE.Mesh(new THREE.PlaneGeometry(W, H), wallMat); back.position.set(0, H / 2, -L / 2); scene.add(back);
    const front = new THREE.Mesh(new THREE.PlaneGeometry(W, H), wallMat); front.position.set(0, H / 2, L / 2); front.rotation.y = Math.PI; scene.add(front);
    const ceil = new THREE.Mesh(new THREE.PlaneGeometry(W, L), new THREE.MeshStandardMaterial({ color: 0x0d0a08, roughness: 1 })); ceil.position.y = H; ceil.rotation.x = Math.PI / 2; scene.add(ceil);

    // Light: a dim warm wash, and a lamp hung every few metres down the aisle.
    scene.add(new THREE.HemisphereLight(0x8a7260, 0x1a1410, 1.0));
    scene.add(new THREE.AmbientLight(0x4a3c32, 0.6));
    const lampMat = new THREE.MeshStandardMaterial({ color: 0xffd9a0, emissive: 0xffc070, emissiveIntensity: 2.2 });
    const shadeMat = new THREE.MeshStandardMaterial({ color: 0x241a12, roughness: 0.6, metalness: 0.4, side: THREE.DoubleSide });
    for (let z = zMax - 2.5; z > -L / 2 + 2; z -= 4.2) {
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 10), lampMat); bulb.position.set(0, 2.55, z); scene.add(bulb);
      const shade = new THREE.Mesh(new THREE.ConeGeometry(0.32, 0.22, 24, 1, true), shadeMat); shade.position.set(0, 2.68, z); scene.add(shade);
      const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, H - 2.75, 6), shadeMat); cord.position.set(0, (H + 2.78) / 2, z); scene.add(cord);
      const light = new THREE.PointLight(0xffc98a, 28, 10, 2); light.position.set(0, 2.5, z); scene.add(light);
    }

    // The racks: a wooden rail under each row; records lean back on it, face out.
    const railMat = new THREE.MeshStandardMaterial({ color: COL.wood, roughness: 0.8 });
    const rows = [1.05, 2.15];
    const loader = new THREE.TextureLoader();
    const sorted = catalog.slice();
    sorted.forEach((r, i) => {
      const wall = i % 2 === 0 ? -1 : 1;              // alternate walls, so both sides fill evenly
      const k = Math.floor(i / 2);
      const row = k % 2; const col = Math.floor(k / 2);
      const z = zMax - 3.6 - col * STEP;
      const y = rows[row];
      const x = wall * (W / 2 - 0.26);
      const geo = new THREE.BoxGeometry(1, 1, 0.035);
      const side = new THREE.MeshStandardMaterial({ color: COL.sleeve, roughness: 0.75 });
      const faceMat = new THREE.MeshStandardMaterial({ color: 0x4a3b30, roughness: 0.55 });
      const mats = [side, side, side, side, faceMat, side]; // +z face is index 4
      const mesh = new THREE.Mesh(geo, mats);
      mesh.position.set(x, y, z);
      mesh.rotation.y = wall === -1 ? Math.PI / 2 : -Math.PI / 2; // face the aisle
      mesh.rotation.x = -0.12;                                      // lean back on the rail
      mesh.userData.release = r;
      scene.add(mesh);
      records.push({ mesh, release: r, home: { pos: mesh.position.clone(), quat: mesh.quaternion.clone() } });
      const thumb = r.cover ? r.cover.replace(/cover\.(png|jpg)$/, 'cover-512.jpg') : null;
      if (thumb) {
        loader.load(thumb, (tex) => {
          tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
          faceMat.map = tex; faceMat.color.set(0xffffff); faceMat.needsUpdate = true;
          if (tex.image) { const c = averageColor(tex.image); side.color.copy(c); }
        });
      }
    });
    for (const wall of [-1, 1]) for (const y of rows) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.04, cols * STEP + 0.6), railMat);
      rail.position.set(wall * (W / 2 - 0.2), y - 0.52, zMax - 3.6 - ((cols - 1) * STEP) / 2); scene.add(rail);
      const lip = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.1, cols * STEP + 0.6), railMat);
      lip.position.set(wall * (W / 2 - 0.3), y - 0.47, rail.position.z); scene.add(lip);
    }

    // The counter, the lamp over it, the on-air lamp on it, and Vesper behind it.
    const counterZ = -L / 2 + 1.6;
    const counter = new THREE.Mesh(new THREE.BoxGeometry(2.6, 1.05, 0.7), new THREE.MeshStandardMaterial({ color: 0x2a1d15, roughness: 0.7 }));
    counter.position.set(0, 0.525, counterZ); scene.add(counter);
    const top = new THREE.Mesh(new THREE.BoxGeometry(2.7, 0.05, 0.8), railMat); top.position.set(0, 1.075, counterZ); scene.add(top);
    const lampBulb = new THREE.Mesh(new THREE.SphereGeometry(0.09, 12, 10), lampMat); lampBulb.position.set(0, 2.35, counterZ); scene.add(lampBulb);
    const lampShade = new THREE.Mesh(new THREE.ConeGeometry(0.5, 0.3, 24, 1, true), shadeMat); lampShade.position.set(0, 2.52, counterZ); scene.add(lampShade);
    const counterLight = new THREE.PointLight(0xffc27a, 34, 9, 2); counterLight.position.set(0, 2.3, counterZ + 0.2); scene.add(counterLight);
    const onair = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 8), new THREE.MeshStandardMaterial({ color: COL.onair, emissive: COL.onair, emissiveIntensity: 1.6 }));
    onair.position.set(0.95, 1.15, counterZ + 0.15); scene.add(onair);
    const onairLight = new THREE.PointLight(COL.onair, 1.2, 1.6, 2); onairLight.position.copy(onair.position); scene.add(onairLight);
    // Vesper: a figure by the house rule, all silhouette, no face. A long
    // coat, a hood, hands resting on the counter; the amber from behind
    // draws her edge.
    // She is a silhouette by the house rule: unlit black, so no lamp can give
    // her a face or a colour; the amber behind her draws the edge.
    const dark = new THREE.MeshBasicMaterial({ color: 0x07050a });
    const vz = counterZ - 0.85;
    const coat = new THREE.Mesh(new THREE.ConeGeometry(0.44, 1.75, 32), dark); coat.position.set(0, 0.875, vz); scene.add(coat);
    const shoulders = new THREE.Mesh(new THREE.SphereGeometry(0.26, 20, 14), dark); shoulders.scale.set(1.15, 0.45, 0.7); shoulders.position.set(0, 1.64, vz); scene.add(shoulders);
    const chest = new THREE.Mesh(new THREE.CapsuleGeometry(0.16, 0.36, 6, 16), dark); chest.position.set(0, 1.46, vz); scene.add(chest);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.125, 20, 16), dark); head.position.set(0, 1.93, vz); scene.add(head);
    const hood = new THREE.Mesh(new THREE.SphereGeometry(0.19, 20, 16), dark); hood.scale.set(1, 1.15, 1.05); hood.position.set(0, 1.97, vz - 0.04); scene.add(hood);
    for (const sx of [-0.3, 0.3]) { const hand = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 8), dark); hand.position.set(sx, 1.11, counterZ - 0.15); scene.add(hand); }
    const rim = new THREE.PointLight(0xe0872f, 14, 4.5, 2); rim.position.set(0, 2.0, vz - 0.9); scene.add(rim);
    const rimGlow = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8), new THREE.MeshStandardMaterial({ color: 0xe0872f, emissive: 0xe0872f, emissiveIntensity: 1.8 })); rimGlow.position.set(0, 2.0, vz - 0.9); scene.add(rimGlow);
    scene.userData.vesper = { head, chest, hood, shoulders };

    // A record spinning on the counter, for company.
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.01, 48), new THREE.MeshStandardMaterial({ color: 0x090807, roughness: 0.35, metalness: 0.2 }));
    disc.position.set(-0.8, 1.11, counterZ + 0.05); scene.add(disc);
    scene.userData.disc = disc;

    resize();
    window.addEventListener('resize', resize);
  }

  function resize() {
    if (!renderer) return;
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // A phone held upright sees a narrow slice of the aisle; open the view so
    // the racks either side stay in frame.
    camera.fov = camera.aspect < 0.8 ? 80 : camera.aspect < 1.2 ? 68 : 58;
    camera.updateProjectionMatrix();
  }

  // ---------------------------------------------------------------- picking up and putting back
  const tmpV = new THREE.Vector3(), tmpQ = new THREE.Quaternion(), fwd = new THREE.Vector3();
  function pickUp(rec) {
    if (held && held !== rec) putBack(false);
    held = rec;
    showHold(rec.release);
    hint(`${rec.release.title}. Tap a track to hear it.`);
  }
  function putBack(clearDom = true) {
    if (!held) return;
    held = null;
    if (clearDom) hold.hidden = true;
  }
  function animateHeld(dt) {
    for (const rec of records) {
      const m = rec.mesh;
      if (rec === held) {
        camera.getWorldDirection(fwd);
        tmpV.copy(camera.position).addScaledVector(fwd, 1.25);
        tmpV.y -= camera.aspect < 0.8 ? -0.22 : 0.12; // on a phone the sheet covers the bottom: hold it higher
        // A little drift, the way a hand holds a sleeve.
        tmpV.y += Math.sin(performance.now() / 900) * 0.01;
        m.position.lerp(tmpV, 1 - Math.exp(-dt * 7));
        tmpQ.copy(camera.quaternion);
        m.quaternion.slerp(tmpQ, 1 - Math.exp(-dt * 7));
        m.scale.lerp(new THREE.Vector3(1.15, 1.15, 1.15), 1 - Math.exp(-dt * 7));
      } else {
        m.position.lerp(rec.home.pos, 1 - Math.exp(-dt * 6));
        m.quaternion.slerp(rec.home.quat, 1 - Math.exp(-dt * 6));
        m.scale.lerp(new THREE.Vector3(1, 1, 1), 1 - Math.exp(-dt * 6));
      }
    }
  }

  // ---------------------------------------------------------------- walking and looking
  let dragging = false, moved = 0, lastX = 0, lastY = 0, lastTap = 0;
  const pointer = new THREE.Vector2();
  function onDown(ev) {
    if (ev.target !== canvas) return;
    dragging = true; moved = 0; lastX = ev.clientX; lastY = ev.clientY;
    canvas.setPointerCapture && canvas.setPointerCapture(ev.pointerId);
  }
  function onMove(ev) {
    if (!dragging) return;
    const dx = ev.clientX - lastX, dy = ev.clientY - lastY;
    lastX = ev.clientX; lastY = ev.clientY; moved += Math.abs(dx) + Math.abs(dy);
    if (ev.pointerType === 'touch') {
      // On a phone: side to side looks, up and down walks.
      targetYaw -= dx * 0.004;
      targetZ += dy * 0.012;
    } else {
      targetYaw -= dx * 0.0035;
      targetPitch = Math.max(-0.45, Math.min(0.35, targetPitch + dy * 0.0025));
    }
    targetYaw = Math.max(-1.25, Math.min(1.25, targetYaw));
    targetZ = Math.max(zMin, Math.min(zMax, targetZ));
  }
  function onUp(ev) {
    if (!dragging) return;
    dragging = false;
    if (moved > 8) return;
    // A tap: pick what is under it.
    pointer.x = (ev.clientX / window.innerWidth) * 2 - 1;
    pointer.y = -(ev.clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(records.map((r) => r.mesh), false);
    if (hits.length) {
      const rec = records.find((r) => r.mesh === hits[0].object);
      if (rec === held) {
        // A second tap on the record you hold plays it.
        const first = rec.release.tracks.find((t) => t.preview); if (first) playTrack(rec.release, first);
      } else pickUp(rec);
      // Walk a step toward it so it is comfortable to read.
      targetZ = Math.max(zMin, Math.min(zMax, rec.home.pos.z + 1.6));
      return;
    }
    const now = performance.now();
    if (now - lastTap < 350) { targetZ = Math.max(zMin, targetZ - 2.2); } // a double tap steps forward
    lastTap = now;
    if (held) putBack();
  }
  canvas.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', () => { dragging = false; });
  canvas.addEventListener('wheel', (ev) => { ev.preventDefault(); targetZ = Math.max(zMin, Math.min(zMax, targetZ + ev.deltaY * 0.0045)); }, { passive: false });
  window.addEventListener('keydown', (ev) => {
    if (ev.target && /^(INPUT|TEXTAREA)$/.test(ev.target.tagName)) return;
    if (ev.key === 'ArrowUp' || ev.key === 'w') targetZ = Math.max(zMin, targetZ - 0.8);
    if (ev.key === 'ArrowDown' || ev.key === 's') targetZ = Math.min(zMax, targetZ + 0.8);
    if (ev.key === 'ArrowLeft' || ev.key === 'a') targetYaw = Math.min(1.25, targetYaw + 0.25);
    if (ev.key === 'ArrowRight' || ev.key === 'd') targetYaw = Math.max(-1.25, targetYaw - 0.25);
    if (ev.key === 'Escape') putBack();
  });

  let hintTimer = null;
  function hint(text) { const h = $('hint'); h.textContent = text; h.classList.add('show'); clearTimeout(hintTimer); hintTimer = setTimeout(() => h.classList.remove('show'), 4500); }

  // ---------------------------------------------------------------- the frame
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    const k = 1 - Math.exp(-dt * 5);
    camZ += (targetZ - camZ) * k;
    yaw += (targetYaw - yaw) * k;
    pitch += (targetPitch - pitch) * k;
    const bob = prefersReduced ? 0 : Math.sin(now / 1400) * 0.008;
    camera.position.set(0, EYE + bob, camZ);
    camera.rotation.set(pitch, yaw, 0, 'YXZ');
    animateHeld(dt);
    const v = scene.userData.vesper;
    if (v && !prefersReduced) {
      const breathe = Math.sin(now / 2600) * 0.01; const turn = Math.sin(now / 5200) * 0.12;
      v.chest.position.y = 1.45 + breathe; v.shoulders.position.y = 1.62 + breathe; v.head.position.y = 1.93 + breathe; v.hood.position.y = 2.0 + breathe;
      v.head.rotation.y = turn; v.hood.rotation.y = turn;
    }
    if (scene.userData.disc && !audio.paused) scene.userData.disc.rotation.y += dt * 3.5;
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }

  // ---------------------------------------------------------------- start
  function unlockAudio() {
    // One silent play on the user's gesture, so later voice and previews are allowed.
    const silent = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';
    for (const el of [audio, voice]) { try { el.src = silent; el.play().catch(() => {}); } catch { /* fine */ } }
  }
  async function enter() {
    $('door').classList.add('open');
    setTimeout(() => { $('door').hidden = true; }, 700);
    clerk.hidden = false;
    unlockAudio();
    hint('Scroll or drag to walk the aisle. Tap a record to take it down.');
    try {
      const d = await (await fetch('/api/vesper/greeting')).json();
      say('her', d.reply);
      if (d.audio) setTimeout(() => speak(d.audio), 250);
    } catch { say('her', `Welcome in. Pull a record down to hear it.`); }
  }

  async function main() {
    let d;
    try { d = await (await fetch('/api/store')).json(); } catch { d = { releases: [] }; }
    catalog = d.releases || []; selling = Boolean(d.selling);
    if (!catalog.length) { $('door-progress').textContent = 'Nothing on the shelves yet.'; return; }
    let webgl = false;
    try { const c = document.createElement('canvas'); webgl = Boolean(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl'))); } catch { webgl = false; }
    if (!webgl) { renderRack(); return; }
    try { build(); } catch (e) { console.error(e); renderRack(); return; }
    // Let the covers arrive before opening the door, so the shelves are full when you walk in.
    const thumbs = catalog.filter((r) => r.cover).length;
    let loaded = 0;
    const progress = () => { $('door-progress').textContent = `Stocking the shelves… ${loaded}/${thumbs}`; };
    progress();
    await Promise.all(catalog.filter((r) => r.cover).map((r) => new Promise((resolve) => {
      const img = new Image(); img.onload = img.onerror = () => { loaded++; progress(); resolve(); };
      img.src = r.cover.replace(/cover\.(png|jpg)$/, 'cover-512.jpg');
    })));
    $('door-progress').textContent = `${catalog.length} records on the shelves.`;
    $('enter').disabled = false;
    $('enter').addEventListener('click', enter, { once: true });
    requestAnimationFrame(frame);
    // Deep links and screenshots: ?open walks straight in (no sound until a
    // tap), ?pick=<sku> takes that record down, ?at=<0..1> stands somewhere along the aisle.
    const q = new URLSearchParams(location.search);
    if (q.has('open')) {
      $('door').hidden = true; clerk.hidden = false;
      const rec = q.get('pick') && records.find((r) => r.release.sku === q.get('pick'));
      if (q.has('at')) { const t = Math.max(0, Math.min(1, parseFloat(q.get('at')) || 0)); camZ = targetZ = zMax - (zMax - zMin) * t; }
      if (rec) { pickUp(rec); camZ = targetZ = Math.max(zMin, Math.min(zMax, rec.home.pos.z + 1.6)); targetYaw = yaw = rec.home.pos.x < 0 ? 0.55 : -0.55; }
      say('her', vesperGreetingFallback());
    }
  }
  function vesperGreetingFallback() { return 'Welcome in. Pull a record down to hear it, and ask me anything about what\'s here.'; }
  main();
})();
