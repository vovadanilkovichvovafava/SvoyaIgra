// Общие помощники для всех экранов
const socket = io();
let state = null;

const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pname = id => state?.players.find(p => p.id === id)?.name ?? '—';

function toast(text, ms = 2600) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = text;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}
socket.on('toast', t => toast(t));

// часы сервера: телефоны могут спешить/отставать, таймеры считаем по серверу
let clockOffset = 0;
socket.on('state', s => { if (s.now) clockOffset = s.now - Date.now(); });
const serverNow = () => Date.now() + clockOffset;

// полоска-таймер; обновляется сама, перерисовывать не нужно
function timerBar(deadline, seconds, cls = '') {
  if (!deadline) return '';
  return `<div class="tbar ${cls}" data-deadline="${deadline}" data-total="${seconds * 1000}"><i></i><span></span></div>`;
}
setInterval(() => {
  for (const el of document.querySelectorAll('.tbar')) {
    const left = Math.max(0, +el.dataset.deadline - serverNow());
    el.firstChild.style.width = (100 * left / +el.dataset.total) + '%';
    el.lastChild.textContent = Math.ceil(left / 1000);
    el.classList.toggle('low', left < 3000);
  }
}, 100);

function storage(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch { return null; }
}

// ---------- рендер ----------

function renderScores(s, { compact = false } = {}) {
  if (!s.players.length) return '<div class="muted">Ждём игроков…</div>';
  const q = s.q;
  return `<div class="scores">${s.players.map(p => {
    const cls = ['score'];
    if (p.id === s.chooser && s.phase === 'board') cls.push('chooser');
    if (q && q.answering === p.id) cls.push('answering');
    if (q && q.tried?.includes(p.id)) cls.push('tried');
    if (!p.online) cls.push('offline');
    const eff = s.effects?.[p.id] && s.modList[s.effects[p.id]];
    const team = p.members ? `style="--team:${p.color}"` : '';
    const members = p.members ? `<div class="members">${p.members.map(esc).join(', ') || '—'}</div>` : '';
    return `<div class="${cls.join(' ')}${p.members ? ' team' : ''}" ${team}><div class="name">${esc(p.name)}${eff ? ` <span class="eff" title="${esc(eff.name)}: ${esc(eff.desc)}">${eff.emoji}</span>` : ''}</div>${members}<div class="pts ${p.score < 0 ? 'neg' : ''}">${p.score}</div></div>`;
  }).join('')}</div>`;
}

function renderBoard(s, clickable) {
  const r = s.round;
  if (!r) return '';
  const cols = Math.max(...r.themes.map(t => t.cells.length));
  return `<div class="board ${clickable ? 'clickable' : ''}" style="--cols:${cols}">
    ${r.themes.map((t, ti) => `<div class="theme">${esc(t.name)}</div>${t.cells.map((c, qi) =>
      clickable && !c.used
        ? `<button class="cell" data-t="${ti}" data-i="${qi}">${c.price}${c.mod ? `<span class="cellmod" title="${esc(s.modList[c.mod].name)}">${s.modList[c.mod].emoji}</span>` : ''}</button>`
        : `<div class="cell ${c.used ? 'used' : ''}">${c.used ? '' : c.price}</div>`
    ).join('')}`).join('')}
  </div>`;
}

function renderMedia(o, prefix = '', { noSound = false, autoplay = false } = {}) {
  const img = o[prefix ? prefix + 'Image' : 'image'], aud = o[prefix ? prefix + 'Audio' : 'audio'], vid = o[prefix ? prefix + 'Video' : 'video'];
  let h = '';
  if (img) h += `<img src="${esc(img)}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'muted',textContent:'[нет картинки: ${esc(img)}]'}))">`;
  if (noSound) {
    if (vid && !prefix && o.videoMuted) h += `<video src="${esc(vid)}" muted loop autoplay playsinline></video>`;
    else if (vid || aud) h += `<div class="badge">${vid ? '🎬 Смотрим' : '🎵 Слушаем'} на экране ведущего</div>`;
    return h;
  }
  // videoMuted: в вопросе видео без звука и по кругу (угадать фразу), в ответе — со звуком
  if (vid) h += !prefix && o.videoMuted
    ? `<video src="${esc(vid)}" muted loop autoplay playsinline></video>`
    : `<video src="${esc(vid)}" controls playsinline ${autoplay ? 'autoplay' : ''}></video>`;
  if (aud) h += `<audio src="${esc(aud)}" controls></audio>`;
  return h;
}

