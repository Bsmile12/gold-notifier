// Global state
let currentPrice = 0;
let tradingViewWidget = null;

// DOM Elements
const livePriceEl = document.getElementById('live-gold-price');
const priceChangePercentEl = document.getElementById('price-change-percent');
const priceSourceEl = document.getElementById('price-source');
const statHighEl = document.getElementById('stat-high');
const statLowEl = document.getElementById('stat-low');
const statTimeEl = document.getElementById('stat-time');

const settingsForm = document.getElementById('settings-form');
const telegramTokenInput = document.getElementById('telegram-token');
const telegramChatIdInput = document.getElementById('telegram-chatid');
const checkIntervalInput = document.getElementById('check-interval');
const alertsEnabledToggle = document.getElementById('alerts-enabled-toggle');
const toggleTokenVisibilityBtn = document.getElementById('toggle-token-visibility');
const testTelegramBtn = document.getElementById('test-telegram-btn');
const settingsStatusMessage = document.getElementById('settings-status-message');

const alertForm = document.getElementById('alert-form');
const alertConditionSelect = document.getElementById('alert-condition');
const alertPriceInput = document.getElementById('alert-price');
const alertsListContainer = document.getElementById('alerts-list');
const alertCountEl = document.getElementById('alert-count');

const historyListContainer = document.getElementById('history-list');
const clearHistoryBtn = document.getElementById('clear-history-btn');

// Initialize App
window.addEventListener('DOMContentLoaded', () => {
  initTradingView();
  fetchSettings();
  fetchPrice();
  fetchAlerts();
  fetchHistory();

  // Start polling price and data
  setInterval(fetchPrice, 10000); // Poll price every 10 seconds
  setInterval(fetchAlerts, 10000); // Sync active alerts state
  setInterval(fetchHistory, 10000); // Sync history

  setupEventListeners();
});

// Initialize TradingView Widget
function initTradingView() {
  try {
    tradingViewWidget = new TradingView.widget({
      "width": "100%",
      "height": "100%",
      "symbol": "TVC:GOLD",
      "interval": "15",
      "timezone": "Asia/Bangkok",
      "theme": "dark",
      "style": "1",
      "locale": "th",
      "toolbar_bg": "#141a26",
      "enable_publishing": false,
      "hide_side_toolbar": false,
      "allow_symbol_change": true,
      "container_id": "tradingview_gold"
    });
  } catch (error) {
    console.error("Error loading TradingView Widget:", error);
  }
}

