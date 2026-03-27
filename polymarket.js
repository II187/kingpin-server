/**
 * Polymarket Integration — via Render.com (bypasses CH geo-block)
 * REST API calls to clob.polymarket.com + gamma-api.polymarket.com
 * No Python needed — pure Node.js https
 */

const https = require('https');

const CLOB_HOST = 'clob.polymarket.com';
const GAMMA_HOST = 'gamma-api.polymarket.com';

function get(hostname, path, headers = {}) {
  return new Promise((resolve) => {
    const opts = {
      hostname, path, method: 'GET',
      headers: { 'User-Agent': 'KingpinBot/1.0', ...headers }
    };
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, data: d }); }
      });
    });
    req.on('error', e => resolve({ error: e.message }));
    req.setTimeout(10000, () => { req.destroy(); resolve({ error: 'timeout' }); });
    req.end();
  });
}

// ─── Public Market Data (no auth needed) ──────────────────────────────

// Get top markets by volume
async function getTopMarkets(limit = 20) {
  const r = await get(GAMMA_HOST, `/markets?limit=${limit}&order=volume24hr&ascending=false&active=true&closed=false`);
  return r.data;
}

// Get specific market by slug
async function getMarket(slug) {
  const r = await get(GAMMA_HOST, `/markets?slug=${slug}`);
  return r.data;
}

// Get order book for a token
async function getOrderBook(tokenId) {
  const r = await get(CLOB_HOST, `/book?token_id=${tokenId}`);
  return r.data;
}

// Get midpoint price
async function getMidpoint(tokenId) {
  const r = await get(CLOB_HOST, `/midpoint?token_id=${tokenId}`);
  return r.data;
}

// Get recent trades
async function getTrades(tokenId, limit = 10) {
  const r = await get(CLOB_HOST, `/trades?token_id=${tokenId}&limit=${limit}`);
  return r.data;
}

// ─── Market Scanner — find exploitable markets ─────────────────────────

function scoreMicroMarket(market) {
  let score = 0;
  const signals = [];

  // High volume = good liquidity
  const vol = parseFloat(market.volume24hr || 0);
  if (vol > 10000) { score += 20; signals.push(`Vol: $${Math.round(vol/1000)}k`); }
  else if (vol > 1000) { score += 10; signals.push(`Vol: $${Math.round(vol)}`); }

  // Price near 50% = maximum uncertainty = max edge potential
  const price = parseFloat(market.outcomePrices?.[0] || 0.5);
  const distFrom50 = Math.abs(price - 0.5);
  if (distFrom50 < 0.1) { score += 20; signals.push('Near 50% — uncertain'); }
  else if (distFrom50 < 0.2) { score += 10; signals.push('Mid-range price'); }

  // Ends soon = resolves quickly = faster profit
  const endDate = new Date(market.endDate || market.endDateIso);
  const daysLeft = (endDate - Date.now()) / 1000 / 60 / 60 / 24;
  if (daysLeft > 0 && daysLeft < 3) { score += 25; signals.push(`Ends in ${daysLeft.toFixed(1)}d`); }
  else if (daysLeft < 7) { score += 15; signals.push(`Ends in ${Math.round(daysLeft)}d`); }
  else if (daysLeft < 30) { score += 5; }

  // Active liquidity
  const liquidity = parseFloat(market.liquidity || 0);
  if (liquidity > 5000) { score += 15; signals.push(`Liq: $${Math.round(liquidity/1000)}k`); }
  else if (liquidity > 1000) { score += 8; }

  // Trending keywords
  const q = (market.question || '').toLowerCase();
  const hotTopics = ['bitcoin', 'trump', 'fed', 'rate', 'election', 'elon', 'ai', 'solana', 'eth', 'btc'];
  const hit = hotTopics.find(k => q.includes(k));
  if (hit) { score += 10; signals.push(`Hot: ${hit}`); }

  return { score: Math.min(100, score), signals };
}

async function scanMarkets() {
  console.log('🔍 Scanning Polymarket...');
  
  const markets = await getTopMarkets(50);
  
  if (!Array.isArray(markets)) {
    console.log('⚠️  Could not fetch markets:', JSON.stringify(markets).slice(0, 200));
    return [];
  }

  const scored = markets
    .filter(m => m.active && !m.closed)
    .map(m => {
      const { score, signals } = scoreMicroMarket(m);
      return { score, signals, market: m };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  console.log(`\n📊 TOP POLYMARKET OPPORTUNITIES:`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  
  scored.forEach((s, i) => {
    const m = s.market;
    const price = parseFloat(m.outcomePrices?.[0] || 0);
    console.log(`${i+1}. [${s.score}/100] ${m.question?.slice(0, 70)}`);
    console.log(`   YES: ${(price*100).toFixed(1)}% | Vol: $${Math.round(parseFloat(m.volume24hr||0)).toLocaleString()} | Signals: ${s.signals.join(', ')}`);
    console.log('');
  });

  return scored;
}

module.exports = { scanMarkets, getTopMarkets, getOrderBook, getMidpoint, getTrades, getMarket, scoreMicroMarket };

// Run standalone
if (require.main === module) {
  scanMarkets().catch(console.error);
}
