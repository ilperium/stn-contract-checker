// Запуск: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const S = require('../src/extractor.js');

const DIR = path.join(__dirname, '..', 'documents');
const CHECK = '2026-03-10';

function demoFiles() {
  return fs.readdirSync(DIR).filter((f) => f.endsWith('.txt')).sort()
    .map((name) => ({ name, text: fs.readFileSync(path.join(DIR, name), 'utf8') }));
}
function run(files, date = CHECK) {
  return S.analyze(S.parseAll(files), date);
}
function row(res, no) {
  return res.rows.find((r) => r.contractNo === no);
}
// Цитата обязана дословно присутствовать в указанном абзаце указанного файла.
function assertSource(files, source) {
  const f = files.find((x) => x.name === source.fileName);
  assert.ok(f, `файл ${source.fileName} не найден`);
  const para = S.splitParagraphs(f.text).find((p) => p.n === source.p);
  assert.ok(para && para.text.includes(source.quote), `цитата не найдена в ${source.fileName} ¶${source.p}`);
}

const CONTRACT = (no, supplier, amountLine, deliveryLine) => `ДОГОВОР ПОСТАВКИ № ${no}
Дата: 01.02.2026
Статус: подписан обеими сторонами 01.02.2026.

1.1. Покупатель: ООО «СеверМет». Поставщик: ${supplier}.

2.1. ${amountLine}

3.1. ${deliveryLine}
`;
const AMENDMENT = (no, status, body) => `ДОПОЛНИТЕЛЬНОЕ СОГЛАШЕНИЕ № 1 К ДОГОВОРУ ${no}
Дата: 01.03.2026
Статус: ${status}

${body}
`;

test('таблица по трём договорам и ответы на вопросы задания', () => {
  const files = demoFiles();
  const res = run(files);
  assert.deepEqual(res.rows.map((r) => r.contractNo), ['STN-101', 'STN-102', 'STN-103']);

  // Q1: срок STN-101 изменён подписанным допсоглашением; проект № 2 не учитывается.
  const r101 = row(res, 'STN-101');
  assert.equal(r101.delivery.value, '2026-04-30');
  assert.equal(r101.delivery.changedBy.fileName, '02_amendment_signed.txt');
  assert.equal(r101.delivery.history[0].value, '2026-04-15');
  assert.equal(r101.amount.value, 1380000);
  assert.equal(r101.supplier.value, 'ООО «Вектор Прибор»');

  // Q2: сумма STN-102 — 840 000, не аванс 252 000.
  const r102 = row(res, 'STN-102');
  assert.equal(r102.amount.value, 840000);
  assert.equal(r102.amount.status, 'ok');
  assert.equal(r102.delivery.value, '2026-03-20'); // не срок оплаты 10.04

  // Q3: сумма STN-103 — нет данных, лимит 600 000 не подставляется.
  const r103 = row(res, 'STN-103');
  assert.equal(r103.amount.value, null);
  assert.equal(r103.amount.status, 'missing');
  assert.equal(S.fmtMoney(r103.amount.value), 'нет данных');

  // Q4: раньше 01.04.2026 — только STN-102, и по нему есть несогласованный перенос на 27.03.
  const q4 = S.deliveriesBefore(res, '2026-04-01');
  assert.deepEqual(q4.hits.map((h) => h.row.contractNo), ['STN-102']);
  assert.equal(q4.hits[0].pendingDelivery.length, 1);
  assert.equal(q4.hits[0].pendingDelivery[0].value, '2026-03-27');
  assert.equal(q4.hits[0].pendingDelivery[0].source.fileName, '05_supplier_email.txt');

  for (const r of res.rows) for (const f of [r.amount, r.delivery, r.supplier]) if (f.source) assertSource(files, f.source);
});

test('письмо и неподписанный проект не меняют условия, а показываются отдельно', () => {
  const res = run(demoFiles());
  const r101 = row(res, 'STN-101');
  const draft = r101.proposals.filter((p) => p.source.fileName === '06_amendment_draft.txt');
  assert.deepEqual(draft.map((p) => [p.field, p.value, p.kind]).sort(), [['amount', 1450000, 'pending'], ['delivery', '2026-05-10', 'pending']]);
  const r102 = row(res, 'STN-102');
  assert.equal(r102.proposals[0].kind, 'pending');
  assert.match(r102.proposals[0].label, /Письмо/);
  assert.equal(res.unlinked.length, 0);
});

test('результат не зависит от имён файлов и порядка загрузки', () => {
  const files = demoFiles();
  const renamed = files.map((f, i) => ({ name: `zz_${9 - i}_upload.txt`, text: f.text })).reverse();
  const a = run(files);
  const b = run(renamed);
  const pick = (res) => res.rows.map((r) => [r.contractNo, r.amount.value, r.delivery.value, r.proposals.length]);
  assert.deepEqual(pick(b), pick(a));
});

