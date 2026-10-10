// Проверка пака: что ещё не заполнено и каких файлов не хватает.
// Запуск: npm run check            (пак birthday)
//         npm run check -- mypack  (другой пак)
const fs = require('fs');
const path = require('path');

const id = process.argv[2] || 'birthday';
const dir = path.join(__dirname, 'packs', id);
let pack;
try {
  pack = JSON.parse(fs.readFileSync(path.join(dir, 'pack.json'), 'utf8'));
} catch (e) {
  console.error(`❌ pack.json не читается: ${e.message}`);
  process.exit(1);
}

const todo = [], missing = [];
const MEDIA = ['image', 'audio', 'video', 'answerImage', 'answerAudio', 'answerVideo'];

function check(where, obj) {
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v !== 'string' || !v) continue;
    if (v.includes('✏️')) todo.push(`${where} → ${k}: ${v}`);
    if (MEDIA.includes(k) && !/^https?:/.test(v) && !fs.existsSync(path.join(dir, v))) missing.push(`${where} → ${v}`);
  }
}

check('Название', { title: pack.title, subtitle: pack.subtitle });
(pack.rounds || []).forEach(r => r.themes.forEach(t => t.questions.forEach(q => check(`${r.name} / ${t.name} / ${q.price}`, q))));
(pack.final?.themes || []).forEach(t => check(`Финал / ${t.name}`, t.question));
if (pack.finale) check('Поздравление', pack.finale);

console.log(`\nПак «${pack.title}»\n`);
console.log(todo.length ? `✏️  Не заполнено (${todo.length}):\n  ${todo.join('\n  ')}\n` : '✅ Всё заполнено\n');
console.log(missing.length ? `🖼  Нет файлов (${missing.length}) — положи их в packs/${id}/:\n  ${missing.join('\n  ')}\n` : '✅ Все медиафайлы на месте\n');
