// Своя игра — сервер. Вся логика игры живёт здесь, клиенты только показывают состояние.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const PORT = Number(process.env.PORT) || 3000;
const ONLINE = process.argv.includes('--online');
const MAX_PLAYERS = 4;
const FINAL_SECONDS = 60;
const PUBLIC_DIR = path.join(__dirname, 'public');
const PACKS_DIR = path.join(__dirname, 'packs');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
  '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
};

// ---------- паки ----------

function listPacks() {
  return fs.readdirSync(PACKS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && fs.existsSync(path.join(PACKS_DIR, d.name, 'pack.json')))
    .map(d => {
      try {
        const p = JSON.parse(fs.readFileSync(path.join(PACKS_DIR, d.name, 'pack.json'), 'utf8'));
        return { id: d.name, title: p.title || d.name };
      } catch (e) {
        return { id: d.name, title: `${d.name} (ошибка в pack.json: ${e.message})`, broken: true };
      }
    });
}

function loadPack(id) {
  const raw = JSON.parse(fs.readFileSync(path.join(PACKS_DIR, id, 'pack.json'), 'utf8'));
  // пути к медиа делаем абсолютными, чтобы клиенту не думать
  const media = v => (v && !/^https?:\/\//.test(v) ? `/packs/${id}/${v}` : v);
  const fixQ = q => ({
    type: 'normal', ...q,
    image: media(q.image), audio: media(q.audio), video: media(q.video),
    answerImage: media(q.answerImage), answerAudio: media(q.answerAudio), answerVideo: media(q.answerVideo),
  });
  raw.rounds = (raw.rounds || []).map(r => ({ ...r, themes: r.themes.map(t => ({ ...t, questions: t.questions.map(fixQ) })) }));
  if (raw.final) raw.final.themes = raw.final.themes.map(t => ({ ...t, question: fixQ(t.question) }));
  if (raw.finale) raw.finale.image = media(raw.finale.image);
  if (raw.finale) raw.finale.audio = media(raw.finale.audio);
  return raw;
}

// ---------- состояние ----------

const packs = listPacks();
const defaultPack = (packs.find(p => p.id === 'birthday' && !p.broken) || packs.find(p => !p.broken) || {}).id;

const S = {
  packId: defaultPack,
  pack: defaultPack ? loadPack(defaultPack) : null,
  hostToken: null,
  phase: 'lobby', // lobby | board | question | final | end
  players: [],    // {id, token, name, score}
  roundIndex: 0,
  used: {},       // "r:t:i" -> true
  chooser: null,
  q: null,
  final: null,
  mediaOnPhones: ONLINE, // играть музыку/видео прямо на телефонах (нужно, когда игроки не в одной комнате)
};

const uid = () => crypto.randomBytes(8).toString('hex');

// Ключ ведущего: без него страницу ведущего можно открыть только с этого компьютера
const KEY_FILE = path.join(__dirname, '.host-key');
// На хостинге задаётся переменной окружения HOST_KEY — тогда ключ нужен всегда.
const KEY_FROM_ENV = !!process.env.HOST_KEY;
const HOST_KEY = process.env.HOST_KEY
  || (fs.existsSync(KEY_FILE) ? fs.readFileSync(KEY_FILE, 'utf8').trim() : crypto.randomBytes(4).toString('hex'));
if (!KEY_FROM_ENV) { try { fs.writeFileSync(KEY_FILE, HOST_KEY); } catch {} }
let publicUrl = null; // https://….trycloudflare.com, когда поднят туннель
const player = id => S.players.find(p => p.id === id);
const round = () => S.pack?.rounds?.[S.roundIndex];

function roundLeft() {
  const r = round();
  if (!r) return 0;
  let n = 0;
  r.themes.forEach((t, ti) => t.questions.forEach((_, qi) => { if (!S.used[`${S.roundIndex}:${ti}:${qi}`]) n++; }));
  return n;
}

// ---------- что видит каждая роль ----------

function view(role, playerId) {
  const host = role === 'host';
  const v = {
    role, you: playerId || null, phase: S.phase, maxPlayers: MAX_PLAYERS, mediaOnPhones: S.mediaOnPhones,
    packs: host ? listPacks() : undefined, packId: S.packId,
    pack: S.pack ? { title: S.pack.title, subtitle: S.pack.subtitle, roundsCount: S.pack.rounds.length, hasFinal: !!S.pack.final } : null,
    players: S.players.map(p => ({ id: p.id, name: p.name, score: p.score, online: isOnline(p.id) })),
    chooser: S.chooser, roundIndex: S.roundIndex, roundLeft: roundLeft(),
  };

  const r = round();
  if (r && (S.phase === 'board' || S.phase === 'question')) {
    v.round = {
      name: r.name,
      themes: r.themes.map((t, ti) => ({
        name: t.name,
        cells: t.questions.map((q, qi) => ({ price: q.price, used: !!S.used[`${S.roundIndex}:${ti}:${qi}`] })),
      })),
    };
  }

  if (S.q) {
    const q = S.q;
    const showAnswer = host || q.stage === 'reveal';
    const hideQuestion = !host && (q.stage === 'cat-pick' || q.stage === 'stake-bet');
    v.q = {
      t: q.t, i: q.i, theme: q.theme, price: q.price, type: q.type, stage: q.stage, value: q.value,
      catTheme: q.catTheme, target: q.target, answering: q.answering, tried: q.tried, buzzOpenedAt: q.buzzOpenedAt,
      text: hideQuestion ? null : q.text,
      image: hideQuestion ? null : q.image, audio: hideQuestion ? null : q.audio, video: hideQuestion ? null : q.video,
      answer: showAnswer ? q.answer : null,
      answerImage: showAnswer ? q.answerImage : null, answerAudio: showAnswer ? q.answerAudio : null, answerVideo: showAnswer ? q.answerVideo : null,
      comment: showAnswer ? q.comment : null,
      stakeMin: q.stakeMin, stakeMax: q.stakeMax,
    };
  }

  if (S.final) {
    const f = S.final;
    const showQ = host || f.stage === 'question' || f.stage === 'reveal';
    const fq = f.chosen != null ? S.pack.final.themes[f.chosen].question : null;
    v.final = {
      stage: f.stage, removed: f.removed, chosen: f.chosen, participants: f.participants, deadline: f.deadline,
      themes: S.pack.final.themes.map(t => t.name),
      question: fq && showQ ? { text: fq.text, image: fq.image, audio: fq.audio, video: fq.video } : null,
      answer: fq && (host || f.stage === 'reveal' && f.participants.every(id => f.judged[id] != null)) ? fq.answer : null,
      answerImage: fq && host ? fq.answerImage : null,
      betDone: Object.fromEntries(f.participants.map(id => [id, f.bets[id] != null])),
      answerDone: Object.fromEntries(f.participants.map(id => [id, f.answers[id] != null])),
      bets: {}, answers: {}, judged: f.judged, opened: f.opened,
    };
    for (const id of f.participants) {
      const mine = id === playerId;
      if (host || mine || f.opened[id]) {
        v.final.bets[id] = f.bets[id] ?? null;
        v.final.answers[id] = f.answers[id] ?? null;
      }
    }
  }

  if (S.phase === 'end' && S.pack?.finale) v.finale = S.pack.finale;
  return v;
}

// ---------- сеть ----------

function serveStatic(req, res) {
  let url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/') url = '/index.html';
  if (['/host', '/screen', '/play'].includes(url)) url += '.html';
  const base = url.startsWith('/packs/') ? __dirname : PUBLIC_DIR;
  const file = path.normalize(path.join(base, url));
  if (!file.startsWith(base)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('Not found'); }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    // Range нужен Safari для аудио/видео
    const range = req.headers.range;
    if (range && /^(audio|video)/.test(type)) {
      const [s, e] = range.replace('bytes=', '').split('-');
      const start = Number(s), end = e ? Number(e) : st.size - 1;
      res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  });
}

