/**
 * Polymarket Profile Scraper
 * Uses Playwright to scrape profiles from the US (bypasses CH geo-block)
 * Called via HTTP: GET /api/scrape/polymarket/:username
 */

const { chromium } = require('playwright');

async function scrapePolymarketProfile(username) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 }
  });

  const page = await context.newPage();
  const result = { username, success: false, data: null, error: null };

  try {
    // Intercept API calls to grab profile data
    const apiData = {};
    page.on('response', async (response) => {
      const url = response.url();
      if (url.includes('gamma-api.polymarket.com') || url.includes('data-api.polymarket.com')) {
        try {
          const json = await response.json();
          const key = url.split('/').slice(-2).join('/');
          apiData[key] = json;
        } catch {}
      }
    });

    await page.goto(`https://polymarket.com/profile/@${username}`, {
      waitUntil: 'networkidle',
      timeout: 30000
    });

    await page.waitForTimeout(5000);

    const pageData = await page.evaluate(() => {
      const body = document.body.innerText;
      return {
        title: document.title,
        url: window.location.href,
        text: body.slice(0, 8000),
        // Try to grab React state / Next.js data
        nextData: window.__NEXT_DATA__ ? JSON.stringify(window.__NEXT_DATA__).slice(0, 5000) : null
      };
    });

    result.success = true;
    result.data = {
      ...pageData,
      apiCalls: apiData,
      walletAddress: pageData.text.match(/0x[a-fA-F0-9]{40}/)?.[0] || null,
    };

  } catch (err) {
    result.error = err.message;
  } finally {
    await browser.close();
  }

  return result;
}

module.exports = { scrapePolymarketProfile };