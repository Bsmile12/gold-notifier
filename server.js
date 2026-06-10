import express from 'express';
import cors from 'cors';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
// DATA_DIR ใช้สำหรับ Railway Volume — ถ้าไม่ตั้งค่าจะใช้โฟลเดอร์โปรเจกต์
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DB_PATH = join(DATA_DIR, 'db.json');
const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// --- DB Helpers ---
function readDB() {
  return JSON.parse(readFileSync(DB_PATH, 'utf-8'));
}

function writeDB(data) {
  writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

// --- Price Cache ---
let priceCache = {
  price: 0, change: 0, changePercent: 0,
  high: 0, low: 0, timestamp: new Date().toISOString(), source: 'Connecting...'
};

// --- Fetch Gold Price (SwissQuote public feed, no key) ---
async function fetchGoldPrice() {
  const res = await fetch(
    'https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/XAU/USD',
    {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(8000)
    }
  );
  if (!res.ok) throw new Error(`SwissQuote HTTP ${res.status}`);

  const json = await res.json();
  const entry = json?.[0];
  if (!entry) throw new Error('No data from SwissQuote');

  // bid/ask from Prime profile
  const profile = entry.spreadProfilePrices?.find(p => p.spreadProfile === 'Prime')
    ?? entry.spreadProfilePrices?.[0];
  if (!profile) throw new Error('No spread profile in SwissQuote response');

  const price = (profile.ask + profile.bid) / 2;

  // keep a rolling open to calculate change
  if (!fetchGoldPrice._open) fetchGoldPrice._open = price;
  const open = fetchGoldPrice._open;
  const change = price - open;
  const changePercent = (change / open) * 100;

  // reset open at server start once per day (simple heuristic)
  const now = new Date();
  if (!fetchGoldPrice._date || fetchGoldPrice._date !== now.toDateString()) {
    fetchGoldPrice._date = now.toDateString();
    fetchGoldPrice._open = price;
    fetchGoldPrice._high = price;
    fetchGoldPrice._low = price;
  }
  fetchGoldPrice._high = Math.max(fetchGoldPrice._high ?? price, price);
  fetchGoldPrice._low  = Math.min(fetchGoldPrice._low  ?? price, price);

  return {
    price,
    change,
    changePercent,
    high: fetchGoldPrice._high,
    low:  fetchGoldPrice._low,
    timestamp: new Date(entry.ts ?? Date.now()).toISOString(),
    source: 'SwissQuote'
  };
}

// --- Send Telegram Message ---
async function sendTelegramMessage(token, chatId, text) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    signal: AbortSignal.timeout(10000)
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.description);
  return data;
}

// --- Check & Trigger Alerts ---
async function checkAlerts(currentPrice) {
  const db = readDB();
  if (!db.settings.alertsEnabled) return;

  let changed = false;

  for (const alert of db.alerts) {
    if (!alert.active) continue;

    const triggered =
      (alert.condition === 'above' && currentPrice >= alert.targetPrice) ||
      (alert.condition === 'below' && currentPrice <= alert.targetPrice);

    if (!triggered) continue;

    alert.active = false;
    alert.triggeredAt = new Date().toISOString();
    changed = true;

    const historyItem = {
      id: alert.id,
      targetPrice: alert.targetPrice,
      condition: alert.condition,
      triggeredPrice: currentPrice,
      triggeredAt: alert.triggeredAt
    };
    db.history = [historyItem, ...(db.history || [])];

    const dir = alert.condition === 'above' ? 'สูงกว่า' : 'ต่ำกว่า';
    const msg =
      `🔔 <b>Gold Price Alert!</b>\n\n` +
      `ราคาทองคำ<b>${dir}</b> $${alert.targetPrice.toLocaleString('en-US', { minimumFractionDigits: 2 })}\n` +
      `💰 ราคาปัจจุบัน: <b>$${currentPrice.toLocaleString('en-US', { minimumFractionDigits: 2 })}</b>\n` +
      `🕐 เวลา: ${new Date().toLocaleString('th-TH')}`;

    if (db.settings.telegramToken && db.settings.telegramChatId) {
      sendTelegramMessage(db.settings.telegramToken, db.settings.telegramChatId, msg)
        .catch(err => console.error('Telegram send error:', err.message));
    }
  }

  if (changed) writeDB(db);
}