// Подключение «с этого компьютера»: локальный адрес и без заголовков прокси/туннеля
function isLocal(socket) {
  if (KEY_FROM_ENV) return false;
  const h = socket.handshake;
  const addr = h.address || '';
  const proxied = h.headers['cf-connecting-ip'] || h.headers['x-forwarded-for'] || h.headers['cf-ray'];
  return !proxied && (addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1');
}

function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254')) return a.address;
  }
  return 'localhost';
}

const server = http.createServer(async (req, res) => {
  if (req.url.startsWith('/api/join-info')) {
    const lan = `http://${lanAddress()}:${PORT}/play`;
    // на хостинге берём адрес сайта из запроса; дома (localhost) — IP в локальной сети
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
    const siteUrl = process.env.PUBLIC_URL
      || (host && !/^(localhost|127\.|\[::1\]|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) ? `${proto}://${host}` : null);
    const url = publicUrl ? `${publicUrl}/play` : siteUrl ? `${siteUrl.replace(/\/$/, '')}/play` : lan;
    const qr = await QRCode.toDataURL(url, { margin: 1, width: 360, color: { dark: '#1b1340', light: '#ffffff' } });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ url, lan, qr, online: ONLINE || !!siteUrl, ready: !ONLINE || !!publicUrl }));
  }
  serveStatic(req, res);
});