test('до вступления допсоглашения в силу действуют исходные условия', () => {
  const res = run(demoFiles(), '2026-02-28');
  const r101 = row(res, 'STN-101');
  assert.equal(r101.amount.value, 1200000);
  assert.equal(r101.delivery.value, '2026-04-15');
  assert.ok(r101.proposals.some((p) => p.source.fileName === '02_amendment_signed.txt' && /после даты проверки/.test(p.label)));
});

test('новый договор того же формата и изменённое поле', () => {
  const files = demoFiles();
  files.push({
    name: 'new.txt',
    text: CONTRACT('STN-104', 'АО «Новый Поставщик»',
      'Общая стоимость поставки составляет 2 050 000,50 рублей, включая НДС.',
      'Поставщик обязуется поставить товар не позднее 25.03.2026.'),
  });
  files[0] = { ...files[0], text: files[0].text.replace('15.04.2026', '16.04.2026') };
  const res = run(files);
  const r104 = row(res, 'STN-104');
  assert.equal(r104.amount.value, 2050000.5);
  assert.equal(r104.delivery.value, '2026-03-25');
  assert.equal(r104.supplier.value, 'АО «Новый Поставщик»');
  assert.equal(row(res, 'STN-101').delivery.history[0].value, '2026-04-16');
  assert.deepEqual(S.deliveriesBefore(res, '2026-04-01').hits.map((h) => h.row.contractNo), ['STN-102', 'STN-104']);
});

test('допсоглашение без даты вступления в силу — требует проверки', () => {
  const files = [
    { name: 'c.txt', text: CONTRACT('AB-1', 'ООО «Альфа»', 'Общая стоимость поставки составляет 100 000 рублей.', 'Поставщик обязуется поставить товар не позднее 01.05.2026.') },
    { name: 'a.txt', text: AMENDMENT('AB-1', 'подписано обеими сторонами 01.03.2026.', '1. Общая стоимость поставки составляет 150 000 рублей.') },
  ];
  const r = row(run(files), 'AB-1');
  assert.equal(r.amount.value, 100000);
  assert.equal(r.amount.status, 'review');
  assert.ok(r.flags.some((f) => /дата вступления в силу не найдена/.test(f)));
});

test('неподписанное допсоглашение (не «проект» в заголовке) не применяется', () => {
  const files = [
    { name: 'c.txt', text: CONTRACT('AB-2', 'ООО «Альфа»', 'Общая стоимость поставки составляет 100 000 рублей.', 'Поставщик обязуется поставить товар не позднее 01.05.2026.') },
    { name: 'a.txt', text: AMENDMENT('AB-2', 'не подписано.', '1. Срок поставки — не позднее 01.06.2026.\n\n2. Соглашение вступает в силу 01.03.2026.') },
  ];
  const r = row(run(files), 'AB-2');
  assert.equal(r.delivery.value, '2026-05-01');
  assert.equal(r.delivery.status, 'ok');
  assert.deepEqual(r.proposals.map((p) => [p.field, p.value, p.kind]), [['delivery', '2026-06-01', 'pending']]);
});

test('подписанное соглашение «с момента подписания» применяется с даты подписи', () => {
  const files = [
    { name: 'c.txt', text: CONTRACT('AB-3', 'ООО «Альфа»', 'Общая стоимость поставки составляет 100 000 рублей.', 'Поставщик обязуется поставить товар не позднее 01.05.2026.') },
    { name: 'a.txt', text: AMENDMENT('AB-3', 'подписано обеими сторонами 05.03.2026.', '1. Общая стоимость поставки составляет 120 000 рублей.\n\n2. Соглашение вступает в силу с момента подписания.') },
  ];
  assert.equal(row(run(files, '2026-03-10'), 'AB-3').amount.value, 120000);
  assert.equal(row(run(files, '2026-03-04'), 'AB-3').amount.value, 100000);
});

test('нет суммы и срока — «нет данных», документ без номера договора — отдельно', () => {
  const files = [
    { name: 'c.txt', text: 'ДОГОВОР ПОСТАВКИ № AB-4\nСтатус: подписан обеими сторонами 01.02.2026.\n\n1.1. Поставщик: ООО «Бета».\n' },
    { name: 'x.txt', text: 'ПИСЬМО\nПросим перенести срок поставки на 01.07.2026.\n' },
  ];
  const res = run(files);
  const r = row(res, 'AB-4');
  assert.equal(r.amount.status, 'missing');
  assert.equal(r.delivery.status, 'missing');
  assert.equal(S.fmtDate(r.delivery.value), 'нет данных');
  assert.deepEqual(res.unlinked.map((u) => u.fileName), ['x.txt']);
});

test('два разных значения суммы в договоре — требует проверки, значение не выбирается', () => {
  const files = [{
    name: 'c.txt',
    text: CONTRACT('AB-5', 'ООО «Альфа»', 'Общая стоимость поставки составляет 100 000 рублей. Итоговая стоимость договора составляет 110 000 рублей.', 'Поставщик обязуется поставить товар не позднее 01.05.2026.'),
  }];
  const r = row(run(files), 'AB-5');
  assert.equal(r.amount.value, null);
  assert.equal(r.amount.status, 'review');
  assert.equal(r.amount.candidates.length, 2);
});
