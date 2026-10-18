// Модификаторы: спрятаны в случайных вопросах раунда. Все видят, что модификатор есть,
// но какой — узнаёт только тот, кто первым нажал кнопку. Действует только на него.
//
// good   — true: положительный, false: отрицательный, null: нейтральный
// right  — множитель очков за верный ответ
// steal  — за верный ответ очки забираются у лидера
// flip   — сразу при нажатии очки игрока меняют знак
// minus  — сразу при нажатии очки игрока становятся отрицательными
// swap   — сразу при нажатии игрок меняется очками: 'leader' — с лидером, 'last' — с последним
// instant — срабатывает сразу при нажатии (flip, minus, swap)
// rule   — особое правило ответа; очки не меняет, следит ведущий
// packOnly — случайно не выпадает, только если пак сам назвал его в раунде ("modifiers": [...])

const MODS = {
  double:  { name: 'Двойные очки',  emoji: '✖️2', good: true,  right: 2,   desc: 'Верный ответ — ×2 очков' },
  approx:  { name: 'Примерно',      emoji: '🎯', good: true,  rule: true, desc: 'Засчитывается ответ «примерно» — близкий к правильному' },
  half:    { name: 'Половинка',     emoji: '🌗', good: false, right: 0.5, desc: 'Верный ответ — только половина очков' },
  letterM: { name: 'Только на «М»', emoji: 'Ⓜ️', good: false, rule: true, desc: 'Отвечать можно только словами на букву «М»' },
  steal:   { name: 'Воришка',       emoji: '🦝', good: null,  steal: true, desc: 'Верный ответ — очки забираешь у лидера' },
  flip:    { name: 'Перевёртыш',    emoji: '🔄', good: null,  flip: true, instant: true, desc: 'Твои очки меняют знак: минус становится плюсом… и наоборот!' },
  swapLeader: { name: 'Рокировка',  emoji: '🤝', good: true,  swap: 'leader', instant: true, packOnly: true, desc: 'Ты сразу меняешься очками с лидером!' },
  swapLast:   { name: 'Обмен с последним', emoji: '🔀', good: false, swap: 'last', instant: true, packOnly: true, desc: 'Ты сразу меняешься очками с тем, у кого меньше всех' },
  minus:      { name: 'Плюс на минус', emoji: '➖', good: false, minus: true, instant: true, packOnly: true, desc: 'Твои очки становятся минусом: было +800 — стало −800' },
};

const round10 = n => Math.round(n / 10) * 10;

// Раскладывает модификаторы по раунду: заданные в паке + случайные в обычных вопросах.
// count — сколько положительных+отрицательных (их всегда поровну), neutral — сколько нейтральных сверху.
// used — модификаторы, которые уже поймали в этой игре: они больше не выпадают. В раунде все разные.
// В паке у вопроса можно указать "modifier": "<id>" | "random" | "none".
// У раунда можно задать точный список "modifiers": ["double", "minus"] — тогда count и neutral не используются.
// Возвращает { "t:i": modId }
function assignRound(round, count, neutral = 0, used = []) {
  if (Array.isArray(round.modifiers)) return assignListed(round, round.modifiers.filter(id => MODS[id] && !used.includes(id)));
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
  const pool = g => Object.keys(MODS).filter(id => MODS[id].good === g && !MODS[id].packOnly && !used.includes(id) && !fixed.includes(id))
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

// Точный список модификаторов раунда — в случайные обычные вопросы
function assignListed(round, ids) {
  const free = [];
  round.themes.forEach((t, ti) => t.questions.forEach((q, qi) => {
    if ((q.type || 'normal') === 'normal' && q.modifier !== 'none') free.push(`${ti}:${qi}`);
  }));
  free.sort(() => Math.random() - 0.5);
  return Object.fromEntries(ids.slice(0, free.length).map((id, k) => [free[k], id]));
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

// Срабатывает в момент нажатия кнопки (меняет очки игрока). Возвращает, с кем поменялись очками.
function onCatch(modId, player, players = []) {
  const m = MODS[modId];
  if (!m || !player) return null;
  if (m.flip) player.score = -player.score;
  if (m.minus) player.score = -Math.abs(player.score);
  if (m.swap) {
    const others = players.filter(p => p.id !== player.id).sort((a, b) => b.score - a.score);
    const other = m.swap === 'leader' ? others[0] : others[others.length - 1];
    // меняемся, только если это выгодно (лидер) или невыгодно (последний) — иначе ничего не происходит
    if (other && (m.swap === 'leader' ? other.score > player.score : other.score < player.score)) {
      [player.score, other.score] = [other.score, player.score];
      return other.id;
    }
  }
  return null;
}

// Для клиентов: только описание
const publicList = Object.fromEntries(Object.entries(MODS).map(([id, m]) => [id, { name: m.name, emoji: m.emoji, good: m.good, desc: m.desc, rule: !!m.rule, instant: !!m.instant }]));

module.exports = { MODS, publicList, assignRound, judgeDelta, onCatch };
