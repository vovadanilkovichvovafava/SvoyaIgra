// Аукцион, как в передаче: торгуются по очереди, начиная с выбравшего вопрос.
// Выбравший обязан открыть торги (минимум — цена вопроса, даже если у него меньше очков).
// Дальше каждый: поднять ставку, ва-банк или пас. Кому не хватает очков перебить — пасует автоматически.
// Побеждает последний не спасовавший — он отвечает на вопрос за свою ставку.

function create(players, chooserId, price) {
  const ids = players.map(p => p.id);
  const start = Math.max(0, ids.indexOf(chooserId));
  const order = [...ids.slice(start), ...ids.slice(0, start)];
  return { order, turn: order[0], bet: null, leader: null, passed: [], allin: false, price, done: false, log: [] };
}

const scoreOf = (players, id) => players.find(p => p.id === id)?.score ?? 0;

// Пределы ставки для игрока сейчас: { min, max } или null, если поднять нельзя
function limits(a, players, id) {
  const score = scoreOf(players, id);
  if (a.bet == null) return { min: a.price, max: Math.max(score, a.price) }; // первая ставка: номинал можно всегда
  if (a.allin && score <= a.bet) return null;
  if (score <= a.bet) return null;
  return { min: a.bet + 1, max: score };
}

// action: 'bid' | 'allin' | 'pass'. Возвращает текст ошибки или null.
function act(a, players, id, action, amount) {
  if (a.done) return 'Торги закончены';
  if (a.turn !== id) return 'Сейчас не твой ход';
  const lim = limits(a, players, id);
  const name = players.find(p => p.id === id)?.name;
  if (action === 'pass') {
    if (a.bet == null) return 'Первый игрок обязан сделать ставку';
    a.passed.push(id);
    a.log.push(`${name}: пас`);
  } else {
    if (!lim) return 'Не хватает очков, чтобы перебить';
    let v = action === 'allin' ? lim.max : Math.round(Number(amount) || 0);
    if (v < lim.min) return `Ставка не меньше ${lim.min}`;
    v = Math.min(v, lim.max);
    // ва-банк — только когда ставят все свои очки (номинал при нехватке очков — не ва-банк)
    a.allin = scoreOf(players, id) > 0 && v === scoreOf(players, id);
    a.bet = v;
    a.leader = id;
    a.log.push(`${name}: ${a.allin ? 'ва-банк ' : ''}${v}`);
  }
  advance(a, players);
  return null;
}

// Передать ход следующему, кто ещё может перебить; остальных — в пас
function advance(a, players) {
  const n = a.order.length;
  let k = a.order.indexOf(a.turn);
  for (let step = 0; step < n; step++) {
    k = (k + 1) % n;
    const id = a.order[k];
    if (id === a.leader || a.passed.includes(id)) continue;
    if (!limits(a, players, id)) {
      a.passed.push(id);
      a.log.push(`${players.find(p => p.id === id)?.name}: пас (не хватает очков)`);
      continue;
    }
    a.turn = id;
    return;
  }
  // перебить некому — торги окончены
  a.turn = null;
  a.done = true;
}

// Ведущий может досрочно закрыть торги (у кого старшая ставка — тот и отвечает)
function finish(a) {
  if (a.bet == null) return 'Ещё нет ни одной ставки';
  a.turn = null;
  a.done = true;
  return null;
}

module.exports = { create, act, limits, finish };