const TYPE_LABEL = { cat: 'Кот в мешке', stake: 'Вопрос со ставкой', mod: 'Модификатор', auction: 'Аукцион' };

function renderQuestion(s, { host = false, noSound = false } = {}) {
  const q = s.q;
  if (q.type === 'mod') return renderModCell(s, { host });
  const meta = `<div class="meta">${esc(q.theme)} · ${q.value}${q.type !== 'normal' ? ' · ' + TYPE_LABEL[q.type] : ''}</div>`;
  if (q.stage === 'cat-pick' && !host) {
    return `<div class="question"><div class="special">Кот в мешке<small>${esc(pname(s.chooser))} отдаёт вопрос другому игроку</small></div></div>`;
  }
  if (q.stage === 'stake-bet' && !host) {
    return `<div class="question"><div class="special">Вопрос со ставкой<small>${esc(pname(q.target))} ставит от ${q.stakeMin} до ${q.stakeMax}</small></div></div>`;
  }
  if (q.stage === 'auction' && !host) {
    return `<div class="question"><div class="special">Аукцион<small>${esc(q.theme)} · от ${q.price}</small></div>${renderAuction(s)}</div>`;
  }
  let h = `<div class="question">${meta}`;
  if (q.stage === 'auction') h += renderAuction(s);
  if (q.type === 'cat' && q.catTheme) h += `<div class="badge">Тема: ${esc(q.catTheme)}</div>`;
  h += effectBadge(s);
  // немое видео-вопрос при показе ответа заменяется видео со звуком
  const qMedia = q.stage === 'reveal' && q.videoMuted && q.answerVideo ? { ...q, video: null } : q;
  h += `<div class="text">${esc(q.text)}</div>${renderMedia(qMedia, '', { noSound })}`;
  if (q.answer != null) {
    h += `<div class="answer">${host && q.stage !== 'reveal' ? '<span class="muted" style="font-size:.5em;display:block">ответ (видишь только ты)</span>' : ''}${esc(q.answer)}</div>`;
    if (q.stage === 'reveal' || host) h += renderMedia(q, 'answer', { noSound, autoplay: q.stage === 'reveal' });
    if (q.comment) h += `<div class="comment">${esc(q.comment)}</div>`;
  }
  return h + '</div>';
}

function statusLine(s) {
  const q = s.q;
  if (!q) return '';
  switch (q.stage) {
    case 'reading': return 'Читаем вопрос… кнопки пока закрыты';
    case 'buzz': return (q.type === 'mod' ? 'Кто рискнёт? Жми!' : 'Кнопки открыты — жми!') + timerBar(q.buzzDeadline, 10);
    case 'answering': {
      const race = Object.entries(q.race || {}).sort((a, b) => a[1] - b[1])
        .map(([id, ms]) => `${esc(pname(id))} +${(ms / 1000).toFixed(2)} с`).join(' · ');
      return `Отвечает: <b>${esc(pname(q.answering))}</b>${race ? ` <span class="muted" style="font-size:.8em">(опоздали: ${race})</span>` : ''}` + timerBar(q.answerDeadline, 15, 'answer');
    }
    case 'reveal': return 'Правильный ответ';
    case 'mod-done': return `<b>${esc(pname(q.modOwner))}</b> забирает модификатор`;
    case 'cat-pick': return 'Кому отдать кота?';
    case 'stake-bet': return `${esc(pname(q.target))} делает ставку…`;
    case 'auction': {
      const a = q.auction;
      return `Торги: ходит <b>${esc(pname(a.turn))}</b>` + (a.bet != null ? ` · ставка <b>${a.bet}</b> (${esc(pname(a.leader))})` : ' · первая ставка');
    }
  }
  return '';
}

