import express from 'express';
import cors from 'cors';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DB_PATH = join(DATA_DIR, 'db.json');
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin1234';

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

// --- In-Memory Log Buffer ---
const logs = [];
const MAX_LOGS = 1000;
const sseClients = new Set();

function addLog(type, message, data = null) {
  const entry = {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    type,   // price | alert | error | push | telegram | system
    message,
    data,
    ts: new Date().toISOString()
  };
  logs.unshift(entry);
  if (logs.length > MAX_LOGS) logs.pop();
  // broadcast to all SSE clients
  const payload = `data: ${JSON.stringify(entry)}\n\n`;
  sseClients.forEach(res => res.write(payload));
}

// --- Price Cache ---
let priceCache = {
  price: 0, change: 0, changePercent: 0,
  high: 0, low: 0, timestamp: new Date().toISOString(), source: 'Connecting...'
};

// --- Fetch Gold Price ---
async function fetchGoldPrice() {
  const res = await fetch(
    'https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/XAU/USD',
    { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) }
  );
  if (!res.ok) throw new Error(`SwissQuote HTTP ${res.status}`);

  const json = await res.json();
  const entry = json?.[0];
  if (!entry) throw new Error('No data from SwissQuote');

  const profile = entry.spreadProfilePrices?.find(p => p.spreadProfile === 'Prime')
    ?? entry.spreadProfilePrices?.[0];
  if (!profile) throw new Error('No spread profile in SwissQuote response');

  const price = (profile.ask + profile.bid) / 2;

  if (!fetchGoldPrice._open) fetchGoldPrice._open = price;
  const open = fetchGoldPrice._open;

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
    change: price - open,
    changePercent: ((price - open) / open) * 100,
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
    addLog('alert',
      `Alert triggered: ราคา${dir} $${alert.targetPrice.toLocaleString('en-US', { minimumFractionDigits: 2 })} | ราคาจริง $${currentPrice.toLocaleString('en-US', { minimumFractionDigits: 2 })}`,
      { alertId: alert.id, condition: alert.condition, target: alert.targetPrice, actual: currentPrice }
    );

    const msg =
      `🔔 <b>Gold Price Alert!</b>\n\n` +
      `ราคาทองคำ<b>${dir}</b> $${alert.targetPrice.toLocaleString('en-US', { minimumFractionDigits: 2 })}\n` +
      `💰 ราคาปัจจุบัน: <b>$${currentPrice.toLocaleString('en-US', { minimumFractionDigits: 2 })}</b>\n` +
      `🕐 เวลา: ${new Date().toLocaleString('th-TH')}`;

    if (db.settings.telegramToken && db.settings.telegramChatId) {
      sendTelegramMessage(db.settings.telegramToken, db.settings.telegramChatId, msg)
        .then(() => addLog('telegram', `Telegram sent: alert ${alert.id}`, { chatId: db.settings.telegramChatId }))
        .catch(err => {
          addLog('error', `Telegram send failed: ${err.message}`, { alertId: alert.id });
          console.error('Telegram send error:', err.message);
        });
    }
  }

  if (changed) writeDB(db);
}

// --- Price Refresh Loop ---
let priceTimer = null;

async function refreshPrice() {
  try {
    priceCache = await fetchGoldPrice();
    addLog('price', `XAU/USD: $${priceCache.price.toFixed(3)} (${priceCache.change >= 0 ? '+' : ''}${priceCache.change.toFixed(3)})`, {
      price: priceCache.price, change: priceCache.change, source: priceCache.source
    });
    console.log(`[${new Date().toLocaleTimeString()}] XAU/USD: $${priceCache.price}`);
    await checkAlerts(priceCache.price);
  } catch (err) {
    addLog('error', `Price fetch failed: ${err.message}`);
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

// --- Admin Auth Middleware ---
function adminAuth(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (token !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ============================================================
// ADMIN ROUTES
// ============================================================

app.get('/admin', (_req, res) => {
  res.sendFile(join(__dirname, 'public', 'admin.html'));
});

app.post('/admin/login', (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) {
    addLog('system', `Admin login failed (wrong password)`);
    return res.status(401).json({ success: false, error: 'รหัสผ่านไม่ถูกต้อง' });
  }
  addLog('system', 'Admin logged in');
  res.json({ success: true, token: ADMIN_PASSWORD });
});

// GET logs (with optional filter ?type=price|alert|error|push|telegram|system&limit=100)
app.get('/admin/api/logs', adminAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 200, 1000);
  const type = req.query.type;
  const filtered = type ? logs.filter(l => l.type === type) : logs;
  res.json(filtered.slice(0, limit));
});

// GET stats
app.get('/admin/api/stats', adminAuth, (_req, res) => {
  const db = readDB();
  res.json({
    uptime: Math.floor(process.uptime()),
    currentPrice: priceCache,
    activeAlerts: db.alerts.filter(a => a.active).length,
    totalAlerts: db.alerts.length,
    historyCount: (db.history || []).length,
    logCount: logs.length,
    alertsEnabled: db.settings.alertsEnabled,
    telegramConfigured: !!(db.settings.telegramToken && db.settings.telegramChatId)
  });
});

// SSE — real-time log stream
app.get('/admin/api/stream', adminAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  sseClients.add(res);

  // send last 50 logs immediately on connect
  res.write(`data: ${JSON.stringify({ type: '__init__', logs: logs.slice(0, 50) })}\n\n`);

  req.on('close', () => sseClients.delete(res));
});

