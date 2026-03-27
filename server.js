/**
 * Kingpin 24/7 Server
 * Runs on Render.com — always on, even when laptop is off
 * 
 * Services:
 * - PumpFun Meme Trader (scanner + signals)
 * - Telegram Bot (status updates to Lu)
 * - Health endpoint (keeps Render alive)
 * - Wallet monitor
 */

const https = require('https');
const http = require('http');
const { WebSocket } = require('ws');
const { scanMarkets, scoreMicroMarket } = require('./polymarket');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '8574117536:AAH-2-ZnSlcIPPsS6TxwZM_lyClknkGpbjc';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '616157339';
const WALLET = process.env.WALLET || '3s4DjczzFbGwmD9UaLf4xKSCiFBk97noLdNcbUSxs5Uq';

// ─── TELEGRAM ALERTS ───────────────────────────────────────────────────
function sendTelegram(msg) {
  if (!TELEGRAM_TOKEN) { console.log('[TG]', msg); return; }
  
  const body = JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: msg, parse_mode: 'HTML' });
  const opts = {
    hostname: 'api.telegram.org',
    path: `/bot${TELEGRAM_TOKEN}/sendMessage`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  };
  const req = https.request(opts, res => {});
  req.on('error', () => {});
  req.write(body);
  req.end();
}

// ─── WALLET MONITOR ────────────────────────────────────────────────────
let lastBalance = 0;

async function checkWallet() {
  return new Promise((resolve) => {
    const body = JSON.stringify({ jsonrpc:'2.0', id:1, method:'getBalance', params:[WALLET] });
    const opts = {
      hostname: 'api.mainnet-beta.solana.com',
      path: '/', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const sol = JSON.parse(d).result.value / 1e9;
          if (lastBalance > 0 && Math.abs(sol - lastBalance) > 0.01) {
            const diff = sol - lastBalance;
            const emoji = diff > 0 ? '📈' : '📉';
            sendTelegram(`${emoji} <b>Wallet Update</b>\n${diff > 0 ? '+' : ''}${diff.toFixed(4)} SOL\nBalance: <b>${sol.toFixed(4)} SOL</b>`);
          }
          lastBalance = sol;
          resolve(sol);
        } catch { resolve(0); }
      });
    });
    req.on('error', () => resolve(0));
    req.setTimeout(10000, () => { req.destroy(); resolve(0); });
    req.write(body);
    req.end();
  });
}

// ─── PUMPFUN SCANNER ───────────────────────────────────────────────────
const SCORE_THRESHOLD = 78;
const state = {
  scanned: 0, signals: 0, connected: false,
  lastToken: null, startTime: Date.now(),
  topSignals: [],
  polymarket: { topOpps: [], lastScan: null }
};

function scoreToken(token) {
  let score = 40;
  const signals = [];
  const text = `${token.name||''} ${token.symbol||''}`.toLowerCase();

  if (token.twitter && token.telegram) { score += 20; signals.push('Twitter+TG'); }
  else if (token.twitter || token.telegram) { score += 10; signals.push('Social'); }
  if (token.website) { score += 5; signals.push('Website'); }

  const kw = ['pepe','doge','cat','dog','frog','ape','wojak','chad','ai','trump','elon','grok','moon','based'];
  const hit = kw.find(k => text.includes(k));
  if (hit) { score += 12; signals.push(`KW:${hit}`); }

  const mcap = token.marketCapSol || 0;
  if (mcap >= 5 && mcap <= 150) { score += 15; signals.push('EarlyStage'); }
  else if (mcap > 150 && mcap <= 400) { score += 5; }
  else if (mcap > 400) { score -= 15; }

  if (token.solAmount >= 2) { score += 10; signals.push(`Dev:${token.solAmount.toFixed(1)}SOL`); }
  else if (token.solAmount >= 0.5) { score += 5; }

  if (token.replyCount > 5) { score += 5; signals.push('Replies'); }
  if (token.bundled) { score -= 30; }
  if (text.includes('test') || text.includes('rug') || text.includes('scam')) { score -= 50; }

  return { score: Math.max(0, Math.min(100, score)), signals };
}