const io = new Server(server);

function isOnline(playerId) {
  for (const s of io.sockets.sockets.values()) if (s.data.playerId === playerId) return true;
  return false;
}

function broadcast(event) {
  for (const s of io.sockets.sockets.values()) {
    if (!s.data.role) continue;
    s.emit('state', view(s.data.role, s.data.playerId));
    if (event) s.emit('fx', event);
  }
}

function toast(socket, text) { socket.emit('toast', text); }

// ---------- логика вопроса ----------

function openQuestion(t, i) {
  const r = round();
  const q = r?.themes[t]?.questions[i];
  if (!q || S.used[`${S.roundIndex}:${t}:${i}`]) return;
  S.phase = 'question';
  S.q = {
    ...q, t, i, theme: r.themes[t].name, value: q.price, tried: [], answering: null, target: null, buzzOpenedAt: null,
    stage: q.type === 'cat' ? 'cat-pick' : q.type === 'stake' ? 'stake-bet' : 'reading',
  };
  if (q.type === 'stake') {
    S.q.target = S.chooser;
    const p = player(S.chooser);
    S.q.stakeMin = q.price;
    S.q.stakeMax = Math.max(q.price, p ? p.score : 0);
  }
  broadcast({ kind: q.type === 'normal' ? 'open' : q.type });
}

function closeQuestion() {
  if (!S.q) return;
  S.used[`${S.roundIndex}:${S.q.t}:${S.q.i}`] = true;
  S.q = null;
  S.phase = 'board';
}

function judge(correct) {
  const q = S.q;
  if (!q || q.stage !== 'answering' || !q.answering) return;
  const p = player(q.answering);
  if (p) p.score += correct ? q.value : -q.value;
  if (correct) {
    S.chooser = q.answering;
    q.stage = 'reveal';
    return broadcast({ kind: 'right', id: q.answering });
  }
  q.tried.push(q.answering);
  q.answering = null;
  const othersLeft = S.players.some(pl => !q.tried.includes(pl.id));
  if (q.type === 'normal' && othersLeft) {
    q.stage = 'buzz';
    q.buzzOpenedAt = Date.now();
  } else {
    q.stage = 'reveal';
  }
  broadcast({ kind: 'wrong', id: p?.id });
}

// ---------- финал ----------

function startFinal() {
  closeQuestion();
  if (!S.pack.final) return endGame();
  const positive = S.players.filter(p => p.score > 0).map(p => p.id);
  S.phase = 'final';
  S.final = {
    stage: 'themes', removed: [], chosen: null,
    participants: positive.length ? positive : S.players.map(p => p.id),
    bets: {}, answers: {}, judged: {}, opened: {}, deadline: null,
  };
  if (S.pack.final.themes.length === 1) { S.final.chosen = 0; S.final.stage = 'bets'; }
  broadcast({ kind: 'final' });
}

function endGame() {
  S.q = null;
  S.phase = 'end';
  broadcast({ kind: 'end' });
}

// ---------- обработчики ----------

