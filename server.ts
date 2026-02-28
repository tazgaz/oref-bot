import express from 'express';
import { createServer as createViteServer } from 'vite';
import { Server } from 'socket.io';
import http from 'http';
import Database from 'better-sqlite3';
import { appendFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const PORT = 3000;
const WEBHOOK_LOG_PATH = process.env.WEBHOOK_LOG_PATH || path.join(process.cwd(), 'logs', 'webhook.log');
const APP_TIMEZONE = process.env.TZ || 'Asia/Jerusalem';
const RUNNING_IN_DOCKER = process.env.RUNNING_IN_CONTAINER === 'true' || existsSync('/.dockerenv');
const CITY_WEBHOOK_COOLDOWN_MS = 3 * 60 * 1000;

app.use(express.json());

// DB setup
const DB_PATH = process.env.DB_PATH || 'alerts.db';
const db = new Database(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY,
    cities TEXT,
    webhook_url TEXT
  );
  CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    alert_id TEXT UNIQUE,
    data TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Initialize settings if empty
const stmt = db.prepare('SELECT * FROM settings WHERE id = 1');
if (!stmt.get()) {
  db.prepare('INSERT INTO settings (id, cities, webhook_url) VALUES (1, ?, ?)').run('[]', '');
}

// API Routes
app.get('/api/settings', (req, res) => {
  const settings = db.prepare('SELECT * FROM settings WHERE id = 1').get() as any;
  res.json({
    cities: JSON.parse(settings.cities),
    webhook_url: settings.webhook_url
  });
});

app.post('/api/settings', (req, res) => {
  const { cities, webhook_url } = req.body;
  db.prepare('UPDATE settings SET cities = ?, webhook_url = ? WHERE id = 1').run(JSON.stringify(cities), webhook_url);
  res.json({ success: true });
});

app.get('/api/cooldown/status', (req, res) => {
  const settings = db.prepare('SELECT * FROM settings WHERE id = 1').get() as any;
  const monitoredCities = JSON.parse(settings.cities || '[]');
  const nowMs = Date.now();

  const monitored = (Array.isArray(monitoredCities) ? monitoredCities : [])
    .filter((c: unknown): c is string => typeof c === 'string')
    .map((city: string) => {
      const key = cooldownCityKey(city);
      const lastSentAtMs = cityLastWebhookAt.get(key) || 0;
      const remainingMs = Math.max(0, CITY_WEBHOOK_COOLDOWN_MS - (nowMs - lastSentAtMs));
      const active = remainingMs > 0;
      return {
        city,
        key,
        active,
        remainingMs,
        lastSentAt: lastSentAtMs ? new Date(lastSentAtMs).toISOString() : null
      };
    });

  const active = Array.from(cityLastWebhookAt.entries())
    .map(([key, lastSentAtMs]) => {
      const remainingMs = Math.max(0, CITY_WEBHOOK_COOLDOWN_MS - (nowMs - lastSentAtMs));
      return {
        key,
        active: remainingMs > 0,
        remainingMs,
        lastSentAt: new Date(lastSentAtMs).toISOString()
      };
    })
    .filter((entry) => entry.active)
    .sort((a, b) => b.remainingMs - a.remainingMs);

  res.json({
    cooldownMs: CITY_WEBHOOK_COOLDOWN_MS,
    now: new Date(nowMs).toISOString(),
    monitored,
    active
  });
});

app.get('/api/alerts/history', (req, res) => {
  const alerts = db.prepare('SELECT * FROM alerts ORDER BY timestamp DESC LIMIT 50').all() as any[];
  res.json(alerts.map(a => ({ ...a, data: JSON.parse(a.data) })));
});

app.post('/api/webhook/test', async (req, res) => {
  const settings = db.prepare('SELECT * FROM settings WHERE id = 1').get() as any;
  const webhookUrl = settings.webhook_url;
  const city = req.body?.city || 'באר יעקב';

  if (!webhookUrl) {
    res.status(400).json({ success: false, error: 'webhook_url is not configured' });
    return;
  }

  await sendWebhook(webhookUrl, {
    type: 'TEST',
    category: '0',
    categoryName: 'בדיקת חיבור',
    title: 'Webhook test',
    cities: [city],
    desc: 'Manual webhook connectivity test',
    time: new Date().toISOString()
  });

  res.json({ success: true, webhook_url: webhookUrl, city });
});

app.get('/api/cities', async (req, res) => {
  try {
    const response = await fetch('https://www.oref.org.il/Shared/Ajax/GetCities.aspx', {
      headers: {
        'Referer': 'https://www.oref.org.il/',
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/javascript, */*; q=0.01'
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const contentType = response.headers.get('content-type');
    if (!contentType || !contentType.includes('application/json')) {
      const text = await response.text();
      console.error('Received non-JSON response from Pikud HaOref:', text.substring(0, 100));
      throw new Error('Received non-JSON response from Pikud HaOref');
    }

    const data = await response.json();
    const cities = Array.isArray(data) ? data.map((c: any) => typeof c === 'string' ? c : c.label || c.value).filter(Boolean) : [];
    res.json([...new Set(cities)].sort());
  } catch (error) {
    console.error('Error fetching cities:', error);
    // Return empty array instead of error object to prevent frontend crashes
    res.json([]);
  }
});

// Polling Pikud HaOref
let lastAlertId = '';
const cityLastWebhookAt = new Map<string, number>();

async function pollAlerts() {
  try {
    const response = await fetch('https://www.oref.org.il/WarningMessages/alert/alerts.json', {
      headers: {
        'Referer': 'https://www.oref.org.il/',
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
      }
    });

    if (response.status === 200) {
      const text = await response.text();
      // Pikud HaOref returns empty string if no active alerts
      if (text.trim() !== '') {
        const data = JSON.parse(text);
        if (data.id !== lastAlertId) {
          lastAlertId = data.id;
          handleAlerts(data);
        }
      }
    }
  } catch (error) {
    console.error('Error polling alerts:', error);
  }
  setTimeout(pollAlerts, 2000);
}

const CATEGORY_MAP: Record<string, string> = {
  "1": "ירי רקטות וטילים",
  "2": "חדירת מחבלים",
  "3": "חדירת כלי טיס עוין",
  "4": "אירוע רדיולוגי",
  "5": "אירוע כימי",
  "6": "אירוע ביולוגי",
  "7": "רעידת אדמה",
  "8": "צונאמי",
  "9": "אירוע חומרים מסוכנים",
  "10": "חזרה לשגרה",
  "11": "שריפה",
  "12": "אירוע רב נפגעים",
  "13": "אירוע בטחוני"
};

function nowInTimezoneForDb() {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: APP_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date());
}

function normalizeCityName(value: string) {
  return value
    .normalize('NFKC')
    .replace(/[\u0591-\u05C7]/g, '')
    .replace(/['"`׳״]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cityBaseName(value: string) {
  // Alerts may include suffixes like "<city> - <area>".
  return normalizeCityName(value).split(/\s*-\s*/)[0].trim();
}

function isCityMatch(monitoredCity: string, alertCity: string) {
  const monitoredNorm = normalizeCityName(monitoredCity);
  const alertNorm = normalizeCityName(alertCity);

  if (monitoredNorm === alertNorm) return true;

  const monitoredBase = cityBaseName(monitoredNorm);
  const alertBase = cityBaseName(alertNorm);
  return monitoredBase.length > 0 && monitoredBase === alertBase;
}

function cooldownCityKey(city: string) {
  const base = cityBaseName(city);
  return base || normalizeCityName(city);
}

function handleAlerts(alertData: any) {
  const settings = db.prepare('SELECT * FROM settings WHERE id = 1').get() as any;
  const monitoredCities = JSON.parse(settings.cities);
  const webhookUrl = settings.webhook_url;

  const alertId = alertData.id;
  const cities = alertData.data || [];
  const category = String(alertData.cat || "1");
  const categoryName = CATEGORY_MAP[category] || alertData.title || "התרעה";
  
  try {
    const enrichedData = { ...alertData, categoryName };
    db.prepare('INSERT INTO alerts (alert_id, data, timestamp) VALUES (?, ?, ?)').run(
      alertId,
      JSON.stringify(enrichedData),
      nowInTimezoneForDb()
    );
    io.emit('new_alert', enrichedData);

    const monitoredCityList = monitoredCities
      .filter((c: unknown): c is string => typeof c === 'string')
      .map((c: string) => normalizeCityName(c))
      .filter(Boolean);

    const matchedCities = cities.filter((alertCity: string) =>
      monitoredCityList.some((monitoredCity: string) => isCityMatch(monitoredCity, alertCity))
    );

    if (!webhookUrl) {
      void writeWebhookLog({
        time: new Date().toISOString(),
        status: 'SKIPPED_NO_WEBHOOK_URL',
        alertId,
        monitoredCitiesCount: monitoredCities.length,
        matchedCitiesCount: matchedCities.length
      });
      return;
    }

    if (matchedCities.length === 0) {
      void writeWebhookLog({
        time: new Date().toISOString(),
        status: 'SKIPPED_NO_CITY_MATCH',
        alertId,
        alertCitiesCount: cities.length,
        monitoredCities: monitoredCities.slice(0, 20),
        sampleAlertCities: cities.slice(0, 20)
      });
      return;
    }

    if (matchedCities.length > 0 && webhookUrl) {
      const isAllClear = category === "10";
      const nowMs = Date.now();
      const citiesToSend: string[] = [];
      const cooldownSkippedCities: string[] = [];
      const seenKeys = new Set<string>();

      for (const city of matchedCities) {
        const key = cooldownCityKey(city);
        if (!key || seenKeys.has(key)) continue;
        seenKeys.add(key);

        const lastSentAt = cityLastWebhookAt.get(key) || 0;
        if (nowMs - lastSentAt < CITY_WEBHOOK_COOLDOWN_MS) {
          cooldownSkippedCities.push(city);
          continue;
        }

        citiesToSend.push(city);
      }

      if (citiesToSend.length === 0) {
        void writeWebhookLog({
          time: new Date().toISOString(),
          status: 'SKIPPED_CITY_COOLDOWN',
          alertId,
          cooldownMs: CITY_WEBHOOK_COOLDOWN_MS,
          matchedCities: matchedCities.slice(0, 20)
        });
        return;
      }

      for (const city of citiesToSend) {
        cityLastWebhookAt.set(cooldownCityKey(city), nowMs);
      }

      if (cooldownSkippedCities.length > 0) {
        void writeWebhookLog({
          time: new Date().toISOString(),
          status: 'PARTIAL_CITY_COOLDOWN',
          alertId,
          cooldownMs: CITY_WEBHOOK_COOLDOWN_MS,
          sentCities: citiesToSend.slice(0, 20),
          skippedCities: cooldownSkippedCities.slice(0, 20)
        });
      }
      
      for (const city of citiesToSend) {
        sendWebhook(webhookUrl, {
          type: isAllClear ? 'ALL_CLEAR' : 'THREAT',
          category: category,
          categoryName: categoryName,
          title: alertData.title,
          city,
          cities: [city],
          desc: alertData.desc,
          time: new Date().toISOString()
        });
      }

      if (isAllClear) {
        io.emit('all_clear', { cities: citiesToSend });
      }
    }
  } catch (e) {
    // Ignore unique constraint errors if already processed
  }
}

async function sendWebhook(url: string, payload: any) {
  let targetUrl = url;
  try {
    const parsed = new URL(url);
    if (RUNNING_IN_DOCKER && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')) {
      parsed.hostname = 'host.docker.internal';
      targetUrl = parsed.toString();
    }
  } catch {
    // Keep original URL if it is not a valid URL string.
  }

  const logEntryBase = {
    time: new Date().toISOString(),
    url: targetUrl,
    type: payload?.type ?? 'UNKNOWN',
    cities: payload?.cities ?? []
  };

  try {
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    await writeWebhookLog({
      ...logEntryBase,
      status: response.status,
      ok: response.ok
    });
    console.log('Webhook sent:', payload.type);
  } catch (error) {
    await writeWebhookLog({
      ...logEntryBase,
      status: 'FAILED',
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
    console.error('Webhook failed:', error);
  }
}

async function writeWebhookLog(entry: Record<string, unknown>) {
  try {
    await mkdir(path.dirname(WEBHOOK_LOG_PATH), { recursive: true });
    await appendFile(WEBHOOK_LOG_PATH, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch (error) {
    console.error('Webhook log write failed:', error);
  }
}

// Start polling
pollAlerts();

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: { server }
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static('dist'));
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
