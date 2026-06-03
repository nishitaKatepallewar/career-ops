#!/usr/bin/env node

import { readFileSync, existsSync } from 'fs';
import dotenv from 'dotenv';

dotenv.config();

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const TRACKER_PATH = 'data/applications.md';
const PIPELINE_PATH = 'data/pipeline.md';
const PROFILE_PATH = 'config/profile.yml';

const MAX_MSG = 3900;

function esc(t) {
  return (t || '').replace(/_/g, '\\_').replace(/\*/g, '\\*').replace(/~/g, '\\~').replace(/`/g, '\\`');
}

function parseScore(s) {
  return parseFloat(s) || 0;
}

function scoreToEmoji(s) {
  if (s >= 4.5) return '⭐⭐⭐';
  if (s >= 4.0) return '⭐⭐';
  if (s >= 3.5) return '⭐';
  if (s >= 3.0) return '🟢';
  if (s >= 2.5) return '🟡';
  return '⚪';
}

// ── Read sources of truth ──────────────────────────────────────

function readProfile() {
  if (!existsSync(PROFILE_PATH)) return {};
  const text = readFileSync(PROFILE_PATH, 'utf-8');
  const lines = text.split('\n');
  const ctx = {};
  let section = '';
  for (const line of lines) {
    const m = line.match(/^(\w[\w_]*):\s*(.*)/);
    if (m && !line.startsWith('  ')) {
      section = m[1];
      const val = m[2].trim();
      if (val) ctx[m[1]] = val;
    }
  }
  return ctx;
}

function parseTracker() {
  if (!existsSync(TRACKER_PATH)) return [];
  const text = readFileSync(TRACKER_PATH, 'utf-8');
  const today = new Date().toISOString().slice(0, 10);
  return text.split('\n')
    .filter(l => l.trim().startsWith('|') && !l.includes('| # |') && !l.includes('|---|'))
    .map(l => l.split('|').map(c => c.trim()).filter(Boolean))
    .filter(c => c.length >= 9)
    .map(c => ({ num: c[0], date: c[1], company: c[2], role: c[3], score: c[4], status: c[5], report: c[7], notes: c[8] }))
    .filter(e => e.date === today);
}

function parsePipeline() {
  if (!existsSync(PIPELINE_PATH)) return { pending: 0 };
  const text = readFileSync(PIPELINE_PATH, 'utf-8');
  const pendientesIdx = text.indexOf('## Pendientes');
  const procesadasIdx = text.indexOf('## Procesadas');
  let pending = 0;
  if (pendientesIdx !== -1) {
    const section = text.slice(pendientesIdx, procesadasIdx !== -1 ? procesadasIdx : undefined);
    pending = (section.match(/- \[ \]/g) || []).length;
  }
  return { pending };
}

function readNewScanItems() {
  if (!existsSync(SCAN_HISTORY_PATH)) return [];
  const today = new Date().toISOString().slice(0, 10);
  const lines = readFileSync(SCAN_HISTORY_PATH, 'utf-8').split('\n').filter(Boolean);
  const items = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split('\t');
    if (parts.length < 6) continue;
    const [url, date, portal, title, company, status, location = ''] = parts;
    if (date === today && status === 'added') items.push({ url, title, company, location });
  }
  return items;
}

// ── LLM pre-filter ─────────────────────────────────────────────

function buildLLMPrompt(profile, items) {
  const context = [
    `You are a job match scorer for a candidate.`,
    ``,
    `## Candidate Profile`,
    `Target roles: Software Engineer (New Grad), Forward Deployed Engineer, Applied AI Engineer, AI/ML Engineer, Research Engineer, Backend Engineer, Full Stack Engineer`,
    `Graduation: May 2027 (BTech Computer Engineering, Cummins College, Pune)`,
    `Experience: Google AI Infrastructure Intern (Summer 2025), 9500 LOC`,
    `Skills: Python, Java, C++, TypeScript, JavaScript, Elixir, React, Angular, SQL, PostgreSQL`,
    `Projects: Vexa (AI 3D QC), Cloakr (LLVM obfuscation), Alias (PII redaction)`,
    `Visa: Needs sponsorship for US/EU/UK/SG/AUS/CA. Authorized: India, UAE`,
    `Location preference: India > UAE > US > UK > EU > SG > AUS > CA > Remote (global)`,
    `Comp targets: ₹20-35L India, $100K-160K US, €50K-90K EU`,
    `Top strengths: Full-stack + infra engineering, fast prototyping, AI/ML + systems breadth`,
    ``,
    `For each role below, respond with EXACTLY one line per role:`,
    `{"score": <1-5>, "reason": "<5-word rationale>"}`,
    `Score meaning: 4.5+=perfect, 4.0-4.4=strong match, 3.5-3.9=good, 3.0-3.4=decent, 2.0-2.9=weak, <2.0=skip`,
    ``,
    `Roles:`,
  ];

  for (const item of items) {
    context.push(`- ${item.title} @ ${item.company} (${item.location || 'location unknown'})`);
    context.push(`  URL: ${item.url}`);
  }
  context.push('');
  context.push('JSON lines (one per role, same order):');
  return context.join('\n');
}

async function llmScoreItems(profile, items) {
  if (items.length === 0) return [];
  if (!ANTHROPIC_KEY) {
    console.error('ANTHROPIC_API_KEY not set — cannot LLM pre-filter');
    return items.map(i => ({ ...i, score: 0, reason: 'no API key' }));
  }

  const prompt = buildLLMPrompt(profile, items);

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  const text = data.content?.[0]?.text || '';

  const results = [];
  const lines = text.split('\n').filter(l => l.trim().startsWith('{'));

  for (let i = 0; i < items.length; i++) {
    const parsed = lines[i] ? tryParseJSON(lines[i]) : null;
    results.push({
      ...items[i],
      score: parsed?.score ?? 0,
      reason: parsed?.reason ?? 'parse error',
    });
  }

  return results;
}