// --- Price Refresh Loop ---
let priceTimer = null;

async function refreshPrice() {
  try {
    priceCache = await fetchGoldPrice();
    console.log(`[${new Date().toLocaleTimeString()}] XAU/USD: $${priceCache.price}`);
    await checkAlerts(priceCache.price);
  } catch (err) {
    console.error('Price fetch error:', err.message);
    priceCache.source = 'Error - retrying...';
  }
}

function startPriceLoop() {
  if (priceTimer) clearInterval(priceTimer);
  const db = readDB();
  const intervalMs = Math.max(5, db.settings.checkInterval || 5) * 1000;
  priceTimer = setInterval(refreshPrice, intervalMs);
}

// --- API Routes ---

app.get('/api/price', (_req, res) => {
  res.json(priceCache);
});

// รับราคาจากบอทภายนอก: POST /api/price/push { price, high?, low?, source? }
app.post('/api/price/push', async (req, res) => {
  const { price, high, low, source } = req.body;
  const parsed = parseFloat(price);

  if (!parsed || parsed <= 0) {
    return res.status(400).json({ success: false, error: 'ต้องการ price ที่เป็นตัวเลขบวก' });
  }

  const prev = priceCache.price || parsed;
  priceCache = {
    price: parsed,
    change: parsed - prev,
    changePercent: prev > 0 ? ((parsed - prev) / prev) * 100 : 0,
    high: parseFloat(high) || Math.max(priceCache.high || parsed, parsed),
    low:  parseFloat(low)  || Math.min(priceCache.low  || parsed, parsed),
    timestamp: new Date().toISOString(),
    source: source || 'External Bot'
  };

  console.log(`[PUSH ${new Date().toLocaleTimeString()}] XAU/USD: $${parsed} (from: ${priceCache.source})`);
  await checkAlerts(parsed);

  res.json({ success: true, price: parsed });
});

app.get('/api/settings', (_req, res) => {
  res.json(readDB().settings);
});

app.post('/api/settings', (req, res) => {
  try {
    const db = readDB();
    db.settings = { ...db.settings, ...req.body };
    writeDB(db);
    startPriceLoop(); // restart loop if checkInterval changed
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/test-telegram', async (req, res) => {
  const { telegramToken, telegramChatId } = req.body;
  if (!telegramToken || !telegramChatId) {
    return res.status(400).json({ success: false, error: 'Missing token or chat ID' });
  }
  try {
    const priceStr = priceCache.price > 0
      ? `$${priceCache.price.toLocaleString('en-US', { minimumFractionDigits: 2 })}`
      : 'N/A';
    await sendTelegramMessage(
      telegramToken, telegramChatId,
      `✅ <b>ทดสอบการเชื่อมต่อสำเร็จ!</b>\n\nXAU/USD ราคาปัจจุบัน: <b>${priceStr}</b>\nเวลา: ${new Date().toLocaleString('th-TH')}`
    );
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.get('/api/alerts', (_req, res) => {
  res.json(readDB().alerts || []);
});

app.post('/api/alerts', (req, res) => {
  try {
    const { targetPrice, condition } = req.body;
    if (!targetPrice || !condition) {
      return res.status(400).json({ success: false, error: 'Missing targetPrice or condition' });
    }
    const db = readDB();
    const alert = {
      id: `alert_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
      targetPrice: parseFloat(targetPrice),
      condition,
      createdAt: new Date().toISOString(),
      triggeredAt: null,
      active: true
    };
    db.alerts.push(alert);
    writeDB(db);
    res.json({ success: true, alert });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/alerts/:id', (req, res) => {
  try {
    const db = readDB();
    const before = db.alerts.length;
    db.alerts = db.alerts.filter(a => a.id !== req.params.id);
    if (db.alerts.length === before) {
      return res.status(404).json({ success: false, error: 'Alert not found' });
    }
    writeDB(db);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/history', (_req, res) => {
  res.json(readDB().history || []);
});

app.post('/api/history/clear', (_req, res) => {
  try {
    const db = readDB();
    db.history = [];
    writeDB(db);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- Start ---
refreshPrice().then(() => {
  startPriceLoop();
  app.listen(PORT, () => {
    console.log(`\n🚀 Gold Monitor running at http://localhost:${PORT}\n`);
  });
});