io.on('connection', socket => {
  socket.on('hello', ({ role, token, hostToken, hostKey, takeover } = {}) => {
    if (role === 'host') {
      if (!isLocal(socket) && hostKey !== HOST_KEY) return socket.emit('host-denied');
      if (S.hostToken && S.hostToken !== hostToken && !takeover) return socket.emit('host-busy');
      S.hostToken = hostToken || uid();
      socket.data.role = 'host';
      socket.emit('host-token', S.hostToken);
      socket.emit('host-key', HOST_KEY);
    } else if (role === 'screen') {
      socket.data.role = 'screen';
    } else if (role === 'player') {
      const p = S.players.find(pl => pl.token === token);
      socket.data.role = 'player';
      socket.data.playerId = p ? p.id : null;
    }
    broadcast();
  });

  socket.on('join', ({ name, token } = {}) => {
    name = String(name || '').trim().slice(0, 20);
    if (!name) return toast(socket, 'Введите имя');
    let p = S.players.find(pl => pl.token === token);
    if (!p) {
      if (S.players.length >= MAX_PLAYERS) return toast(socket, `Уже ${MAX_PLAYERS} игрока — мест нет`);
      if (S.players.some(pl => pl.name.toLowerCase() === name.toLowerCase())) return toast(socket, 'Такое имя уже занято');
      p = { id: uid(), token: token || uid(), name, score: 0 };
      S.players.push(p);
    } else {
      p.name = name;
    }
    socket.data.role = 'player';
    socket.data.playerId = p.id;
    socket.emit('player-token', p.token);
    broadcast({ kind: 'join', id: p.id });
  });

  // выбирающий игрок может сам нажать на ячейку у себя на телефоне
  socket.on('pick', ({ t, i } = {}) => {
    if (S.phase !== 'board' || !socket.data.playerId || socket.data.playerId !== S.chooser) return;
    openQuestion(t, i);
  });

  socket.on('buzz', () => {
    const q = S.q, id = socket.data.playerId;
    if (!q || !id || q.stage !== 'buzz' || q.tried.includes(id)) return;
    q.stage = 'answering';
    q.answering = id;
    broadcast({ kind: 'buzz', id });
  });

  socket.on('stake', amount => {
    const q = S.q;
    if (!q || q.stage !== 'stake-bet' || socket.data.playerId !== q.target) return;
    setStake(amount);
  });

  socket.on('final-bet', amount => {
    const f = S.final, id = socket.data.playerId;
    if (!f || f.stage !== 'bets' || !f.participants.includes(id)) return;
    const max = Math.max(0, player(id).score);
    f.bets[id] = Math.max(0, Math.min(max, Math.round(Number(amount) || 0)));
    broadcast({ kind: 'final-bet', id });
  });

  socket.on('final-answer', text => {
    const f = S.final, id = socket.data.playerId;
    if (!f || f.stage !== 'question' || !f.participants.includes(id)) return;
    f.answers[id] = String(text || '').trim().slice(0, 200);
    broadcast({ kind: 'final-answer', id });
  });

  socket.on('host', (a = {}) => {
    if (socket.data.role !== 'host') return;
    const q = S.q, f = S.final;
    switch (a.type) {
      case 'mediaOnPhones': S.mediaOnPhones = !!a.on; break;
      case 'setPack':
        if (S.phase !== 'lobby') return;
        try { S.pack = loadPack(a.id); S.packId = a.id; } catch (e) { return toast(socket, `Не удалось загрузить пак: ${e.message}`); }
        break;
      case 'start':
        if (!S.pack) return toast(socket, 'Нет пака');
        if (!S.players.length) return toast(socket, 'Нет ни одного игрока');
        S.phase = 'board'; S.roundIndex = 0; S.used = {}; S.q = null; S.final = null;
        S.chooser = S.players[Math.floor(Math.random() * S.players.length)].id;
        return broadcast({ kind: 'round' });
      case 'kick':
        S.players = S.players.filter(p => p.id !== a.id);
        for (const s of io.sockets.sockets.values()) if (s.data.playerId === a.id) { s.data.playerId = null; s.emit('kicked'); }
        if (S.chooser === a.id) S.chooser = S.players[0]?.id || null;
        break;
      case 'score': { const p = player(a.id); if (p) p.score += Number(a.delta) || 0; break; }
      case 'setScore': { const p = player(a.id); if (p) p.score = Math.round(Number(a.value) || 0); break; }
      case 'rename': { const p = player(a.id); if (p && a.name) p.name = String(a.name).slice(0, 20); break; }
      case 'chooser': if (player(a.id)) S.chooser = a.id; break;
      case 'open': if (S.phase === 'board') return openQuestion(a.t, a.i); return;
      case 'catTarget':
        if (!q || q.stage !== 'cat-pick' || !player(a.id)) return;
        q.target = a.id; q.answering = a.id; q.stage = 'answering';
        return broadcast({ kind: 'cat-target', id: a.id });
      case 'stake':
        if (!q || q.stage !== 'stake-bet') return;
        if (a.target && player(a.target)) {
          q.target = a.target;
          q.stakeMax = Math.max(q.price, player(a.target).score);
          break;
        }
        return setStake(a.amount);
      case 'openBuzz':
        if (!q || (q.stage !== 'reading' && q.stage !== 'answering')) return;
        q.stage = 'buzz'; q.answering = null; q.buzzOpenedAt = Date.now();
        return broadcast({ kind: 'buzz-open' });
      case 'judge': return judge(!!a.correct);
      case 'reveal': if (q) { q.stage = 'reveal'; q.answering = null; } return broadcast({ kind: 'reveal' });
      case 'back': closeQuestion(); break;
      case 'nextRound':
        closeQuestion();
        if (S.roundIndex + 1 < S.pack.rounds.length) { S.roundIndex++; S.phase = 'board'; return broadcast({ kind: 'round' }); }
        return startFinal();
      case 'prevRound':
        if (S.roundIndex > 0) { closeQuestion(); S.roundIndex--; S.phase = 'board'; }
        break;
      case 'final': return startFinal();
      case 'finalRemove': {
        if (!f || f.stage !== 'themes' || f.removed.includes(a.t)) return;
        f.removed.push(a.t);
        const left = S.pack.final.themes.map((_, i) => i).filter(i => !f.removed.includes(i));
        if (left.length === 1) { f.chosen = left[0]; f.stage = 'bets'; }
        return broadcast({ kind: 'final-remove' });
      }
      case 'finalParticipants':
        if (!f || f.stage !== 'themes' && f.stage !== 'bets') return;
        f.participants = (a.ids || []).filter(player);
        break;
      case 'finalBet': {
        if (!f || !f.participants.includes(a.id)) return;
        f.bets[a.id] = Math.max(0, Math.round(Number(a.amount) || 0));
        break;
      }
      case 'finalQuestion':
        if (!f || f.stage !== 'bets') return;
        f.participants.forEach(id => { if (f.bets[id] == null) f.bets[id] = 0; });
        f.stage = 'question'; f.deadline = Date.now() + FINAL_SECONDS * 1000;
        return broadcast({ kind: 'final-question' });
      case 'finalReveal':
        if (!f || f.stage !== 'question') return;
        f.stage = 'reveal';
        return broadcast({ kind: 'reveal' });
      case 'finalOpen': if (f && f.stage === 'reveal') f.opened[a.id] = true; break;
      case 'finalJudge': {
        if (!f || f.stage !== 'reveal' || f.judged[a.id] != null) return;
        const p = player(a.id); if (!p) return;
        f.opened[a.id] = true;
        f.judged[a.id] = !!a.correct;
        p.score += (a.correct ? 1 : -1) * (f.bets[a.id] || 0);
        return broadcast({ kind: a.correct ? 'right' : 'wrong', id: a.id });
      }
      case 'end': return endGame();
      case 'reset':
        S.phase = 'lobby'; S.q = null; S.final = null; S.used = {}; S.roundIndex = 0;
        S.players.forEach(p => { p.score = 0; });
        break;
      default: return;
    }
    broadcast();
  });

  socket.on('disconnect', () => broadcast());
});

