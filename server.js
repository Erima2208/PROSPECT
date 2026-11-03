require('dotenv').config();
const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
const dns = require('dns').promises;
const net = require('net');

const app = express();
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.use(express.json({ limit: '500kb' }));

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const PHONE_RE = /(?:\+225[\s.-]?)?0\d(?:[\s.-]?\d{2}){4}/g;
const BAD_MAIL = /\.(png|jpe?g|gif|svg|webp|css|js)$|^(example|test|sentry|noreply|no-reply)@|wixpress|sentry\./i;

function isPrivate(ip) {
  return /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(ip) ||
    ip === '::1' || /^f[cd]/i.test(ip) || /^fe80/i.test(ip);
}
async function safeUrl(u) {
  const url = new URL(u);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Protocole refusé');
  if (!net.isIP(url.hostname)) {
    const { address } = await dns.lookup(url.hostname);
    if (isPrivate(address)) throw new Error('Hôte privé refusé');
  } else if (isPrivate(url.hostname)) throw new Error('Hôte privé refusé');
  return url;
}
async function getText(u) {
  const url = await safeUrl(u);
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 ProspectIA' } });
    if (!r.ok || !/text\/html|text\/plain/.test(r.headers.get('content-type') || '')) return '';
    return (await r.text()).slice(0, 1_500_000);
  } finally { clearTimeout(t); }
}
const clean = html => html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/mailto:/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ');

app.post('/scrape', async (req, res) => {
  try {
    const base = await safeUrl(req.body.url);
    const pages = [base.href];
    for (const p of ['/contact', '/contactez-nous', '/nous-contacter', '/a-propos']) pages.push(new URL(p, base).href);
    let raw = '';
    for (const p of pages) { try { raw += ' ' + await getText(p); } catch { /* page absente */ } }
    const text = clean(raw) + ' ' + raw; // garde aussi le HTML brut pour les liens mailto/tel
    const emails = [...new Set((text.match(EMAIL_RE) || []).map(e => e.toLowerCase()).filter(e => !BAD_MAIL.test(e)))].slice(0, 10);
    const phones = [...new Set((clean(raw).match(PHONE_RE) || []).map(p => p.replace(/\s+/g, ' ').trim()))].slice(0, 10);
    res.json({ emails, phones });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

let transporter;
function mailer() {
  if (!transporter) {
    const port = +process.env.SMTP_PORT || 465;
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST, port, secure: port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
  }
  return transporter;
}

app.post('/send-email', async (req, res) => {
  const { to, subject, body, html } = req.body || {};
  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to) || !subject || !body) return res.status(400).json({ error: 'Champs invalides' });
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER) return res.status(500).json({ error: 'SMTP non configuré (.env)' });
  try {
    await mailer().sendMail({
      from: `"${process.env.FROM_NAME || 'ProspectIA'}" <${process.env.SMTP_USER}>`,
      to, subject, text: body, html: html || undefined
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/health', (_, res) => res.json({ ok: true }));
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`ProspectIA backend → http://localhost:${PORT}`));
