/* Интерфейс: загрузка файлов, таблица, вопросы, просмотр источника. Вся логика извлечения — в extractor.js. */
(function () {
  'use strict';
  const S = window.STN;
  const $ = (id) => document.getElementById(id);
  const files = new Map(); // имя файла → текст
  let result = null;

  const FIELD = { amount: 'Сумма', delivery: 'Срок поставки' };
  const fmt = (field, v) => (field === 'amount' ? S.fmtMoney(v) : S.fmtDate(v));

  // Безопасная сборка DOM: текст из файлов вставляется только через textContent.
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v);
    }
    for (const k of kids.flat()) if (k != null && k !== false) el.append(k instanceof Node ? k : String(k));
    return el;
  }

  // ---------- загрузка ----------

  async function readFile(file) {
    const buf = await file.arrayBuffer();
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch {
      return new TextDecoder('windows-1251').decode(buf); // частая кодировка русских TXT
    }
  }

  async function addFiles(list) {
    for (const f of list) {
      if (!/\.txt$/i.test(f.name) && f.type !== 'text/plain') continue;
      files.set(f.name, await readFile(f));
    }
    recompute();
  }

  function recompute() {
    const date = $('checkDate').value || '2026-03-10';
    const docs = S.parseAll([...files].map(([name, text]) => ({ name, text })));
    result = files.size ? S.analyze(docs, date) : null;
    render();
  }

  // ---------- рендер ----------

  function cite(source, label) {
    if (!source) return null;
    return h('button', { class: 'cite', title: source.quote, onclick: () => showSource(source) },
      label || `${source.fileName}, абз. ${source.p}`);
  }

  function fieldCell(field, f) {
    const out = [];
    if (f.value != null) out.push(h('div', { class: 'val' }, fmt(field, f.value)));
    else out.push(h('div', { class: 'none' }, 'нет данных'));
    if (f.status === 'review') out.push(h('div', {}, h('span', { class: 'badge warn' }, 'требует проверки')));
    if (f.source) out.push(h('div', {}, cite(f.source)));
    if (f.changedBy) {
      const prev = f.history[f.history.length - 1];
      out.push(h('div', { class: 'small' }, h('span', { class: 'badge ok' }, 'изменено допсоглашением'),
        prev ? [' было ', fmt(field, prev.value), ' · ', cite(prev.source)] : null));
    }
    if (f.note) out.push(h('div', { class: 'small' }, f.note));
    for (const c of f.candidates || []) out.push(h('div', { class: 'small' }, c.value != null ? fmt(field, c.value) + ' — ' : '', cite(c.source)));
    return out;
  }

  function proposalsCell(r) {
    const out = r.proposals.map((p) => h('div', { class: 'item' },
      h('span', { class: p.kind === 'review' ? 'badge bad' : 'badge warn' }, p.kind === 'review' ? 'проверить' : /вступает в силу/.test(p.label) ? 'не вступило в силу' : 'не согласовано'), ' ',
      `${FIELD[p.field]} → `, h('b', {}, fmt(p.field, p.value)),
      h('div', { class: 'small' }, p.label, ' · ', cite(p.source))));
    for (const f of r.flags) out.push(h('div', { class: 'item' }, h('span', { class: 'badge bad' }, 'проверить'), ' ', h('span', { class: 'small' }, f)));
    return out.length ? out : h('span', { class: 'small' }, '—');
  }

  function render() {
    const has = !!result;
    for (const id of ['tableCard', 'askCard', 'docsCard']) $(id).hidden = !has;
    $('clearBtn').disabled = !has;
    if (!has) { $('answer').replaceChildren(); return; }

    $('dateLabel').textContent = S.fmtDate(result.checkDate);
    $('table').tBodies[0].replaceChildren(...result.rows.map((r) => h('tr', {},
      h('td', {}, h('div', { class: 'val' }, r.contractNo), h('div', {}, cite({ docId: r.contractDoc, fileName: r.contractDoc, p: 1, quote: '' }, 'открыть договор'))),
      h('td', {}, r.supplier.value || h('span', { class: 'none' }, 'нет данных')),
      h('td', {}, fieldCell('amount', r.amount)),
      h('td', {}, fieldCell('delivery', r.delivery)),
      h('td', {}, proposalsCell(r)))));
    if (!result.rows.length) $('table').tBodies[0].append(h('tr', {}, h('td', { colspan: 5, class: 'small' }, 'Договоры среди загруженных файлов не найдены.')));

    $('unlinked').replaceChildren(...(result.unlinked.length ? [
      h('h2', { style: 'margin-top:16px' }, 'Не привязаны к договору — требуют проверки'),
      ...result.unlinked.map((u) => h('div', { class: 'item' }, h('span', { class: 'badge bad' }, 'проверить'), ' ',
        cite({ docId: u.docId, fileName: u.fileName, p: 1, quote: u.title }, u.fileName), ' — ', h('span', { class: 'small' }, u.reason))),
    ] : []));

    $('docs').replaceChildren(...result.documents.map((d) => h('li', {},
      cite({ docId: d.id, fileName: d.fileName, p: 1, quote: d.title }, d.fileName),
      h('span', { class: 'badge info' }, d.typeLabel),
      h('span', { class: 'badge ' + ({ base: 'ok', applied: 'ok', pending: 'warn', review: 'bad' })[d.status.kind] }, d.status.label),
      h('span', { class: 'small' }, d.contractNo ? `→ ${d.contractNo}` : 'не привязан'))));

    const sel = $('qContract');
    const prev = sel.value;
    sel.replaceChildren(...result.rows.map((r) => h('option', { value: r.contractNo }, r.contractNo)));
    if (result.rows.some((r) => r.contractNo === prev)) sel.value = prev;
    renderPresets();
    $('answer').replaceChildren();
  }

  // ---------- вопросы ----------

  function renderPresets() {
    const d = S.fmtDate(result.checkDate);
    const presets = [
      { text: `Какой срок поставки действует по договору STN-101 на ${d}?`, run: () => answerField('STN-101', 'delivery') },
      { text: 'Какова сумма договора STN-102?', run: () => answerField('STN-102', 'amount') },
      { text: 'Какова сумма договора STN-103?', run: () => answerField('STN-103', 'amount') },
      { text: 'По каким договорам поставка раньше 01.04.2026 и есть ли несогласованные изменения срока?', run: () => answerBefore('2026-04-01') },
    ];
    $('presets').replaceChildren(...presets.map((p) => h('button', { class: 'btn', onclick: p.run }, p.text)));
  }

  function showAnswer(question, ...blocks) {
    $('answer').replaceChildren(h('p', { class: 'small q' }, question), ...blocks);
  }

  function pendingFor(r, field) {
    return r.proposals.filter((p) => p.field === field).map((p) => h('div', { class: 'small' },
      h('span', { class: 'badge warn' }, 'не учтено'), ` ${p.label}: предлагается ${fmt(field, p.value)} · `, cite(p.source)));
  }

  function answerField(no, field) {
    const q = `${FIELD[field]} по договору ${no} на ${S.fmtDate(result.checkDate)}`;
    const r = result.rows.find((x) => x.contractNo === no);
    if (!r) return showAnswer(q, h('div', { class: 'block' }, h('p', { class: 'lead' }, `Договор ${no} среди загруженных документов не найден.`)));
    const f = r[field];
    const lead = f.value != null ? fmt(field, f.value) : 'нет данных';
    const parts = [h('p', { class: 'lead' }, h('b', {}, lead), f.status === 'review' ? [' ', h('span', { class: 'badge warn' }, 'требует проверки')] : null)];
    if (f.source) parts.push(h('div', {}, 'Основание: ', cite(f.source), ' — «', f.source.quote, '»'));
    if (f.changedBy) {
      const prev = f.history[f.history.length - 1];
      parts.push(h('div', { class: 'small' }, `Изменено документом ${f.changedBy.fileName} (в силе с ${S.fmtDate(f.changedBy.effective)}). `,
        prev ? ['По договору было ', fmt(field, prev.value), ' · ', cite(prev.source)] : null));
    }
    if (f.note) parts.push(h('div', { class: 'small' }, f.note));
    for (const c of f.candidates || []) parts.push(h('div', { class: 'small' }, c.value != null ? fmt(field, c.value) + ' — ' : '', cite(c.source)));
    for (const ig of f.ignored || []) parts.push(h('div', { class: 'small' }, h('span', { class: 'badge info' }, 'не является ' + (field === 'amount' ? 'суммой договора' : 'сроком поставки')), ' «', ig.quote, '» · ', cite(ig)));
    parts.push(...pendingFor(r, field));
    showAnswer(q, h('div', { class: 'block' }, parts));
  }

  function answerBefore(iso) {
    const q = `Поставка раньше ${S.fmtDate(iso)} (по состоянию на ${S.fmtDate(result.checkDate)}) и несогласованные изменения срока`;
    const { hits, unknown } = S.deliveriesBefore(result, iso);
    const blocks = [];
    if (!hits.length) blocks.push(h('div', { class: 'block' }, h('p', { class: 'lead' }, 'Таких договоров нет.')));
    for (const { row: r, pendingDelivery } of hits) {
      blocks.push(h('div', { class: 'block' },
        h('p', { class: 'lead' }, h('b', {}, r.contractNo), ` — ${S.fmtDate(r.delivery.value)}`, r.delivery.status === 'review' ? [' ', h('span', { class: 'badge warn' }, 'требует проверки')] : null),
        h('div', {}, 'Основание: ', cite(r.delivery.source)),
        pendingDelivery.length ? pendingFor(r, 'delivery') : h('div', { class: 'small' }, 'Несогласованных изменений срока нет.')));
    }
    const others = result.rows.filter((r) => !hits.some((x) => x.row === r) && r.proposals.some((p) => p.field === 'delivery'));
    if (others.length) blocks.push(h('div', { class: 'block' }, h('p', { class: 'small' }, 'Несогласованные изменения срока по остальным договорам:'),
      others.map((r) => h('div', {}, h('b', {}, r.contractNo), ` (действует ${S.fmtDate(r.delivery.value)})`, pendingFor(r, 'delivery')))));
    if (unknown.length) blocks.push(h('div', { class: 'block' }, h('span', { class: 'badge bad' }, 'не оценено'), ' Срок не определён: ', unknown.map((r) => r.contractNo).join(', ')));
    showAnswer(q, ...blocks);
  }

  // ---------- источник ----------

  function showSource(source) {
    const text = files.get(source.fileName);
    if (text == null) return;
    $('viewerTitle').textContent = source.fileName;
    $('viewerHint').textContent = source.quote && source.p ? `Абзац ${source.p}` : '';
    let target = null;
    const items = S.splitParagraphs(text).map((p) => {
      const li = h('li', { value: p.n });
      const i = p.n === source.p && source.quote ? p.text.indexOf(source.quote) : -1;
      if (i >= 0) li.append(p.text.slice(0, i), h('mark', {}, source.quote), p.text.slice(i + source.quote.length));
      else li.append(p.text);
      if (p.n === source.p) { li.classList.add('active'); target = li; }
      return li;
    });
    $('viewerBody').replaceChildren(...items);
    if (target) target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    if (window.matchMedia('(max-width: 1180px)').matches) $('viewer').scrollIntoView({ behavior: 'smooth' });
  }

  // ---------- события ----------

  $('fileInput').addEventListener('change', (e) => { addFiles([...e.target.files]); e.target.value = ''; });
  $('checkDate').addEventListener('change', () => files.size && recompute());
  $('clearBtn').addEventListener('click', () => {
    files.clear();
    $('viewerBody').replaceChildren();
    $('viewerTitle').textContent = 'Источник';
    recompute();
  });
  $('qAsk').addEventListener('click', () => answerField($('qContract').value, $('qField').value));
  $('qBeforeBtn').addEventListener('click', () => answerBefore($('qBefore').value));

  const drop = $('drop');
  ['dragenter', 'dragover'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); if (ev === 'drop' || !e.relatedTarget) drop.classList.remove('over'); }));
  document.addEventListener('drop', (e) => addFiles([...e.dataTransfer.files]));

  // Демо-набор доступен, когда страница открыта через http (GitHub Pages или локальный сервер).
  // Это только загрузка тех же TXT из папки documents — дальше они проходят тот же разбор.
  if (location.protocol.startsWith('http')) {
    $('demoBtn').hidden = false;
    $('demoBtn').addEventListener('click', async () => {
      const names = await (await fetch('documents/index.json')).json();
      for (const n of names) files.set(n, await (await fetch('documents/' + encodeURIComponent(n))).text());
      recompute();
    });
  }
})();
