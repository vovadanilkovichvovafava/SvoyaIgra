// Модификаторы: спрятаны в случайных вопросах раунда. Все видят, что модификатор есть,
// но какой — узнаёт только тот, кто первым нажал кнопку. Действует только на него.
//
// right / wrong — множители очков за верный / неверный ответ
// instant      — сразу при нажатии: доля цены вопроса (+ подарок, − налог)
// steal        — за верный ответ очки забираются у лидера
// weight       — как часто выпадает

const MODS = {
  double:  { name: 'Двойные очки',   emoji: '✖️2', good: true,  weight: 3, right: 2,   desc: 'Верный ответ — ×2 очков' },
  jackpot: { name: 'Джекпот',        emoji: '💎', good: true,  weight: 1, right: 3,   desc: 'Верный ответ — ×3 очков!' },
  shield:  { name: 'Страховка',      emoji: '🛡️', good: true,  weight: 2, wrong: 0,   desc: 'Ошибка ничего не стоит' },
  gift:    { name: 'Подарок',        emoji: '🎁', good: true,  weight: 2, instant: 0.5, desc: 'Сразу + половина цены вопроса' },
  steal:   { name: 'Воришка',        emoji: '🦝', good: true,  weight: 2, steal: true, desc: 'Верный ответ — очки забираешь у лидера' },
  allin:   { name: 'Всё или ничего', emoji: '🎲', good: null,  weight: 2, right: 2, wrong: 2, desc: '×2 и в плюс, и в минус' },
  mine:    { name: 'Минное поле',    emoji: '💣', good: false, weight: 3, wrong: 2,   desc: 'Ошибка стоит ×2' },
  half:    { name: 'Половинка',      emoji: '🌗', good: false, weight: 2, right: 0.5, desc: 'Верный ответ — только половина очков' },
  tax:     { name: 'Налог',          emoji: '🧾', good: false, weight: 2, instant: -0.5, desc: 'Сразу − половина цены вопроса' },
};

const round10 = n => Math.round(n / 10) * 10;

function pickRandom(good) {
  // good: true/false — только хорошие/плохие; undefined — любые
  const ids = Object.keys(MODS).filter(id => good === undefined || MODS[id].good === good);
  let r = Math.random() * ids.reduce((s, id) => s + MODS[id].weight, 0);
  for (const id of ids) if ((r -= MODS[id].weight) < 0) return id;
  return ids[0];
}

// Раскладывает модификаторы по раунду: заданные в паке + случайные в обычных вопросах.
// Хороших и плохих всегда поровну (count округляется до чётного). «Всё или ничего» — только вручную через пак.
// Возвращает { "t:i": modId }
function assignRound(round, count) {
  const out = {}, free = [];
  round.themes.forEach((t, ti) => t.questions.forEach((q, qi) => {
    if (q.modifier && q.modifier !== 'random' && MODS[q.modifier]) out[`${ti}:${qi}`] = q.modifier;
    else if (q.modifier === 'random') out[`${ti}:${qi}`] = 'random';
    else if ((q.type || 'normal') === 'normal' && q.modifier !== 'none') free.push(`${ti}:${qi}`);
  }));
  // сколько хороших/плохих уже задано в паке
  const fixed = Object.values(out).filter(id => id !== 'random');
  let good = fixed.filter(id => MODS[id].good === true).length;
  let bad = fixed.filter(id => MODS[id].good === false).length;
  const half = Math.max(good, bad, Math.round(count / 2));
  // «random» из пака тоже идут в общий баланс
  const randomKeys = Object.keys(out).filter(k => out[k] === 'random');
  const slots = [...randomKeys];
  while (slots.length < half * 2 - good - bad && free.length) slots.push(free.splice(Math.floor(Math.random() * free.length), 1)[0]);
  // раздаём недостающие хорошие и плохие в перемешанные ячейки
  const kinds = [...Array(Math.max(0, half - good)).fill(true), ...Array(Math.max(0, half - bad)).fill(false)]
    .sort(() => Math.random() - 0.5);
  slots.forEach((key, k) => { out[key] = pickRandom(kinds[k] ?? (k % 2 === 0)); });
  return out;
}

// Сколько очков получит/потеряет игрок. Возвращает { delta, steal: { from, amount } | null }
function judgeDelta(modId, value, correct, playerId, players) {
  const m = MODS[modId] || {};
  if (!correct) return { delta: -round10(value * (m.wrong ?? 1)), steal: null };
  const delta = round10(value * (m.right ?? 1));
  if (m.steal) {
    const others = players.filter(p => p.id !== playerId);
    const leader = others.sort((a, b) => b.score - a.score)[0];
    const me = players.find(p => p.id === playerId);
    // забираем у лидера, только если он впереди
    if (leader && me && leader.score > me.score) return { delta, steal: { from: leader.id, amount: delta } };
  }
  return { delta, steal: null };
}

function instantDelta(modId, value) {
  const m = MODS[modId];
  return m?.instant ? round10(value * m.instant) : 0;
}

// Для клиентов: только описание, без весов
const publicList = Object.fromEntries(Object.entries(MODS).map(([id, m]) => [id, { name: m.name, emoji: m.emoji, good: m.good, desc: m.desc }]));

module.exports = { MODS, publicList, assignRound, judgeDelta, instantDelta };