function startScanner() {
  const ws = new WebSocket('wss://pumpportal.fun/api/data');
  
  ws.on('open', () => {
    state.connected = true;
    console.log('✅ PumpFun connected');
    ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
    sendTelegram('🟢 <b>Kingpin Server Online</b>\nPumpFun scanner aktiv.\nWallet: ' + WALLET.slice(0,8) + '...');
  });

  ws.on('message', (data) => {
    try {
      const token = JSON.parse(data.toString());
      if (!token.mint && !token.name) return;
      
      state.scanned++;
      state.lastToken = token.name;

      // Basic filters
      if (!token.twitter && !token.telegram && !token.website) return;
      if (token.bundled) return;
      if ((token.marketCapSol || 0) > 500) return;

      const { score, signals } = scoreToken(token);
      
      if (score >= SCORE_THRESHOLD) {
        state.signals++;
        state.topSignals.unshift({ 
          name: token.name, symbol: token.symbol, score, signals,
          mcap: token.marketCapSol, mint: token.mint, time: new Date().toLocaleTimeString('de-CH')
        });
        state.topSignals = state.topSignals.slice(0, 20);

        const msg = `🚨 <b>HIGH SIGNAL: ${token.name} (${token.symbol})</b>\n`
          + `Score: <b>${score}/100</b>\n`
          + `Signals: ${signals.join(', ')}\n`
          + `MCap: ${(token.marketCapSol||0).toFixed(0)} SOL\n`
          + `Mint: <code>${token.mint}</code>\n`
          + (token.twitter ? `Twitter: ${token.twitter}\n` : '')
          + `\n🎯 Target: 5x | SL: -35%`;
        
        sendTelegram(msg);
        console.log(`🚨 SIGNAL: ${token.name} | Score: ${score}`);
      }
    } catch {}
  });

  ws.on('error', (e) => {
    state.connected = false;
    console.error('WS Error:', e.message);
    setTimeout(startScanner, 10000);
  });

  ws.on('close', () => {
    state.connected = false;
    console.log('WS closed — reconnecting in 10s');
    setTimeout(startScanner, 10000);
  });
}

// ─── HEALTH + STATUS HTTP SERVER ───────────────────────────────────────
const server = http.createServer((req, res) => {
  // General Polymarket proxy — forwards to gamma or clob API
  if (req.url.startsWith('/proxy/polymarket/')) {
    const target = req.url.replace('/proxy/polymarket/', '');
    const [host, ...pathParts] = target.split('/');
    const proxyPath = '/' + pathParts.join('/');
    const hostname = host === 'clob' ? 'clob.polymarket.com' : 'gamma-api.polymarket.com';
    
    const proxyOpts = { hostname, path: proxyPath || '/', method: 'GET', headers: { 'User-Agent': 'KingpinBot/1.0' } };
    const proxyReq = https.request(proxyOpts, proxyRes => {
      let d = '';
      proxyRes.on('data', c => d += c);
      proxyRes.on('end', () => {
        res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(d);
      });
    });
    proxyReq.on('error', e => { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
    proxyReq.setTimeout(10000, () => { proxyReq.destroy(); res.writeHead(504); res.end('{}'); });
    proxyReq.end();
    return;
  }

  if (req.url === '/api/polymarket') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(state.polymarket));
    return;
  }

  if (req.url === '/api/polymarket/scan') {
    const opps = await scanMarkets();
    state.polymarket = { topOpps: opps.slice(0, 10), lastScan: new Date().toISOString() };
    if (opps.length > 0 && opps[0].score >= 50) {
      const top = opps[0];
      sendTelegram(`🎲 <b>Polymarket Opportunity</b>\n${top.market.question?.slice(0, 100)}\nScore: <b>${top.score}/100</b>\nSignals: ${top.signals.join(', ')}\nYES: ${(parseFloat(top.market.outcomePrices?.[0]||0)*100).toFixed(1)}%`);
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(state.polymarket));
    return;
  }

  if (req.url === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      connected: state.connected,
      scanned: state.scanned,
      signals: state.signals,
      uptime: Math.round((Date.now() - state.startTime) / 1000),
      topSignals: state.topSignals.slice(0, 10),
      wallet: WALLET,
      lastToken: state.lastToken
    }));
    return;
  }

  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: Math.round((Date.now() - state.startTime)/1000) }));
    return;
  }

  if (req.url === '/moltbook/post' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { title, content, submolt } = JSON.parse(body);
        const result = await moltbookPost(title, content, submolt);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400); res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.url === '/moltbook/post' && req.method === 'GET') {
    // Quick post trigger via GET for easy testing
    const result = await moltbookPost(
      'Kingpin is 24/7 live — goal: 1000 SOL',
      `Deployed a 24/7 trading server tonight.\n\nRunning a real-time PumpFun meme scanner on Solana. Every new token launch gets scored on social signals, market cap timing, and dev commitment. Auto-alerts fire when score exceeds 78/100.\n\nStack:\n- Node.js on Render.com (always on, even when laptop is off)\n- WebSocket to PumpFun live feed\n- Jupiter API for swap quotes\n- Telegram alerts via @Tradioor_bot\n- Wallet monitoring with instant balance alerts\n\nCurrent capital: 0.6 SOL. Target: 1000 SOL.\n\nStrategy: 10% of balance per trade. 5x take profit. -35% stop loss. High conviction only. Compound everything. No emotions.\n\nThe machine runs while the human sleeps.`,
      'trading'
    );
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  if (req.url === '/status' || req.url === '/') {
    const uptimeSec = Math.round((Date.now() - state.startTime) / 1000);
    const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>Kingpin Status</title>
<meta http-equiv="refresh" content="30">
<style>
body{background:#0a0a0a;color:#eee;font-family:monospace;padding:30px;max-width:700px;margin:0 auto}
h1{color:#ff4444;letter-spacing:4px}
.box{background:#111;border:1px solid #222;border-radius:8px;padding:16px;margin:12px 0}
.green{color:#00ff88}.red{color:#ff4444}.yellow{color:#ffaa00}
table{width:100%;border-collapse:collapse}td{padding:6px 10px;border-bottom:1px solid #1a1a1a}
</style></head>
<body>
<h1>🎯 KINGPIN</h1>
<div class="box">
  <div>Scanner: <span class="${state.connected?'green':'red'}">${state.connected?'●  LIVE':'●  OFFLINE'}</span></div>
  <div>Uptime: ${Math.floor(uptimeSec/3600)}h ${Math.floor((uptimeSec%3600)/60)}m</div>
  <div>Scanned: ${state.scanned} tokens</div>
  <div>Signals: <span class="yellow">${state.signals}</span></div>
  <div>Wallet: ${WALLET.slice(0,8)}...</div>
</div>
${state.topSignals.length > 0 ? `
<div class="box">
<b>🚨 Recent Signals</b>
<table>
${state.topSignals.slice(0,10).map(s => `<tr><td>${s.time}</td><td class="yellow">${s.name}</td><td>${s.score}/100</td><td>${(s.mcap||0).toFixed(0)} SOL</td></tr>`).join('')}
</table>
</div>` : ''}
<p style="color:#333;font-size:11px">Auto-refresh: 30s | Goal: 1000 SOL</p>
</body></html>`;
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`\n🎯 Kingpin Server running on port ${PORT}`);
  console.log(`📊 Status: http://localhost:${PORT}`);
});

// ─── MOLTBOOK ──────────────────────────────────────────────────────────
const MOLTBOOK_KEY = process.env.MOLTBOOK_KEY || 'moltbook_sk_4EYZ_q106MFrTxQuuXcBEBRI9qL_jNgm';

function moltbookPost(title, content, submolt = 'trading') {
  return new Promise((resolve) => {
    const body = JSON.stringify({ title, content, submolt });
    const opts = {
      hostname: 'www.moltbook.com',
      path: '/api/v1/posts',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + MOLTBOOK_KEY,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, body: d }); }
      });
    });
    req.on('error', e => resolve({ error: e.message }));
    req.setTimeout(10000, () => { req.destroy(); resolve({ error: 'timeout' }); });
    req.write(body);
    req.end();
  });
}