// Event Listeners Setup
function setupEventListeners() {
  // Toggle Bot Token Visibility
  toggleTokenVisibilityBtn.addEventListener('click', () => {
    const type = telegramTokenInput.getAttribute('type') === 'password' ? 'text' : 'password';
    telegramTokenInput.setAttribute('type', type);
    const icon = toggleTokenVisibilityBtn.querySelector('i');
    if (type === 'password') {
      icon.className = 'fa-solid fa-eye';
    } else {
      icon.className = 'fa-solid fa-eye-slash';
    }
  });

  // Save Settings Form
  settingsForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    showStatusMessage('กำลังบันทึกการตั้งค่า...', 'info');

    const data = {
      telegramToken: telegramTokenInput.value.trim(),
      telegramChatId: telegramChatIdInput.value.trim(),
      checkInterval: parseInt(checkIntervalInput.value) || 30
    };

    try {
      const response = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      const result = await response.json();
      if (result.success) {
        showStatusMessage('บันทึกการตั้งค่าเรียบร้อยแล้ว!', 'success');
      } else {
        showStatusMessage('ล้มเหลว: ' + result.error, 'error');
      }
    } catch (error) {
      showStatusMessage('ข้อผิดพลาดเครือข่ายในการบันทึกการตั้งค่า', 'error');
    }
  });

  // Test Telegram Connection
  testTelegramBtn.addEventListener('click', async () => {
    const token = telegramTokenInput.value.trim();
    const chatId = telegramChatIdInput.value.trim();

    if (!token || !chatId) {
      showStatusMessage('กรุณากรอก Bot Token และ Chat ID ก่อนคลิกปุ่มทดสอบ', 'error');
      return;
    }

    showStatusMessage('กำลังส่งข้อความทดสอบไปยัง Telegram...', 'info');

    try {
      const response = await fetch('/api/test-telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ telegramToken: token, telegramChatId: chatId })
      });
      
      const result = await response.json();
      if (response.ok && result.success) {
        showStatusMessage('ส่งข้อความทดสอบเรียบร้อยแล้ว! กรุณาตรวจสอบในแอพ Telegram', 'success');
      } else {
        showStatusMessage('ล้มเหลวในการส่ง: ' + (result.error || 'กรุณาตรวจสอบ Token และ Chat ID'), 'error');
      }
    } catch (error) {
      showStatusMessage('ข้อผิดพลาดในการเชื่อมต่อกับเซิร์ฟเวอร์', 'error');
    }
  });

  // Alerts Enabled Toggle
  alertsEnabledToggle.addEventListener('change', async () => {
    const enabled = alertsEnabledToggle.checked;
    try {
      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alertsEnabled: enabled })
      });
    } catch (error) {
      console.error('Failed to update alert toggle status:', error);
    }
  });

  // Create Alert Form
  alertForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const condition = alertConditionSelect.value;
    const targetPrice = parseFloat(alertPriceInput.value);

    if (isNaN(targetPrice) || targetPrice <= 0) {
      alert('กรุณากรอกราคาทองคำที่ถูกต้อง');
      return;
    }

    try {
      const response = await fetch('/api/alerts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetPrice, condition })
      });
      const result = await response.json();
      if (result.success) {
        alertPriceInput.value = '';
        fetchAlerts();
      } else {
        alert('เกิดข้อผิดพลาด: ' + result.error);
      }
    } catch (error) {
      console.error('Failed to create alert:', error);
    }
  });

  // Clear History Log
  clearHistoryBtn.addEventListener('click', async () => {
    if (!confirm('คุณต้องการล้างประวัติการแจ้งเตือนทั้งหมดใช่หรือไม่?')) return;
    try {
      const response = await fetch('/api/history/clear', { method: 'POST' });
      const result = await response.json();
      if (result.success) {
        fetchHistory();
      }
    } catch (error) {
      console.error('Failed to clear history:', error);
    }
  });
}

