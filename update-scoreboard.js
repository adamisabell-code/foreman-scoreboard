#!/usr/bin/env node
/**
 * Foreman's Scoreboard Auto-Updater
 * Pulls live data from Beehiiv + Stripe, updates index.html, commits + pushes to GitHub.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ── Config ────────────────────────────────────────────────────────────────────
const BEEHIIV_API_KEY = process.env.BEEHIIV_API_KEY || 'qT3MXhGIiLmjYS3AdCckwsHbA6GxqBalBqGzuY9jCTEClqBR9j1qxDstDres9M2c';
const BEEHIIV_PUB_ID  = process.env.BEEHIIV_PUB_ID  || 'pub_5af96f9a-74b2-4dc2-a675-55d041819f59';
const STRIPE_SECRET   = process.env.STRIPE_SECRET_KEY;
const LAUNCH_DATE     = new Date('2026-03-26T00:00:00Z');     // Day 1 — first TikTok posted
const HTML_PATH       = path.join(__dirname, 'index.html');
const SUBSCRIBE_PATH  = path.join(__dirname, 'subscribe.html');

// ── Helpers ───────────────────────────────────────────────────────────────────
function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('JSON parse error: ' + body.slice(0, 200))); }
      });
    });
    req.on('error', reject);
  });
}

function daysSinceLaunch() {
  const ms = Date.now() - LAUNCH_DATE.getTime();
  return Math.max(1, Math.floor(ms / 86400000) + 1);
}

function formatDate(d) {
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

// ── Beehiiv: count active subscribers ────────────────────────────────────────
async function getSubscriberCount() {
  let count = 0;
  let cursor = null;
  let page = 0;
  do {
    const url = `https://api.beehiiv.com/v2/publications/${BEEHIIV_PUB_ID}/subscriptions?status=active&limit=100`
      + (cursor ? `&after=${cursor}` : '');
    const data = await httpsGet(url, { Authorization: `Bearer ${BEEHIIV_API_KEY}` });
    count += (data.data || []).length;
    cursor = data.has_more ? data.next_cursor : null;
    page++;
    if (page > 50) break; // safety cap
  } while (cursor);
  return count;
}

const FOREMAN_PAYMENT_LINK = 'plink_1TELRdRsEQGFbwtQcheraqRk'; // $27 scoreboard sale

// ── Stripe: revenue from Foreman payment link only ───────────────────────────
async function getStripeRevenue() {
  if (!STRIPE_SECRET) return null;
  let total = 0;
  let startingAfter = null;
  let page = 0;
  do {
    const url = 'https://api.stripe.com/v1/checkout/sessions?limit=100&status=complete&payment_link=' + FOREMAN_PAYMENT_LINK
      + (startingAfter ? `&starting_after=${startingAfter}` : '');
    const data = await httpsGet(url, {
      Authorization: `Basic ${Buffer.from(STRIPE_SECRET + ':').toString('base64')}`
    });
    const sessions = data.data || [];
    sessions.forEach(s => { total += (s.amount_total || 0); });
    startingAfter = data.has_more ? sessions[sessions.length - 1].id : null;
    page++;
    if (page > 50) break;
  } while (startingAfter);
  return total / 100;
}

// ── Stripe: members = completed Foreman checkout sessions ────────────────────
async function getStripeMembers() {
  if (!STRIPE_SECRET) return null;
  let count = 0;
  let startingAfter = null;
  let page = 0;
  do {
    const url = 'https://api.stripe.com/v1/checkout/sessions?limit=100&status=complete&payment_link=' + FOREMAN_PAYMENT_LINK
      + (startingAfter ? `&starting_after=${startingAfter}` : '');
    const data = await httpsGet(url, {
      Authorization: `Basic ${Buffer.from(STRIPE_SECRET + ':').toString('base64')}`
    });
    const sessions = data.data || [];
    count += sessions.length;
    startingAfter = data.has_more ? sessions[sessions.length - 1].id : null;
    page++;
    if (page > 50) break;
  } while (startingAfter);
  return count;
}

// ── Read existing value from HTML ────────────────────────────────────────────
function readExistingRevenue() {
  try {
    const html = fs.readFileSync(HTML_PATH, 'utf8');
    const m = html.match(/monthlyRevenue:\s*([\d.]+)/);
    return m ? parseFloat(m[1]) : 0;
  } catch (e) { return 0; }
}

// ── Patch the HTML ────────────────────────────────────────────────────────────
function patchHTML(subs, revenue, members, days, dateStr) {
  let html = fs.readFileSync(HTML_PATH, 'utf8');

  // Update the JS data block
  html = html.replace(/monthlyRevenue:\s*[\d.]+/, `monthlyRevenue: ${revenue}`);
  html = html.replace(/subscribers:\s*\d+/, `subscribers: ${subs}`);
  html = html.replace(/members:\s*\d+/, `members: ${members}`);
  html = html.replace(/dayNumber:\s*\d+/, `dayNumber: ${days}`);
  html = html.replace(/lastUpdated:\s*"[^"]+"/, `lastUpdated: "${dateStr}"`);

  // Update static days left display in the deadline bar HTML
  const daysLeft = Math.max(0, 90 - days);
  html = html.replace(/id="daysLeft">\d+/, `id="daysLeft">${daysLeft}`);

  fs.writeFileSync(HTML_PATH, html, 'utf8');
  console.log(`✅ HTML updated: ${subs} subs | $${revenue} revenue | ${members} members | Day ${days}`);

  // Also patch subscribe.html if it exists
  if (fs.existsSync(SUBSCRIBE_PATH)) {
    let subHtml = fs.readFileSync(SUBSCRIBE_PATH, 'utf8');
    const daysLeft2 = Math.max(0, 90 - days);
    subHtml = subHtml.replace(/subscribers:\s*\d+,/, `subscribers: ${subs},`);
    subHtml = subHtml.replace(/monthlyRevenue:\s*[\d.]+,/, `monthlyRevenue: ${revenue},`);
    subHtml = subHtml.replace(/dayNumber:\s*\d+,/, `dayNumber: ${days},`);
    subHtml = subHtml.replace(/lastUpdated:\s*"[^"]+"/, `lastUpdated: "${dateStr}"`);
    fs.writeFileSync(SUBSCRIBE_PATH, subHtml, 'utf8');
    console.log(`✅ subscribe.html also updated`);
  }
}

// ── Git commit + push ─────────────────────────────────────────────────────────
function gitPush(days) {
  try {
    execSync(`git -C "${__dirname}" add index.html subscribe.html`, { stdio: 'inherit' });
    execSync(`git -C "${__dirname}" commit -m "Auto-update scoreboard: Day ${days}"`, { stdio: 'inherit' });
    execSync(`git -C "${__dirname}" push`, { stdio: 'inherit' });
    console.log('✅ Pushed to GitHub');
  } catch (e) {
    // If nothing changed, git commit exits non-zero — that's fine
    console.log('ℹ️  Git: nothing to push or push failed:', e.message);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log('🔧 Foreman Scoreboard Updater starting...');
  try {
    const [subs, revenue, members] = await Promise.all([
      getSubscriberCount(),
      getStripeRevenue(),
      getStripeMembers(),
    ]);

    const days    = daysSinceLaunch();
    const dateStr = formatDate(new Date());

    // Stripe not configured — keep existing values for those fields
    // Revenue: use Stripe value only if it's HIGHER than what's already in the HTML
    // (prevents auto-updater from wiping manually-recorded one-time sales)
    const existingRevenue = readExistingRevenue();
    const stripeRevenue   = revenue !== null ? revenue : 0;
    const finalRevenue    = Math.max(existingRevenue, stripeRevenue);
    const finalMembers    = members  !== null ? members  : 0;

    patchHTML(subs, finalRevenue, finalMembers, days, dateStr);
    gitPush(days);

    console.log('🎯 Done.');
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
})();