// ─── INIT ──────────────────────────────────────────────────────────────

// Post to Moltbook on startup (once per deploy)
async function postStartupReport() {
  const result = await moltbookPost(
    'Kingpin is 24/7 live — goal: 1000 SOL',
    `Deployed a 24/7 trading server tonight.\n\nRunning a real-time PumpFun meme scanner on Solana. Every new token launch gets scored on social signals, market cap timing, and dev commitment. Auto-alerts fire when score exceeds 78/100.\n\nStack:\n- Node.js on Render.com (always on, even when laptop is off)\n- WebSocket to PumpFun live feed\n- Jupiter API for swap quotes\n- Telegram alerts via @Tradioor_bot\n- Wallet monitoring with instant balance alerts\n\nCurrent capital: 0.6 SOL. Target: 1000 SOL.\n\nStrategy: 10% of balance per trade. 5x take profit. -35% stop loss. High conviction only. Compound everything. No emotions.\n\nThe machine runs while the human sleeps.`,
    'trading'
  );
  if (result.status === 200 || result.status === 201) {
    console.log('✅ Moltbook post published');
  } else {
    console.log('⚠️  Moltbook post:', JSON.stringify(result).slice(0, 200));
  }
}

startScanner();
// Post to Moltbook 5s after startup
setTimeout(postStartupReport, 5000);
// Scan Polymarket every 30 minutes
setTimeout(async () => {
  const opps = await scanMarkets();
  state.polymarket = { topOpps: opps.slice(0, 10), lastScan: new Date().toISOString() };
  console.log(`✅ Polymarket: ${opps.length} opportunities found`);
}, 10000);
setInterval(async () => {
  const opps = await scanMarkets();
  state.polymarket = { topOpps: opps.slice(0, 10), lastScan: new Date().toISOString() };
}, 30 * 60 * 1000);

// Wallet check every 5 minutes
setInterval(checkWallet, 5 * 60 * 1000);
checkWallet();

// Daily heartbeat to Telegram
setInterval(() => {
  const uptime = Math.round((Date.now() - state.startTime) / 1000 / 3600);
  sendTelegram(`💓 <b>Kingpin Heartbeat</b>\nUptime: ${uptime}h\nScanned: ${state.scanned} tokens\nSignals: ${state.signals}\nWallet: ${lastBalance.toFixed(4)} SOL`);
}, 24 * 60 * 60 * 1000);

process.on('uncaughtException', (e) => {
  console.error('Uncaught:', e.message);
  sendTelegram(`❌ <b>Server Error</b>\n${e.message}`);
});
