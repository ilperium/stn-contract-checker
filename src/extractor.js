/*
 * Извлечение и сверка условий договоров поставки из TXT.
 * Только правила и регулярные выражения, без LLM и сетевых вызовов.
 * Один файл работает и в браузере (window.STN), и в Node (require) — для тестов.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.STN = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DATE_SRC = String.raw`(\d{2})\.(\d{2})\.(\d{4})`;
  const CONTRACT_NO = /[A-ZА-ЯЁ]{2,}[-‑–]\d+/g;
  // Число с разделителями разрядов, необязательная расшифровка прописью в скобках, затем «руб»/«₽».
  const MONEY = /(\d{1,3}(?:[   ]\d{3})+|\d+)(?:,(\d{1,2}))?\s*(?:\([^)]*\)\s*)?(?:руб|₽)/i;
  // «поставка», «поставить», но не «поставщик». \b в JS не работает с кириллицей.
  const DELIVERY_WORD = /(^|[^а-яё])постав(?!щик)/i;
  const NOT_DELIVERY = /оплат|приемк|приёмк|аванс/i;
  const NOT_TOTAL = /аванс|лимит|бюджет|не является|предоплат/i;

  // ---------- базовые утилиты ----------

  function isoDates(s) {
    return [...s.matchAll(new RegExp(DATE_SRC, 'g'))].map((m) => `${m[3]}-${m[2]}-${m[1]}`);
  }

  function fmtDate(iso) {
    if (!iso) return 'нет данных';
    const [y, m, d] = iso.split('-');
    return `${d}.${m}.${y}`;
  }

  function fmtMoney(v) {
    if (v == null) return 'нет данных';
    const [int, frac] = v.toFixed(2).split('.');
    return int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + (frac === '00' ? '' : ',' + frac) + ' ₽';
  }

  function normNo(s) {
    return s.replace(/[‑–]/g, '-').toUpperCase();
  }

  function normParty(s) {
    return (s || '').toLowerCase().replace(/[«»"']/g, '').replace(/\s+/g, ' ').trim();
  }

  // Абзац = непустая строка файла. Номер абзаца — для перехода к источнику.
  function splitParagraphs(text) {
    const out = [];
    text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n').forEach((line) => {
      const t = line.trim();
      if (t) out.push({ n: out.length + 1, text: t });
    });
    return out;
  }

  // Предложения — точные подстроки абзаца, чтобы цитату можно было найти в тексте как есть.
  function splitSentences(text) {
    return text.split(/(?<=[.!?])\s+(?=[«А-ЯЁA-Z])/).map((s) => s.trim()).filter(Boolean);
  }

  function* sentences(doc) {
    for (const p of doc.paragraphs) for (const s of splitSentences(p.text)) yield { p: p.n, quote: s };
  }

  function distinct(cands, key) {
    const seen = new Map();
    for (const c of cands) if (!seen.has(c[key])) seen.set(c[key], c);
    return [...seen.values()];
  }

  // ---------- извлечение полей из одного документа ----------

  // ignored — суммы, похожие на стоимость, но отброшенные правилом (аванс, лимит): показываем для прозрачности.
  function extractAmounts(doc) {
    const out = [];
    doc.amountsIgnored = [];
    for (const { p, quote } of sentences(doc)) {
      const m = MONEY.exec(quote);
      if (!m) continue;
      if (NOT_TOTAL.test(quote)) { doc.amountsIgnored.push({ p, quote }); continue; }
      if (!/стоимост/i.test(quote)) continue;
      const value = Number(m[1].replace(/\D/g, '')) + (m[2] ? Number(m[2].padEnd(2, '0')) / 100 : 0);
      out.push({ value, p, quote });
    }
    return out;
  }

  function pickDate(s) {
    const pref = [...s.matchAll(new RegExp(String.raw`(?:^|[\s(])(?:не позднее|не позже|до|по|на)\s+` + DATE_SRC, 'gi'))];
    if (pref.length) {
      const m = pref[pref.length - 1];
      return `${m[3]}-${m[2]}-${m[1]}`;
    }
    const all = isoDates(s);
    return all.length === 1 ? all[0] : null;
  }

  function extractDeliveries(doc) {
    const found = [];
    const unclear = [];
    const ignored = [];
    for (const { p, quote } of sentences(doc)) {
      if (NOT_DELIVERY.test(quote) && isoDates(quote).length) { ignored.push({ p, quote }); continue; }
      if (!DELIVERY_WORD.test(quote) || NOT_DELIVERY.test(quote)) continue;
      if (/^(Дата|Статус)\b/i.test(quote)) continue;
      const iso = pickDate(quote);
      if (iso) found.push({ value: iso, p, quote });
      else if (isoDates(quote).length || /срок|не позднее|в течение/i.test(quote)) unclear.push({ p, quote });
    }
    return { found, unclear, ignored };
  }

  function extractParty(doc, labels) {
    const re = new RegExp(String.raw`(?:${labels.join('|')})\s*:\s*([^\n.;]*?«[^»]+»|[^\n.;]+)`, 'i');
    for (const { p, quote } of sentences(doc)) {
      const m = re.exec(quote);
      if (m) return { value: m[1].trim(), p, quote };
    }
    return null;
  }

  function findParagraph(doc, re) {
    return doc.paragraphs.find((x) => re.test(x.text)) || null;
  }

  function classify(head) {
    const h = head.toUpperCase();
    if (/ПИСЬМО/.test(h)) return 'letter';
    if (/ПРОЕКТ/.test(h)) return 'draft';
    if (/ДОПОЛНИТЕЛЬН\S*\s+СОГЛАШЕНИ/.test(h)) return 'amendment';
    if (/ДОГОВОР/.test(h)) return 'contract';
    return 'unknown';
  }

  function parseDocument(fileName, text) {
    const paragraphs = splitParagraphs(text);
    const head = paragraphs[0] ? paragraphs[0].text : '';
    const doc = { id: fileName, fileName, title: head, paragraphs, type: classify(head) };

    const dateP = findParagraph(doc, /^Дата(?:\s+\S+)?\s*:/i);
    doc.date = dateP ? isoDates(dateP.text)[0] || null : null;

    const statusP = findParagraph(doc, /^Статус\s*:/i);
    doc.status = statusP ? { p: statusP.n, quote: statusP.text } : null;
    if (!statusP) doc.signed = null;
    else if (/не\s+подписан|проект/i.test(statusP.text)) doc.signed = false;
    else if (/подписан\S*\s+обеими\s+сторонами/i.test(statusP.text)) doc.signed = true;
    else doc.signed = null;
    doc.signDate = doc.signed && statusP ? isoDates(statusP.text)[0] || null : null;

    doc.effective = null;
    for (const s of sentences(doc)) {
      if (!/вступа\S*\s+в\s+(?:законную\s+)?силу/i.test(s.quote)) continue;
      const d = isoDates(s.quote)[0];
      if (d && !/только после/i.test(s.quote)) { doc.effective = { value: d, p: s.p, quote: s.quote }; break; }
      if (/с (?:момента|даты|дня) (?:его |ее |её )?подписания/i.test(s.quote)) { doc.effective = { value: 'onSign', p: s.p, quote: s.quote }; break; }
    }

    if (doc.type === 'contract') {
      const m = /№\s*([A-ZА-ЯЁ]{2,}[-‑–]\d+)/.exec(head);
      const any = head.match(CONTRACT_NO);
      doc.contractNo = m ? normNo(m[1]) : any ? normNo(any[0]) : null;
    }
    doc.refs = [...new Set((text.match(CONTRACT_NO) || []).map(normNo))];

    doc.supplier = extractParty(doc, doc.type === 'letter' ? ['От', 'Поставщик'] : ['Поставщик']);
    doc.amounts = extractAmounts(doc);
    doc.deliveries = extractDeliveries(doc);
    return doc;
  }

  // ---------- статус документа на дату проверки ----------

  const TYPE_LABEL = {
    contract: 'Договор',
    amendment: 'Допсоглашение',
    draft: 'Проект изменения',
    letter: 'Письмо',
    unknown: 'Не распознан',
  };

  // kind: base | applied | pending (не изменяет условия) | review (нельзя решить автоматически)
  function docStatus(doc, checkDate) {
    if (doc.type === 'contract') {
      if (doc.signed === true) return { kind: 'base', label: 'Договор подписан' };
      return { kind: 'review', label: 'Договор: подписание не подтверждено' };
    }
    if (doc.type === 'letter') return { kind: 'pending', label: 'Письмо — предложение, условия не меняет' };
    if (doc.type === 'draft') return { kind: 'pending', label: 'Проект — не подписан, условия не меняет' };
    if (doc.type === 'unknown') return { kind: 'review', label: 'Тип документа не распознан' };

    if (doc.signed === false) return { kind: 'pending', label: 'Допсоглашение не подписано' };
    if (doc.signed !== true) return { kind: 'review', label: 'Статус подписания не определён' };
    let eff = doc.effective ? (doc.effective.value === 'onSign' ? doc.signDate : doc.effective.value) : null;
    if (!eff) return { kind: 'review', label: 'Подписано, но дата вступления в силу не найдена' };
    if (doc.signDate && doc.signDate > eff) eff = doc.signDate;
    if (eff <= checkDate) return { kind: 'applied', label: `Подписано, в силе с ${fmtDate(eff)}`, effective: eff };
    return { kind: 'pending', label: `Подписано, вступает в силу ${fmtDate(eff)} — после даты проверки`, effective: eff };
  }

  // ---------- сверка по договорам ----------

  function src(doc, c) {
    return { docId: doc.id, fileName: doc.fileName, p: c.p, quote: c.quote };
  }

  function baseField(doc, cands, missingNote) {
    const uniq = distinct(cands, 'value');
    if (uniq.length === 0) return { value: null, status: 'missing', note: missingNote, history: [] };
    if (uniq.length > 1) {
      return {
        value: null, status: 'review', note: 'В договоре несколько разных значений',
        candidates: uniq.map((c) => ({ value: c.value, source: src(doc, c) })), history: [],
      };
    }
    return { value: uniq[0].value, status: 'ok', source: src(doc, uniq[0]), history: [] };
  }

  function applyAmendments(field, applied, pick) {
    let lastEff = null;
    let lastDoc = null;
    for (const { doc, st } of applied) {
      const uniq = distinct(pick(doc), 'value');
      if (!uniq.length) continue;
      if (uniq.length > 1) {
        field.status = 'review';
        field.note = `В ${doc.fileName} несколько разных значений`;
        continue;
      }
      const c = uniq[0];
      if (lastEff === st.effective && field.value !== c.value) {
        field.status = 'review';
        field.note = `${lastDoc.fileName} и ${doc.fileName} вступают в силу одновременно и противоречат друг другу`;
      }
      field.history.push({ value: field.value, source: field.source });
      field.value = c.value;
      field.source = src(doc, c);
      field.changedBy = { docId: doc.id, fileName: doc.fileName, title: doc.title, effective: st.effective };
      if (field.status === 'missing') field.status = 'ok';
      lastEff = st.effective;
      lastDoc = doc;
    }
  }

  function analyze(docs, checkDate) {
    const statuses = new Map(docs.map((d) => [d.id, docStatus(d, checkDate)]));
    const contracts = new Map();
    for (const d of docs) {
      if (d.type !== 'contract' || !d.contractNo) continue;
      if (!contracts.has(d.contractNo)) contracts.set(d.contractNo, []);
      contracts.get(d.contractNo).push(d);
    }

    // Привязка документов к договору — только по номеру договора в тексте.
    const links = new Map();
    for (const d of docs) {
      if (d.type === 'contract') {
        links.set(d.id, d.contractNo ? { contractNo: d.contractNo } : { contractNo: null, reason: 'Номер договора не найден' });
        continue;
      }
      const known = d.refs.filter((no) => contracts.has(no));
      if (known.length === 1) links.set(d.id, { contractNo: known[0] });
      else if (known.length > 1) links.set(d.id, { contractNo: null, reason: `Упомянуто несколько договоров: ${known.join(', ')}` });
      else if (d.refs.length) links.set(d.id, { contractNo: null, reason: `Договор ${d.refs.join(', ')} не загружен` });
      else links.set(d.id, { contractNo: null, reason: 'Номер договора в тексте не найден' });
    }

    const rows = [];
    for (const [no, list] of contracts) {
      const contract = list[0];
      const flags = [];
      if (list.length > 1) flags.push(`Загружено ${list.length} файла с договором ${no}: ${list.map((d) => d.fileName).join(', ')} — использован первый`);
      const cst = statuses.get(contract.id);
      if (cst.kind === 'review') flags.push(cst.label);

      const related = docs.filter((d) => d.type !== 'contract' && links.get(d.id).contractNo === no);
      const supplierNorm = normParty(contract.supplier && contract.supplier.value);
      for (const d of related) {
        if (d.supplier && supplierNorm && normParty(d.supplier.value) !== supplierNorm) {
          flags.push(`${d.fileName}: поставщик «${d.supplier.value}» не совпадает с договором`);
        }
      }

      const applied = related
        .map((doc) => ({ doc, st: statuses.get(doc.id) }))
        .filter((x) => x.st.kind === 'applied')
        .sort((a, b) => (a.st.effective + (a.doc.date || '')).localeCompare(b.st.effective + (b.doc.date || '')));

      const amount = baseField(contract, contract.amounts, 'Сумма в тексте договора не найдена');
      applyAmendments(amount, applied, (d) => d.amounts);
      amount.ignored = contract.amountsIgnored.map((c) => src(contract, c));

      const delivery = baseField(contract, contract.deliveries.found, 'Срок поставки в тексте договора не найден');
      if (delivery.status === 'missing' && contract.deliveries.unclear.length) {
        delivery.status = 'review';
        delivery.note = 'Срок указан без конкретной даты — нужна ручная проверка';
        delivery.candidates = contract.deliveries.unclear.map((c) => ({ value: null, source: src(contract, c) }));
      }
      applyAmendments(delivery, applied, (d) => d.deliveries.found);
      delivery.ignored = contract.deliveries.ignored.map((c) => src(contract, c));

      // Предложения и документы, которые нельзя применить автоматически.
      const proposals = [];
      for (const doc of related) {
        const st = statuses.get(doc.id);
        if (st.kind === 'applied') continue;
        const push = (field, cands) => distinct(cands, 'value').forEach((c) => proposals.push({
          field, value: c.value, kind: st.kind, label: st.label, source: src(doc, c),
        }));
        push('amount', doc.amounts);
        push('delivery', doc.deliveries.found);
        if (st.kind === 'review') {
          flags.push(`${doc.fileName}: ${st.label}`);
          for (const f of [['amount', amount], ['delivery', delivery]]) {
            if (proposals.some((x) => x.field === f[0] && x.source.docId === doc.id) && f[1].status === 'ok') {
              f[1].status = 'review';
              f[1].note = `${doc.fileName} может изменять значение: ${st.label.toLowerCase()}`;
            }
          }
        }
      }

      rows.push({
        contractNo: no,
        contractDoc: contract.id,
        supplier: contract.supplier ? { value: contract.supplier.value, status: 'ok', source: src(contract, contract.supplier) } : { value: null, status: 'missing' },
        amount,
        delivery,
        proposals,
        related: related.map((d) => ({ docId: d.id, fileName: d.fileName, title: d.title, status: statuses.get(d.id) })),
        flags,
      });
    }
    rows.sort((a, b) => a.contractNo.localeCompare(b.contractNo, 'ru', { numeric: true }));

    const unlinked = docs
      .filter((d) => !links.get(d.id).contractNo)
      .map((d) => ({ docId: d.id, fileName: d.fileName, title: d.title, reason: links.get(d.id).reason }));

    return {
      checkDate,
      rows,
      unlinked,
      documents: docs.map((d) => ({
        id: d.id, fileName: d.fileName, title: d.title, type: d.type, typeLabel: TYPE_LABEL[d.type],
        status: statuses.get(d.id), contractNo: links.get(d.id).contractNo,
      })),
    };
  }

  // Договоры со сроком поставки раньше даты + несогласованные изменения срока по ним.
  function deliveriesBefore(result, iso) {
    const hits = [];
    const unknown = [];
    for (const r of result.rows) {
      if (r.delivery.value == null) { unknown.push(r); continue; }
      if (r.delivery.value < iso) hits.push({ row: r, pendingDelivery: r.proposals.filter((p) => p.field === 'delivery') });
    }
    return { hits, unknown };
  }

  function parseAll(files) {
    return files.map((f) => parseDocument(f.name, f.text));
  }

  return {
    parseDocument, parseAll, analyze, deliveriesBefore, docStatus,
    splitParagraphs, splitSentences, fmtDate, fmtMoney, TYPE_LABEL,
  };
});
