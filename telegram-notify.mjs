#!/usr/bin/env node

import { readFileSync, existsSync } from 'fs';
import dotenv from 'dotenv';

dotenv.config();

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TRACKER_PATH = 'data/applications.md';
const PIPELINE_PATH = 'data/pipeline.md';
const REPORTS_DIR = 'reports';

function resolveReportPath(reportCol) {
  const m = reportCol.match(/\]\(\.\.\/reports\/([^)]+)\)/);
  if (m) return m[1];
  const m2 = reportCol.match(/\]\(reports\/([^)]+)\)/);
  return m2 ? m2[1] : null;
}

function extractReportUrl(reportPath) {
  const fullPath = `${REPORTS_DIR}/${reportPath}`;
  if (!existsSync(fullPath)) return null;
  const content = readFileSync(fullPath, 'utf-8');
  const m = content.match(/\*\*URL:\*\*\s*(https?:\/\/\S+)/);
  return m ? m[1] : null;
}

function parseTracker() {
  if (!existsSync(TRACKER_PATH)) return { today: [], all: [] };
  const text = readFileSync(TRACKER_PATH, 'utf-8');
  const lines = text.split('\n').filter(l => l.trim().startsWith('|') && !l.includes('| # |') && !l.includes('|---|'));

  const today = new Date().toISOString().slice(0, 10);
  const entries = [];

  for (const line of lines) {
    const cols = line.split('|').map(c => c.trim()).filter(Boolean);
    if (cols.length < 9) continue;
    const [num, date, company, role, score, status, pdf, report, notes] = cols;
    entries.push({ num, date, company, role, score, status, pdf, report, notes });
  }

  return {
    today: entries.filter(e => e.date === today),
    all: entries,
  };
}

function parsePipeline() {
  if (!existsSync(PIPELINE_PATH)) return { pending: 0, processed: 0 };
  const text = readFileSync(PIPELINE_PATH, 'utf-8');

  const pendientesIdx = text.indexOf('## Pendientes');
  const procesadasIdx = text.indexOf('## Procesadas');

  let pending = 0;
  let processed = 0;

  if (procesadasIdx !== -1) {
    const procesadasSection = text.slice(procesadasIdx);
    processed = (procesadasSection.match(/- \[x\]/g) || []).length;
  }

  if (pendientesIdx !== -1) {
    const pendientesSection = text.slice(pendientesIdx, procesadasIdx !== -1 ? procesadasIdx : undefined);
    pending = (pendientesSection.match(/- \[ \]/g) || []).length;
  }

  return { pending, processed };
}

function scoreToEmoji(scoreStr) {
  const s = parseFloat(scoreStr);
  if (s >= 4.5) return '⭐⭐⭐';
  if (s >= 4.0) return '⭐⭐';
  if (s >= 3.5) return '⭐';
  if (s >= 3.0) return '🟢';
  if (s >= 2.5) return '🟡';
  return '⚪';
}

function parseScore(scoreStr) {
  return parseFloat(scoreStr) || 0;
}

function buildMessage() {
  const { today, all } = parseTracker();
  const { pending } = parsePipeline();

  let msg = `🤖 *Career-Ops Daily — ${new Date().toISOString().slice(0, 10)}*\n\n`;

  if (today.length === 0) {
    msg += '_No new evaluations today._\n';
    if (pending > 0) {
      msg += `📦 *${pending} role(s) pending* in pipeline — run evaluation to get scores.\n`;
    }
    const total = all.length;
    msg += `\n📊 Total evaluated: *${total} roles* tracked.\n`;
    sendTelegram(msg);
    return;
  }

  const sortByScore = (a, b) => parseScore(b.score) - parseScore(a.score);

  const strong = today.filter(e => parseScore(e.score) >= 3.5).sort(sortByScore);
  const decent = today.filter(e => parseScore(e.score) >= 2.5 && parseScore(e.score) < 3.5).sort(sortByScore);
  const weak = today.filter(e => parseScore(e.score) < 2.5 && e.status !== 'SKIP').sort(sortByScore);
  const skipped = today.filter(e => e.status === 'SKIP').sort(sortByScore);

  if (strong.length > 0) {
    msg += `🔥 *Strong Matches (≥ 3.5)* — ${strong.length}\n`;
    for (const e of strong) {
      const emoji = scoreToEmoji(e.score);
      const fullScore = e.score.endsWith('/5') ? e.score : `${e.score}/5`;
      const reportPath = resolveReportPath(e.report);
      const applyUrl = reportPath ? extractReportUrl(reportPath) : null;
      const entryText = `${emoji} *${esc(e.company)}* — ${esc(e.role)}\n   ${fullScore} | ${esc(e.notes)}\n   🔗 ${esc(applyUrl || 'N/A')}\n\n`;
      msg += entryText;
    }
  }

  if (decent.length > 0) {
    msg += `👀 *Worth a Look (2.5–3.4)* — ${decent.length}\n`;
    for (const e of decent) {
      const fullScore = e.score.endsWith('/5') ? e.score : `${e.score}/5`;
      msg += `• *${esc(e.company)}* — ${esc(e.role)} — ${fullScore}\n`;
    }
    msg += '\n';
  }

  if (skipped.length > 0) {
    msg += `❌ *Skipped* — ${skipped.length}\n`;
    for (const e of skipped) {
      const fullScore = e.score.endsWith('/5') ? e.score : `${e.score}/5`;
      msg += `• ${esc(e.company)} — ${esc(e.role)} — ${fullScore}\n`;
    }
    msg += '\n';
  }

  if (weak.length > 0) {
    msg += `⚪ *Below Threshold (< 2.5)* — ${weak.length}\n`;
    msg += '\n';
  }

  if (pending > 0) {
    msg += `📦 *${pending} role(s) still pending* in pipeline — awaiting evaluation.\n`;
  }

  const tracked = all.length;
  msg += `📊 *${tracked} total roles* tracked to date.\n`;
  msg += '\n_Run telegram-notify.mjs after each pipeline evaluation for updates._';

  return msg;
}

const MAX_MSG = 3900;

function esc(t) {
  return (t || '').replace(/_/g, '\\_').replace(/\*/g, '\\*').replace(/~/g, '\\~').replace(/`/g, '\\`');
}

function splitMessage(text) {
  if (text.length <= MAX_MSG) return [text];
  const parts = [];
  let remaining = text;
  while (remaining.length > MAX_MSG) {
    let splitAt = remaining.lastIndexOf('\n\n', MAX_MSG);
    if (splitAt < MAX_MSG / 2) splitAt = remaining.lastIndexOf('\n', MAX_MSG);
    if (splitAt < MAX_MSG / 2) splitAt = MAX_MSG;
    parts.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining.length > 0) parts.push(remaining);
  return parts;
}

async function sendTelegram(message) {
  const parts = splitMessage(message);
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;

  for (let i = 0; i < parts.length; i++) {
    const text = parts.length > 1 ? `(${i + 1}/${parts.length}) ${parts[i]}` : parts[i];
    const body = JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    });

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const data = await res.json();
    if (!data.ok) {
      console.error('Telegram API error:', data.description || JSON.stringify(data));
      process.exit(1);
    }
  }
  console.log(`Notification sent (${parts.length} part(s)).`);
}

async function main() {
  if (!TELEGRAM_TOKEN) {
    console.error('TELEGRAM_BOT_TOKEN not set in .env');
    process.exit(1);
  }
  if (!TELEGRAM_CHAT_ID) {
    console.error('TELEGRAM_CHAT_ID not set in .env');
    process.exit(1);
  }

  const msg = buildMessage();
  await sendTelegram(msg);
}

main();
