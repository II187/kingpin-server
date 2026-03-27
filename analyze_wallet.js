/**
 * Polymarket Wallet Analyzer
 * Analyzes trading patterns of a Polymarket user (e.g. filthybera)
 * Run this on Render where Polymarket is accessible
 */

const https = require('https');

function get(hostname, path) {
  return new Promise((resolve) => {
    const opts = { hostname, path, method: 'GET', headers: { 'User-Agent': 'KingpinBot/1.0' } };
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, data: {} }); }
      });
    });
    req.on('error', () => resolve({ status: 0, data: {} }));
    req.setTimeout(10000, () => { req.destroy(); resolve({ status: 0, data: {} }); });
    req.end();
  });
}

async function analyzeUser(username) {
  console.log(`\n🔍 Analyzing Polymarket user: @${username}\n`);

  // 1. Get user profile
  const profile = await get('gamma-api.polymarket.com', `/profiles?username=${username}`);
  
  if (!profile.data || !Array.isArray(profile.data) || !profile.data[0]) {
    console.log('❌ User not found or API unavailable');
    return null;
  }

  const user = profile.data[0];
  const address = user.proxyWallet || user.address;
  
  console.log(`👤 User: ${user.name || username}`);
  console.log(`📍 Address: ${address}`);
  console.log(`🏆 Volume: $${parseFloat(user.volume || 0).toLocaleString()}`);
  console.log(`💰 PnL: $${parseFloat(user.pnl || 0).toLocaleString()}`);
  console.log(`📊 Positions: ${user.positionsCount || 0}`);
  console.log(`🎯 Win Rate: ${user.winRate ? (user.winRate * 100).toFixed(1) + '%' : 'N/A'}`);

  if (!address) return user;

  // 2. Get positions
  const positions = await get('gamma-api.polymarket.com', 
    `/positions?user=${address}&limit=50&sortBy=value&sortDirection=desc`);
  
  if (positions.data && Array.isArray(positions.data)) {
    console.log(`\n📦 OPEN POSITIONS (${positions.data.length}):`);
    positions.data.slice(0, 10).forEach((p, i) => {
      const outcome = p.outcome;
      const size = parseFloat(p.size || 0);
      const value = parseFloat(p.value || 0);
      const avgPrice = parseFloat(p.avgPrice || 0);
      const market = p.market?.question || 'Unknown Market';
      console.log(`${i+1}. ${market.slice(0, 60)}`);
      console.log(`   ${outcome} @ ${(avgPrice*100).toFixed(1)}¢ | Size: ${size.toFixed(0)} | Value: $${value.toFixed(2)}`);
    });
  }

  // 3. Get trade history
  const trades = await get('gamma-api.polymarket.com',
    `/activity?user=${address}&limit=50&type=trade`);

  if (trades.data && Array.isArray(trades.data)) {
    console.log(`\n📈 RECENT TRADES (${trades.data.length}):`);
    
    let wins = 0, losses = 0, totalPnl = 0;
    const markets = {};
    
    trades.data.slice(0, 20).forEach(t => {
      const pnl = parseFloat(t.pnl || 0);
      if (pnl > 0) wins++;
      if (pnl < 0) losses++;
      totalPnl += pnl;
      
      const mkt = t.market?.question?.slice(0, 50) || 'Unknown';
      markets[mkt] = (markets[mkt] || 0) + 1;
    });

    console.log(`Win/Loss: ${wins}W / ${losses}L`);
    console.log(`Recent PnL: $${totalPnl.toFixed(2)}`);
    
    // Market focus
    const topMarkets = Object.entries(markets).sort(([,a],[,b]) => b-a).slice(0, 5);
    if (topMarkets.length) {
      console.log('\n🎯 Favorite Markets:');
      topMarkets.forEach(([m, c]) => console.log(`  ${c}x ${m}`));
    }
  }

  // 4. Pattern analysis
  console.log('\n💡 PATTERN ANALYSIS:');
  const vol = parseFloat(user.volume || 0);
  const pnl = parseFloat(user.pnl || 0);
  
  if (vol > 100000) console.log('→ Heavy hitter — $100k+ volume');
  if (pnl / vol > 0.05) console.log('→ Profitable: +' + ((pnl/vol)*100).toFixed(1) + '% ROI on volume');
  if (pnl / vol < -0.05) console.log('→ Net negative trader');
  
  return user;
}

// Export for use in server.js
module.exports = { analyzeUser };

// Run standalone
if (require.main === module) {
  analyzeUser('filthybera').catch(console.error);
}