function tryParseJSON(s) {
  try { return JSON.parse(s); } catch { return null; }
}

// ── Report URL extraction ──────────────────────────────────────

const REPORTS_DIR = 'reports';

function reportPathFromCol(reportCol) {
  const m = reportCol.match(/\]\(\.\.\/reports\/([^)]+)\)/);
  return m ? m[1] : null;
}

function applyUrlFromReport(reportPath) {
  const fullPath = `${REPORTS_DIR}/${reportPath}`;
  if (!existsSync(fullPath)) return null;
  const text = readFileSync(fullPath, 'utf-8');
  const m = text.match(/\*\*URL:\*\*\s*(https?:\/\/\S+)/);
  return m ? m[1] : null;
}

// ── Message builders ───────────────────────────────────────────

function buildTrackerMessage(today) {
  const { pending } = parsePipeline();
  let msg = `🤖 *Career-Ops Daily — ${new Date().toISOString().slice(0, 10)}*\n\n`;

  const sortByScore = (a, b) => parseScore(b.score) - parseScore(a.score);
  const strong = today.filter(e => parseScore(e.score) >= 3.5).sort(sortByScore);
  const decent = today.filter(e => parseScore(e.score) >= 2.5 && parseScore(e.score) < 3.5).sort(sortByScore);
  const skipped = today.filter(e => e.status === 'SKIP').sort(sortByScore);
  const weak = today.filter(e => parseScore(e.score) < 2.5 && e.status !== 'SKIP').sort(sortByScore);

  if (strong.length > 0) {
    msg += `🔥 *Strong Matches (≥ 3.5)* — ${strong.length}\n`;
    for (const e of strong) {
      const fullScore = e.score.endsWith('/5') ? e.score : `${e.score}/5`;
      const url = reportPathFromCol(e.report) ? applyUrlFromReport(reportPathFromCol(e.report)) : null;
      msg += `${scoreToEmoji(parseScore(e.score))} *${esc(e.company)}* — ${esc(e.role)}\n   ${fullScore} | ${esc(e.notes)}\n`;
      if (url) msg += `   🔗 ${esc(url)}\n`;
      msg += '\n';
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
    msg += `⚪ *Below Threshold (< 2.5)* — ${weak.length}\n\n`;
  }
  if (pending > 0) msg += `📦 *${pending} role(s) pending* in pipeline.\n`;
  msg += `📊 *${today.length} evaluated today*, ${today[0]?.date || ''}\n`;

  return msg;
}

function buildLLMMessage(scored, pending) {
  let msg = `🤖 *Career-Ops Scan — ${new Date().toISOString().slice(0, 10)}*\n\n`;
  msg += `📦 *${scored.length} new role(s) found*\n\n`;

  const sorted = [...scored].sort((a, b) => b.score - a.score);
  const strong = sorted.filter(i => i.score >= 3.5);
  const decent = sorted.filter(i => i.score >= 2.5 && i.score < 3.5);
  const weak = sorted.filter(i => i.score < 2.5);

  if (strong.length > 0) {
    msg += `🔥 *Strong Matches (≥ 3.5)* — ${strong.length}\n`;
    for (const i of strong) {
      msg += `${scoreToEmoji(i.score)} *${esc(i.company)}* — ${esc(i.title)}\n`;
      msg += `   ${i.score}/5 | ${esc(i.reason)} | ${esc(i.location || '')}\n`;
      msg += `   🔗 ${i.url}\n\n`;
    }
  }
  if (decent.length > 0) {
    msg += `👀 *Worth a Look (2.5–3.4)* — ${decent.length}\n`;
    for (const i of decent) {
      msg += `• *${esc(i.company)}* — ${esc(i.title)} — ${i.score}/5\n`;
    }
    msg += '\n';
  }
  if (weak.length > 0) {
    msg += `❌ *Below 2.5* — ${weak.length} (not a fit)\n\n`;
  }
  if (pending > 0) msg += `📦 *${pending} role(s) still pending* in pipeline.\n`;
  msg += '\n_Run deep evaluation for any role above._';

  return msg;
}

// ── Telegram send ──────────────────────────────────────────────

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
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      }),
    });
    const data = await res.json();
    if (!data.ok) {
      console.error('Telegram API error:', data.description || JSON.stringify(data));
      process.exit(1);
    }
  }
  console.log(`Notification sent (${parts.length} part(s)).`);
}

// ── Main ───────────────────────────────────────────────────────

async function main() {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set');
    process.exit(1);
  }

  // First: check tracker for real evaluations
  const todayTracker = parseTracker();
  if (todayTracker.length > 0) {
    const msg = buildTrackerMessage(todayTracker);
    await sendTelegram(msg);
    return;
  }

  // Second: check scan-history for new items and LLM pre-filter
  const newItems = readNewScanItems();
  if (newItems.length === 0) {
    const total = existsSync(TRACKER_PATH) ? readFileSync(TRACKER_PATH, 'utf-8').split('\n').filter(l => l.trim().startsWith('|') && !l.includes('| # |')).length : 0;
    const { pending } = parsePipeline();
    let msg = `🤖 *Career-Ops Daily — ${new Date().toISOString().slice(0, 10)}*\n\n_No new roles or evaluations today._\n\n📊 *${total} total roles* tracked.`;
    if (pending > 0) msg += `\n📦 *${pending} pending* in pipeline.`;
    await sendTelegram(msg);
    return;
  }

  const profile = readProfile();
  const scored = await llmScoreItems(profile, newItems);
  const msg = buildLLMMessage(scored, parsePipeline().pending);
  await sendTelegram(msg);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
