// Модификаторы: спрятаны в случайных вопросах раунда. Все видят, что модификатор есть,
// но какой — узнаёт только тот, кто первым нажал кнопку. Действует только на него.
//
// good   — true: положительный, false: отрицательный, null: нейтральный
// right  — множитель очков за верный ответ
// steal  — за верный ответ очки забираются у лидера
// flip   — сразу при нажатии очки игрока меняют знак
// rule   — особое правило ответа; очки не меняет, следит ведущий

const MODS = {
  double:  { name: 'Двойные очки',  emoji: '✖️2', good: true,  right: 2,   desc: 'Верный ответ — ×2 очков' },
  approx:  { name: 'Примерно',      emoji: '🎯', good: true,  rule: true, desc: 'Засчитывается ответ «примерно» — близкий к правильному' },
  half:    { name: 'Половинка',     emoji: '🌗', good: false, right: 0.5, desc: 'Верный ответ — только половина очков' },
  letterM: { name: 'Только на «М»', emoji: 'Ⓜ️', good: false, rule: true, desc: 'Отвечать можно только словами на букву «М»' },
  steal:   { name: 'Воришка',       emoji: '🦝', good: null,  steal: true, desc: 'Верный ответ — очки забираешь у лидера' },
  flip:    { name: 'Перевёртыш',    emoji: '🔄', good: null,  flip: true, desc: 'Твои очки меняют знак: минус становится плюсом… и наоборот!' },
};

const round10 = n => Math.round(n / 10) * 10;

// Раскладывает модификаторы по раунду: заданные в паке + случайные в обычных вопросах.
// count — сколько положительных+отрицательных (их всегда поровну), neutral — сколько нейтральных сверху.
// used — модификаторы, которые уже поймали в этой игре: они больше не выпадают. В раунде все разные.
// В паке у вопроса можно указать "modifier": "<id>" | "random" | "none".
// Возвращает { "t:i": modId }
function assignRound(round, count, neutral = 0, used = []) {
  const out = {}, free = [];
  round.themes.forEach((t, ti) => t.questions.forEach((q, qi) => {
    const key = `${ti}:${qi}`;
    if (MODS[q.modifier] && !used.includes(q.modifier) && !Object.values(out).includes(q.modifier)) out[key] = q.modifier;
    else if (q.modifier === 'random') free.unshift(key); // «random» из пака занимаем в первую очередь
    else if ((q.type || 'normal') === 'normal' && q.modifier !== 'none') free.push(key);
  }));
  const fixed = Object.values(out);
  const has = g => fixed.filter(id => MODS[id].good === g).length;
  // что ещё можно выдать: не пойманные раньше и не занятые в этом раунде
  const pool = g => Object.keys(MODS).filter(id => MODS[id].good === g && !used.includes(id) && !fixed.includes(id))
    .sort(() => Math.random() - 0.5);
  const goodPool = pool(true), badPool = pool(false), neutralPool = pool(null);
  // поровну: итоговое число положительных = отрицательных, насколько хватает оставшихся
  const target = Math.min(Math.max(Math.round(count / 2), has(true), has(false)), has(true) + goodPool.length, has(false) + badPool.length);
  const kinds = [
    ...goodPool.slice(0, Math.max(0, target - has(true))),
    ...badPool.slice(0, Math.max(0, target - has(false))),
    ...neutralPool.slice(0, Math.max(0, neutral - has(null))),
  ];
  // «random» из пака стоят в начале free, остальные ячейки — случайные
  const forced = free.filter(k => round.themes[k.split(':')[0]].questions[k.split(':')[1]].modifier === 'random');
  const rest = free.filter(k => !forced.includes(k)).sort(() => Math.random() - 0.5);
  const slots = [...forced, ...rest].slice(0, kinds.length);
  kinds.sort(() => Math.random() - 0.5);
  slots.forEach((key, k) => { out[key] = kinds[k]; });
  return out;
}

// Сколько очков получит/потеряет игрок. Возвращает { delta, steal: { from, amount } | null }
function judgeDelta(modId, value, correct, playerId, players) {
  const m = MODS[modId] || {};
  if (!correct) return { delta: -value, steal: null };
  const delta = round10(value * (m.right ?? 1));
  if (m.steal) {
    const me = players.find(p => p.id === playerId);
    const leader = players.filter(p => p.id !== playerId).sort((a, b) => b.score - a.score)[0];
    // забираем у лидера, только если он впереди
    if (leader && me && leader.score > me.score) return { delta, steal: { from: leader.id, amount: delta } };
  }
  return { delta, steal: null };
}

// Срабатывает в момент нажатия кнопки (меняет очки игрока)
function onCatch(modId, player) {
  if (MODS[modId]?.flip && player) player.score = -player.score;
}

// Для клиентов: только описание
const publicList = Object.fromEntries(Object.entries(MODS).map(([id, m]) => [id, { name: m.name, emoji: m.emoji, good: m.good, desc: m.desc, rule: !!m.rule }]));

module.exports = { MODS, publicList, assignRound, judgeDelta, onCatch };