// Fetch and Render Current Price
async function fetchPrice() {
  try {
    const response = await fetch('/api/price');
    if (!response.ok) throw new Error('API server returned error');
    
    const data = await response.json();
    const newPrice = data.price;

    // Flash price box based on change direction
    if (currentPrice > 0 && newPrice !== currentPrice) {
      const directionClass = newPrice > currentPrice ? 'flash-up' : 'flash-down';
      livePriceEl.parentElement.classList.remove('flash-up', 'flash-down');
      // trigger reflow
      void livePriceEl.parentElement.offsetWidth;
      livePriceEl.parentElement.classList.add(directionClass);
    }

    currentPrice = newPrice;

    // Update Price display
    livePriceEl.textContent = currentPrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    
    // Update Badge
    const sign = data.change >= 0 ? '+' : '';
    priceChangePercentEl.textContent = `${sign}${data.changePercent.toFixed(2)}%`;
    priceChangePercentEl.className = 'price-badge ' + (data.change >= 0 ? 'price-up' : 'price-down');

    // Update Meta and Stats
    priceSourceEl.textContent = data.source;
    statHighEl.textContent = `$${data.high.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    statLowEl.textContent = `$${data.low.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    
    const time = new Date(data.timestamp);
    statTimeEl.textContent = time.toLocaleTimeString('th-TH');

  } catch (error) {
    console.error('Error loading gold price:', error);
    priceSourceEl.textContent = 'Error connecting to api';
  }
}

// Fetch and Populate Settings
async function fetchSettings() {
  try {
    const response = await fetch('/api/settings');
    const settings = await response.json();
    
    telegramTokenInput.value = settings.telegramToken || '';
    telegramChatIdInput.value = settings.telegramChatId || '';
    checkIntervalInput.value = settings.checkInterval || 30;
    alertsEnabledToggle.checked = settings.alertsEnabled !== false;
  } catch (error) {
    console.error('Error loading settings:', error);
  }
}

// Fetch and Populate Alert Rules
async function fetchAlerts() {
  try {
    const response = await fetch('/api/alerts');
    const alerts = await response.json();
    renderAlerts(alerts);
  } catch (error) {
    console.error('Error loading alerts:', error);
  }
}

// Render Alerts List
function renderAlerts(alerts) {
  const activeAlerts = alerts.filter(a => a.active);
  alertCountEl.textContent = activeAlerts.length;

  if (activeAlerts.length === 0) {
    alertsListContainer.innerHTML = `
      <div class="empty-state">
        <i class="fa-solid fa-circle-info"></i>
        <p>ยังไม่มีรายการแจ้งเตือนที่สร้างไว้</p>
      </div>
    `;
    return;
  }

  alertsListContainer.innerHTML = '';
  activeAlerts.forEach(alert => {
    const isAbove = alert.condition === 'above';
    const card = document.createElement('div');
    card.className = 'alert-card';
    card.innerHTML = `
      <div class="alert-info-col">
        <div class="alert-badge ${isAbove ? 'badge-above' : 'badge-below'}">
          <i class="fa-solid ${isAbove ? 'fa-arrow-trend-up' : 'fa-arrow-trend-down'}"></i>
        </div>
        <div class="alert-details">
          <div class="alert-title">
            เตือนเมื่อราคา ${isAbove ? 'สูงกว่า' : 'ต่ำกว่า'} <span>$${alert.targetPrice.toLocaleString('en-US', { minimumFractionDigits: 2 })}</span>
          </div>
          <div class="alert-meta">
            สร้างเมื่อ: ${new Date(alert.createdAt).toLocaleString('th-TH')}
          </div>
        </div>
      </div>
      <button class="delete-alert-btn" data-id="${alert.id}">
        <i class="fa-solid fa-trash-can"></i>
      </button>
    `;

    // Hook delete event
    card.querySelector('.delete-alert-btn').addEventListener('click', async (e) => {
      const id = e.currentTarget.getAttribute('data-id');
      if (confirm('คุณต้องการลบกฎการแจ้งเตือนนี้ใช่หรือไม่?')) {
        try {
          await fetch(`/api/alerts/${id}`, { method: 'DELETE' });
          fetchAlerts();
        } catch (err) {
          console.error('Failed to delete alert:', err);
        }
      }
    });

    alertsListContainer.appendChild(card);
  });
}

// Fetch and Populate Triggered History
async function fetchHistory() {
  try {
    const response = await fetch('/api/history');
    const history = await response.json();
    renderHistory(history);
  } catch (error) {
    console.error('Error loading history:', error);
  }
}

// Render History List
function renderHistory(history) {
  if (history.length === 0) {
    historyListContainer.innerHTML = `
      <div class="empty-state">
        <i class="fa-solid fa-clock-rotate-left"></i>
        <p>ยังไม่มีประวัติการส่งแจ้งเตือน</p>
      </div>
    `;
    return;
  }

  historyListContainer.innerHTML = '';
  history.forEach(item => {
    const isAbove = item.condition === 'above';
    const card = document.createElement('div');
    card.className = `history-card ${isAbove ? 'triggered-above' : 'triggered-below'}`;
    card.innerHTML = `
      <div class="history-info-col">
        <div class="history-details">
          <div class="history-title">
            ส่งแจ้งเตือน: ${isAbove ? 'สูงกว่า' : 'ต่ำกว่า'} $${item.targetPrice.toLocaleString('en-US', { minimumFractionDigits: 2 })}
          </div>
          <div class="history-meta">
            ส่งเมื่อ: ${new Date(item.triggeredAt).toLocaleString('th-TH')}
          </div>
        </div>
      </div>
      <div class="history-price-badge">
        แตะที่ $${item.triggeredPrice.toLocaleString('en-US', { minimumFractionDigits: 2 })}
      </div>
    `;
    historyListContainer.appendChild(card);
  });
}

// Show settings feedback messages
function showStatusMessage(text, type) {
  settingsStatusMessage.textContent = text;
  settingsStatusMessage.className = 'status-msg'; // Reset
  
  if (type === 'success') {
    settingsStatusMessage.classList.add('status-success');
  } else if (type === 'error') {
    settingsStatusMessage.classList.add('status-error');
  } else if (type === 'info') {
    settingsStatusMessage.classList.add('status-success');
    settingsStatusMessage.style.borderColor = 'var(--telegram-blue)';
    settingsStatusMessage.style.color = 'var(--text-primary)';
    settingsStatusMessage.style.background = 'rgba(0, 136, 204, 0.1)';
  }

  // Auto hide success or error after 5s, info stays until finished
  if (type !== 'info') {
    setTimeout(() => {
      settingsStatusMessage.style.display = 'none';
    }, 5000);
  }
}