function setStake(amount) {
  const q = S.q;
  q.value = Math.max(q.stakeMin, Math.min(q.stakeMax, Math.round(Number(amount) || 0)));
  q.answering = q.target;
  q.stage = 'answering';
  broadcast({ kind: 'stake-set' });
}

server.listen(PORT, '0.0.0.0', () => {
  const ip = lanAddress();
  console.log(`\n  🎂 Своя игра запущена!\n`);
  console.log(`  Ведущий:      http://localhost:${PORT}/host${KEY_FROM_ENV ? '   (ключ из HOST_KEY)' : ''}`);
  console.log(`  Экран (ТВ):   http://${ip}:${PORT}/screen`);
  console.log(`  Игроки:       http://${ip}:${PORT}/play   (тот же Wi‑Fi)\n`);
  if (!S.pack) console.log('  ⚠️  Не найден ни один пак в папке packs/\n');
  if (ONLINE) startTunnel();
});

// ---------- публичная ссылка через Cloudflare (бесплатно, без регистрации) ----------

function startTunnel() {
  console.log('  🌍 Создаю публичную ссылку…');
  let proc;
  try {
    proc = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://localhost:${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    return console.log('  ❌ Не удалось запустить cloudflared:', e.message);
  }
  proc.on('error', e => console.log(`  ❌ cloudflared не найден (${e.message}). Установи: brew install cloudflared`));
  const onData = buf => {
    const m = String(buf).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (!m || publicUrl) return;
    publicUrl = m[0];
    console.log(`\n  🔗 Ссылка для игроков (скинь её всем):\n\n     ${publicUrl}/play\n`);
    console.log(`  🔑 Ведущий с другого устройства: ${publicUrl}/host?key=${HOST_KEY}\n`);
    io.emit('join-info-changed');
  };
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  proc.on('exit', code => { if (code) console.log(`  ⚠️  Туннель закрылся (код ${code}). Перезапусти: npm run online`); publicUrl = null; io.emit('join-info-changed'); });
  const stop = () => { proc.kill(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
