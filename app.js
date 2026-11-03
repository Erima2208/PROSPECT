(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const LS = { cfg: 'prospectia_cfg', data: 'prospectia_prospects' };
  const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
  const PHONE_RE = /(?:\+225[\s.-]?)?0\d(?:[\s.-]?\d{2}){4}/g;
  const BAD_MAIL = /\.(png|jpe?g|gif|svg|webp|css|js)$|^(example|test|sentry|noreply|no-reply)@|wixpress|sentry\./i;
  const STATUS = ['nouveau', 'contacte', 'qualifie', 'client'];
  const SIG_IDS = ['sigName', 'sigTitle', 'sigPhone', 'sigEmail', 'sigSite'];

  let prospects = load(LS.data, []);
  const selected = new Set();
  let emailTarget = null, bulkMode = false, sending = false, abort = false;

  function load(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }
  function save() { localStorage.setItem(LS.data, JSON.stringify(prospects)); }
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uniq = a => [...new Set(a)];
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const domain = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
  const backend = () => $('backendUrl').value.trim().replace(/\/$/, '');

  function extract(text) {
    const emails = uniq((text.match(EMAIL_RE) || []).map(e => e.toLowerCase()).filter(e => !BAD_MAIL.test(e)));
    const phones = uniq((text.match(PHONE_RE) || []).map(p => p.replace(/\s+/g, ' ').trim()));
    return { emails, phones };
  }

  // ---- Config & signature ----
  function loadConfig() {
    const c = load(LS.cfg, {});
    ['apiKey', 'cxId', 'backendUrl', ...SIG_IDS].forEach(id => { if (c[id]) $(id).value = c[id]; });
  }
  $('saveConfig').onclick = () => {
    const c = {};
    ['apiKey', 'cxId', 'backendUrl', ...SIG_IDS].forEach(id => c[id] = $(id).value.trim());
    localStorage.setItem(LS.cfg, JSON.stringify(c));
    const s = $('configStatus'); s.textContent = '✔ Sauvegardé'; s.className = 'status ok';
    setTimeout(() => s.textContent = '', 2500);
  };

  function signature() {
    const v = id => $(id).value.trim();
    const name = v('sigName');
    if (!name) return { html: '', text: '' };
    const title = v('sigTitle'), phone = v('sigPhone'), mail = v('sigEmail');
    let site = v('sigSite'); if (site && !/^https?:\/\//i.test(site)) site = 'https://' + site;
    const row = (icon, val) => val ? `<div style="color:#475569;font-size:12px;margin-top:3px">${icon} ${esc(val)}</div>` : '';
    const html = `<table cellpadding="0" cellspacing="0" style="margin-top:20px;font-family:Arial,sans-serif"><tr>
      <td style="width:4px;background-color:#6366f1;background-image:linear-gradient(180deg,#6366f1,#ec4899,#f59e0b)"></td>
      <td style="padding-left:12px">
        <div style="font-weight:700;font-size:15px;color:#1e293b">${esc(name)}</div>
        ${title ? `<div style="color:#6366f1;font-size:13px;font-weight:600">${esc(title)}</div>` : ''}
        ${row('📞', phone)}${row('✉️', mail)}
        ${site ? `<div style="margin-top:3px;font-size:12px"><a href="${esc(site)}" style="color:#ec4899;text-decoration:none">${esc(site)}</a></div>` : ''}
      </td></tr></table>`;
    const text = '\n\n--\n' + [name, title, phone, mail, site].filter(Boolean).join('\n');
    return { html, text };
  }

  // ---- Scan ----
  const progress = msg => { const p = $('searchProgress'); p.classList.remove('hidden'); p.textContent = msg; };

  async function googleSearch(q, num, key, cx) {
    const url = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(key)}&cx=${encodeURIComponent(cx)}&q=${encodeURIComponent(q)}&num=${num}&hl=fr`;
    const r = await fetch(url);
    const j = await r.json();
    if (!r.ok) throw new Error(j.error?.message || `Erreur Google ${r.status}`);
    return j.items || [];
  }
  async function deepScan(url) {
    const r = await fetch(`${backend()}/scrape`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
    if (!r.ok) throw new Error('Backend ' + r.status);
    return r.json();
  }

  $('startSearch').onclick = async () => {
    const key = $('apiKey').value.trim(), cx = $('cxId').value.trim();
    if (!key || !cx) return progress('⚠️ Renseignez la clé API et l’ID CX puis sauvegardez.');
    const kws = $('keywords').value.split(',').map(s => s.trim()).filter(Boolean);
    if (!kws.length) return progress('⚠️ Aucun mot-clé.');
    const loc = $('location').value.trim();
    const num = Math.min(10, Math.max(1, +$('maxResults').value || 5));
    const deep = $('deepScan').checked;
    const btn = $('startSearch'); btn.disabled = true;
    let added = 0;
    try {
      for (let i = 0; i < kws.length; i++) {
        progress(`🔍 (${i + 1}/${kws.length}) « ${kws[i]} »… ${added} nouveau(x)`);
        let items;
        try { items = await googleSearch(`${kws[i]} ${loc}`, num, key, cx); }
        catch (e) { progress('❌ ' + e.message); if (/quota|limit/i.test(e.message)) break; continue; }
        for (const it of items) {
          const dom = domain(it.link);
          if (prospects.some(p => p.domain === dom)) continue;
          const f = extract(`${it.title} ${it.snippet}`);
          const p = { id: crypto.randomUUID(), name: it.title, url: it.link, domain: dom, snippet: it.snippet || '', keyword: kws[i], emails: f.emails, phones: f.phones, status: 'nouveau', date: new Date().toISOString() };
          if (deep) {
            progress(`🔬 Visite de ${dom}…`);
            try { const d = await deepScan(it.link); p.emails = uniq([...p.emails, ...(d.emails || [])]); p.phones = uniq([...p.phones, ...(d.phones || [])]); } catch { /* backend off */ }
          }
          prospects.unshift(p); added++;
        }
        save(); render();
        await sleep(300);
      }
      progress(`✅ Scan terminé — ${added} nouveau(x) prospect(s).`);
    } finally { btn.disabled = false; }
  };

  // ---- Liste ----
  function visible() {
    const txt = $('filterText').value.toLowerCase(), st = $('filterStatus').value;
    return prospects.filter(p => (!st || p.status === st) &&
      (!txt || [p.name, p.domain, p.snippet, p.keyword, ...p.emails, ...p.phones].join(' ').toLowerCase().includes(txt)));
  }
  function updateBulk() {
    const n = prospects.filter(p => selected.has(p.id) && p.emails.length).length;
    $('bulkBtn').textContent = `📨 Envoi groupé (${n})`;
    $('bulkBtn').disabled = n === 0;
  }
  function render() {
    const list = visible();
    $('countBadge').textContent = prospects.length;
    $('stats').innerHTML = STATUS.map(s => `<span class="chip ${s}">${s} · ${prospects.filter(p => p.status === s).length}</span>`).join('');
    const box = $('resultsList');
    box.innerHTML = list.length ? list.map((p, i) => `
      <div class="card ${p.status} ${selected.has(p.id) ? 'selected' : ''}" data-id="${p.id}" style="animation-delay:${Math.min(i, 12) * 40}ms">
        <div class="card-head">
          ${p.emails.length ? `<input type="checkbox" data-act="sel" ${selected.has(p.id) ? 'checked' : ''} aria-label="Sélectionner">` : ''}
          <div><h3>${esc(p.name)}</h3>
          <a href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">${esc(p.domain)}</a></div>
        </div>
        <p class="meta">${esc(p.snippet)}</p>
        <div class="tags">
          <span class="tag">🏷️ ${esc(p.keyword)}</span>
          ${p.emails.map(e => `<span class="tag">✉️ ${esc(e)}</span>`).join('')}
          ${p.phones.map(t => `<span class="tag">📞 ${esc(t)}</span>`).join('')}
        </div>
        <div class="card-actions">
          <select data-act="status">${STATUS.map(s => `<option value="${s}" ${p.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
          ${p.emails.length ? `<button data-act="mail">✉️ Email</button>` : ''}
          ${p.phones[0] ? `<a href="tel:${esc(p.phones[0].replace(/[^\d+]/g, ''))}"><button>📞 Appeler</button></a>` : ''}
          <button data-act="del" class="btn-danger">✕</button>
        </div>
      </div>`).join('') : '<div class="empty">Aucun prospect. Lancez un scan 🚀</div>';
    updateBulk();
  }

  $('resultsList').addEventListener('click', e => {
    const b = e.target.closest('[data-act]'); if (!b || b.tagName === 'SELECT') return;
    const p = prospects.find(x => x.id === b.closest('.card').dataset.id); if (!p) return;
    if (b.dataset.act === 'sel') { b.checked ? selected.add(p.id) : selected.delete(p.id); b.closest('.card').classList.toggle('selected', b.checked); updateBulk(); return; }
    if (b.dataset.act === 'del') { prospects = prospects.filter(x => x !== p); selected.delete(p.id); save(); render(); }
    if (b.dataset.act === 'mail') openEmail([p], false);
  });
  $('resultsList').addEventListener('change', e => {
    if (e.target.dataset.act !== 'status') return;
    const p = prospects.find(x => x.id === e.target.closest('.card').dataset.id);
    if (p) { p.status = e.target.value; save(); render(); }
  });
  $('filterText').oninput = render;
  $('filterStatus').onchange = render;
  $('selectAll').onchange = e => {
    visible().filter(p => p.emails.length).forEach(p => e.target.checked ? selected.add(p.id) : selected.delete(p.id));
    render();
  };
  $('clearAll').onclick = () => { if (prospects.length && confirm('Effacer tous les prospects ?')) { prospects = []; selected.clear(); save(); render(); } };

  $('exportCsv').onclick = () => {
    const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = [['Nom', 'Site', 'Emails', 'Téléphones', 'Mot-clé', 'Statut', 'Date']].concat(
      prospects.map(p => [p.name, p.url, p.emails.join(' | '), p.phones.join(' | '), p.keyword, p.status, p.date]));
    const blob = new Blob(['\ufeff' + rows.map(r => r.map(q).join(';')).join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `prospects_${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    URL.revokeObjectURL(a.href);
  };

  // ---- Email (simple + groupé) ----
  let queue = [];
  function openEmail(list, bulk) {
    queue = list; bulkMode = bulk; abort = false;
    $('emailTitle').textContent = bulk ? '📨 Envoi groupé' : '✉️ Envoyer un email';
    $('emailToLabel').textContent = bulk ? `${list.length} destinataire(s) — un email individuel par prospect` : `À : ${list[0].emails[0]} — ${list[0].name}`;
    $('delayWrap').classList.toggle('hidden', !bulk);
    $('emailStatus').classList.add('hidden');
    $('emailModal').classList.remove('hidden');
  }
  const closeEmail = () => { if (!sending) $('emailModal').classList.add('hidden'); };
  $('bulkBtn').onclick = () => {
    const list = prospects.filter(p => selected.has(p.id) && p.emails.length);
    if (list.length) openEmail(list, true);
  };
  $('cancelEmailBtn').onclick = () => { if (sending) { abort = true; } else closeEmail(); };
  $('emailModal').addEventListener('click', e => { if (e.target.id === 'emailModal') closeEmail(); });

  async function sendOne(p, subject, body, sig) {
    const fill = s => s.replace(/\{\{entreprise\}\}/gi, p.domain);
    const b = fill(body);
    const html = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#1e293b">${esc(b).replace(/\n/g, '<br>')}</div>${sig.html}`;
    const r = await fetch(`${backend()}/send-email`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: p.emails[0], subject: fill(subject), body: b + sig.text, html })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Erreur ' + r.status);
    if (p.status === 'nouveau') p.status = 'contacte';
    save(); render();
  }

  $('sendEmailBtn').onclick = async () => {
    if (sending || !queue.length) return;
    const subject = $('emailSubject').value.trim(), body = $('emailBody').value;
    if (!subject || !body.trim()) return;
    if (bulkMode && !confirm(`Envoyer ${queue.length} email(s) ?`)) return;
    const st = $('emailStatus'); st.classList.remove('hidden');
    const sig = signature(), delay = Math.max(5, +$('emailDelay').value || 20);
    sending = true; abort = false; $('sendEmailBtn').disabled = true; $('cancelEmailBtn').textContent = bulkMode ? '⏹ Arrêter' : 'Annuler';
    let ok = 0, fail = 0;
    for (let i = 0; i < queue.length && !abort; i++) {
      st.textContent = `📤 ${i + 1}/${queue.length} → ${queue[i].emails[0]}`;
      try { await sendOne(queue[i], subject, body, sig); ok++; selected.delete(queue[i].id); }
      catch (e) { fail++; st.textContent = '❌ ' + e.message; if (!bulkMode) break; await sleep(1500); }
      if (bulkMode && i < queue.length - 1) {
        for (let s = delay; s > 0 && !abort; s--) { st.textContent = `✅ ${ok} envoyé(s) · ❌ ${fail} · prochain dans ${s}s (${i + 2}/${queue.length})`; await sleep(1000); }
      }
    }
    st.textContent = `${abort ? '⏹ Arrêté' : '🎉 Terminé'} — ${ok} envoyé(s), ${fail} échec(s).`;
    sending = false; $('sendEmailBtn').disabled = false; $('cancelEmailBtn').textContent = 'Fermer';
    render();
  };

  loadConfig(); render();
})();