function renderFinale(s) {
  const f = s.finale || {};
  const sorted = [...s.players].sort((a, b) => b.score - a.score);
  const winner = sorted[0];
  return `<div class="finale">
    ${winner ? `<div class="badge" style="font-size:18px">Победитель: ${esc(winner.name)} — ${winner.score}</div>` : ''}
    <h1>${esc(f.title || 'Игра окончена!')}</h1>
    ${f.image ? `<img src="${esc(f.image)}" alt="" onerror="this.remove()">` : ''}
    ${f.message ? `<div class="message">${esc(f.message)}</div>` : ''}
    ${f.audio ? `<audio src="${esc(f.audio)}" controls autoplay></audio>` : ''}
    <div style="width:min(800px,100%)">${renderScores(s)}</div>
    ${s.awards?.length ? `<h2 class="awards-title">Награды</h2><div class="awards">${s.awards.map((x, k) =>
      `<div class="award" style="animation-delay:${0.6 + k * 0.35}s"><div class="e">${x.emoji}</div><div class="t">${esc(x.title)}</div>
        <div class="n">${esc(x.name)}</div><div class="d">${esc(x.detail)}</div></div>`).join('')}</div>` : ''}
  </div>`;
}

// ---------- звуки (без файлов, синтез) ----------

let actx;
function beep(freqs, dur = 0.12, type = 'sine', gap = 0.02, vol = 0.18) {
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    let t = actx.currentTime;
    for (const f of [].concat(freqs)) {
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = type; o.frequency.value = f;
      g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.connect(g).connect(actx.destination); o.start(t); o.stop(t + dur);
      t += dur + gap;
    }
  } catch {}
}
const SFX = {
  buzz: () => beep([880, 1320], 0.1, 'square', 0, 0.12),
  right: () => beep([523, 659, 784, 1047], 0.1, 'triangle'),
  wrong: () => beep([300, 200], 0.22, 'sawtooth', 0.03, 0.12),
  open: () => beep([660], 0.08),
  special: () => beep([784, 988, 1175, 988, 1175, 1568], 0.08, 'triangle'),
  'buzz-open': () => beep([1200], 0.06, 'sine', 0, 0.1),
  timeout: () => beep([440, 330, 220], 0.16, 'triangle', 0.02, 0.14),
  round: () => beep([392, 523, 659, 784], 0.12, 'triangle', 0.03, 0.14),
  end: () => beep([523, 523, 587, 523, 698, 659], 0.18, 'triangle', 0.05), // «Happy Birthday» — первые ноты
};
// разблокируем звук на iOS первым касанием
document.addEventListener('pointerdown', () => { try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); actx.resume(); } catch {} }, { once: true });

// ---------- конфетти ----------

function confetti(duration = 4000) {
  const c = document.createElement('canvas');
  c.className = 'confetti';
  document.body.appendChild(c);
  const ctx = c.getContext('2d');
  const W = (c.width = innerWidth), H = (c.height = innerHeight);
  const colors = ['#ffd166', '#ff6fae', '#b28bff', '#3ddc97', '#6fc3ff', '#ffffff'];
  const parts = Array.from({ length: 220 }, () => ({
    x: Math.random() * W, y: -20 - Math.random() * H * 0.6, r: 4 + Math.random() * 6,
    vx: -2 + Math.random() * 4, vy: 2 + Math.random() * 4, a: Math.random() * 6, va: -0.2 + Math.random() * 0.4,
    c: colors[(Math.random() * colors.length) | 0],
  }));
  const start = performance.now();
  (function frame(now) {
    ctx.clearRect(0, 0, W, H);
    for (const p of parts) {
      p.x += p.vx; p.y += p.vy; p.a += p.va; p.vy += 0.03;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.a); ctx.fillStyle = p.c;
      ctx.fillRect(-p.r / 2, -p.r / 4, p.r, p.r / 2); ctx.restore();
    }
    if (now - start < duration) requestAnimationFrame(frame); else c.remove();
  })(start);
}

function playFx(ev) {
  if (!ev) return;
  if (ev.kind === 'cat' || ev.kind === 'stake') SFX.special();
  else if (SFX[ev.kind]) SFX[ev.kind]();
  if (ev.kind === 'end') { confetti(7000); setTimeout(() => confetti(6000), 2500); }
}

// Перерисовываем блок только если разметка поменялась — иначе сбросятся видео/аудио и поля ввода
function setHTML(el, html) {
  if (el._html === html) return false;
  el._html = html;
  el.innerHTML = html;
  return true;
}

// ---------- заставка раунда: название и темы по одной, как в передаче ----------