// Clear logs
app.post('/admin/api/logs/clear', adminAuth, (_req, res) => {
  logs.length = 0;
  addLog('system', 'Logs cleared by admin');
  res.json({ success: true });
});

// ============================================================
// PUBLIC API ROUTES
// ============================================================

app.get('/api/price', (_req, res) => {
  res.json(priceCache);
});

app.post('/api/price/push', async (req, res) => {
  // รองรับทั้ง price และ alert_price
  const rawPrice = req.body.price ?? req.body.alert_price;
  const { high, low, source, direction } = req.body;
  const parsed = parseFloat(rawPrice);

  if (!parsed || parsed <= 0) {
    return res.status(400).json({ success: false, error: 'ต้องการ price หรือ alert_price ที่เป็นตัวเลขบวก' });
  }

  // normalize direction: up/down/uptrend/downtrend/above/below → "up" | "down" | null
  const dir = normalizeDirection(direction);

  const prev = priceCache.price || parsed;
  priceCache = {
    price: parsed,
    change: parsed - prev,
    changePercent: prev > 0 ? ((parsed - prev) / prev) * 100 : 0,
    high: parseFloat(high) || Math.max(priceCache.high || parsed, parsed),
    low:  parseFloat(low)  || Math.min(priceCache.low  || parsed, parsed),
    timestamp: new Date().toISOString(),
    source: source || 'External Bot',
    direction: dir
  };

  const dirLabel = dir === 'up' ? '⬆ ขึ้น' : dir === 'down' ? '⬇ ลง' : '';
  addLog('push',
    `Push: $${parsed} ${dirLabel} from "${priceCache.source}"`,
    { price: parsed, direction: dir, source: priceCache.source }
  );
  console.log(`[PUSH ${new Date().toLocaleTimeString()}] $${parsed} ${dirLabel} (${priceCache.source})`);
  await checkAlerts(parsed);

  res.json({ success: true, price: parsed, direction: dir });
});

function normalizeDirection(val) {
  if (!val) return null;
  const v = String(val).toLowerCase().trim();
  if (['up', 'above', 'uptrend', 'long', 'bull', 'bullish', 'buy', '1'].includes(v)) return 'up';
  if (['down', 'below', 'downtrend', 'short', 'bear', 'bearish', 'sell', '-1'].includes(v)) return 'down';
  return null;
}

app.get('/api/settings', (_req, res) => {
  const s = readDB().settings;
  // mask token — แสดงแค่ 6 ตัวท้าย ป้องกัน token หลุด
  const masked = { ...s };
  if (masked.telegramToken) {
    masked.telegramToken = '••••••••' + masked.telegramToken.slice(-6);
  }
  res.json(masked);
});

// admin-only: ดู settings เต็ม (ต้องใส่ token)
app.get('/admin/api/settings', adminAuth, (_req, res) => {
  res.json(readDB().settings);
});

app.post('/api/settings', (req, res) => {
  try {
    const db = readDB();
    const updates = { ...req.body };
    // ถ้า token ที่ส่งมาเป็น masked value ให้คงค่าเดิมไว้
    if (updates.telegramToken && updates.telegramToken.startsWith('••••••••')) {
      delete updates.telegramToken;
    }
    db.settings = { ...db.settings, ...updates };
    writeDB(db);
    addLog('system', 'Settings updated');
    startPriceLoop();
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
    addLog('telegram', `Test message sent to ${telegramChatId}`);
    res.json({ success: true });
  } catch (err) {
    addLog('error', `Test telegram failed: ${err.message}`);
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
    addLog('system', `Alert created: ${condition} $${alert.targetPrice}`, { alertId: alert.id });
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
    addLog('system', `Alert deleted: ${req.params.id}`);
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
    addLog('system', 'Alert history cleared');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- Start ---
addLog('system', `Server starting on port ${PORT}`);
refreshPrice().then(() => {
  startPriceLoop();
  app.listen(PORT, () => {
    console.log(`\n🚀 Gold Monitor running at http://localhost:${PORT}`);
    console.log(`🔐 Admin panel: http://localhost:${PORT}/admin`);
    console.log(`🔑 Admin password: ${ADMIN_PASSWORD}\n`);
    addLog('system', `Server started on port ${PORT}`);
  });
});