function roundIntro(s) {
  const r = s.round;
  if (!r) return;
  document.querySelector('.intro')?.remove();
  const el = document.createElement('div');
  el.className = 'intro';
  el.innerHTML = `<div class="intro-title">${esc(r.name)}</div>` +
    r.themes.map((t, i) => `<div class="intro-theme" style="animation-delay:${0.6 + i * 0.45}s">${esc(t.name)}</div>`).join('');
  el.onclick = () => el.remove();
  document.body.appendChild(el);
  const total = 0.6 + r.themes.length * 0.45 + 2.2;
  setTimeout(() => el.classList.add('out'), total * 1000);
  setTimeout(() => el.remove(), total * 1000 + 600);
}

// ---------- модификаторы ----------

const modClass = m => m.good === true ? 'good' : m.good === false ? 'bad' : 'mixed';

// Ячейка-модификатор: только слово «МОДИФИКАТОР», после нажатия — что выпало
function renderModCell(s, { host = false } = {}) {
  const q = s.q;
  let h = '<div class="question"><div class="special">Модификатор';
  if (q.stage === 'buzz') h += `<small>Жми, если рискнёшь!</small>`;
  h += '</div>';
  if (host && q.mod && !q.modOwner) h += `<div class="muted">(видишь только ты: ${s.modList[q.mod].emoji} ${esc(s.modList[q.mod].name)})</div>`;
  return h + '</div>';
}

// В вопросе: напоминание, если у отвечающего есть модификатор (перевёртыш уже сработал — просто показываем)
function effectBadge(s) {
  const q = s.q, id = q.answering;
  const eff = id && (s.effects?.[id] || (q.mod && s.modList[q.mod]?.instant && q.modOwner === id ? q.mod : null));
  if (!eff) return '';
  const m = s.modList[eff];
  return `<div class="modbadge ${modClass(m)}">${m.emoji} ${esc(pname(id))}: <b>${esc(m.name)}</b> — ${esc(m.desc)}</div>`;
}

// «Рулетка»: прокручиваем модификаторы и останавливаемся на выпавшем
function modReveal(s, ev) {
  const list = Object.values(s.modList), m = s.modList[ev.mod];
  if (!m) return;
  document.querySelector('.modfx')?.remove();
  const el = document.createElement('div');
  el.className = 'modfx';
  el.innerHTML = `<div class="modfx-who">${esc(pname(ev.id))} ${ev.id === s.you ? '(ты!)' : ''} ловит модификатор…</div>
    <div class="modfx-slot"><span class="e"></span><span class="n"></span></div><div class="modfx-desc"></div>`;
  el.onclick = () => el.remove();
  document.body.appendChild(el);
  const e = el.querySelector('.e'), n = el.querySelector('.n'), slot = el.querySelector('.modfx-slot');
  let k = 0, delay = 50;
  (function spin() {
    const x = list[k++ % list.length];
    e.textContent = x.emoji; n.textContent = x.name;
    beep([500 + (k % 5) * 80], 0.03, 'square', 0, 0.06);
    if (delay < 260) { delay *= 1.15; return setTimeout(spin, delay); }
    e.textContent = m.emoji; n.textContent = m.name;
    slot.className = 'modfx-slot ' + modClass(m);
    el.querySelector('.modfx-desc').textContent = m.desc + (ev.swapWith ? ` (с: ${pname(ev.swapWith)})` : '');
    (m.good === false ? SFX.wrong : m.good ? SFX.right : SFX.special)();
    if (m.good) confetti(1500);
    setTimeout(() => el.classList.add('out'), 2600);
    setTimeout(() => el.remove(), 3200);
  })();
}

// ---------- аукцион ----------

function renderAuction(s) {
  const a = s.q.auction;
  if (!a) return '';
  const rows = a.order.map(id => {
    let st = '<span class="muted">—</span>', cls = '';
    if (id === a.leader) { st = `<b>${a.bet}</b>${a.allin ? ' ва-банк' : ''}`; cls = 'lead'; }
    else if (a.passed.includes(id)) { st = 'пас'; cls = 'passed'; }
    if (id === a.turn) { cls += ' turn'; st += ' <span class="tag">ходит</span>'; }
    return `<div class="arow ${cls}"><span>${esc(pname(id))}</span><span>${st}</span></div>`;
  }).join('');
  const last = a.log.length ? `<div class="muted" style="font-size:.8em">${esc(a.log[a.log.length - 1])}</div>` : '';
  return `<div class="auction">${rows}</div>${last}`;
}
