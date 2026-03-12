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
const ALL_CLEAR_CITY_WEBHOOK_COOLDOWN_MS = 10 * 60 * 1000;
let lastPollAt: string | null = null;
let lastPollOk = true;
let lastPollStatusCode: number | null = null;
let lastPollError: string | null = null;
const cityLastWebhookAt = new Map<string, {
  lastSentAtMs: number;
  cooldownMs: number;
  reason: 'DEFAULT' | 'ALL_CLEAR';
  lastType: 'THREAT' | 'ALL_CLEAR';
  lastCategory: string;
}>();

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
      const entry = cityLastWebhookAt.get(key);
      const lastSentAtMs = entry?.lastSentAtMs || 0;
      const cooldownMs = entry?.cooldownMs || CITY_WEBHOOK_COOLDOWN_MS;
      const remainingMs = Math.max(0, cooldownMs - (nowMs - lastSentAtMs));
      const active = remainingMs > 0;
      return {
        city,
        key,
        active,
        cooldownMs,
        reason: entry?.reason || null,
        remainingMs,
        lastSentAt: lastSentAtMs ? new Date(lastSentAtMs).toISOString() : null
      };
    });

  const active = Array.from(cityLastWebhookAt.entries())
    .map(([key, entry]) => {
      const remainingMs = Math.max(0, entry.cooldownMs - (nowMs - entry.lastSentAtMs));
      return {
        key,
        active: remainingMs > 0,
        cooldownMs: entry.cooldownMs,
        reason: entry.reason,
        remainingMs,
        lastSentAt: new Date(entry.lastSentAtMs).toISOString()
      };
    })
    .filter((entry) => entry.active)
    .sort((a, b) => b.remainingMs - a.remainingMs);

  res.json({
    defaultCooldownMs: CITY_WEBHOOK_COOLDOWN_MS,
    allClearCooldownMs: ALL_CLEAR_CITY_WEBHOOK_COOLDOWN_MS,
    now: new Date(nowMs).toISOString(),
    monitored,
    active
  });
});

app.get('/api/system/status', (req, res) => {
  const settings = db.prepare('SELECT * FROM settings WHERE id = 1').get() as any;
  const monitoredCities = JSON.parse(settings.cities || '[]');
  const monitoredCityList = (Array.isArray(monitoredCities) ? monitoredCities : [])
    .filter((c: unknown): c is string => typeof c === 'string');

  const nowMs = Date.now();
  const activeCooldownCount = Array.from(cityLastWebhookAt.values()).reduce((count, entry) => {
    const remainingMs = Math.max(0, entry.cooldownMs - (nowMs - entry.lastSentAtMs));
    return count + (remainingMs > 0 ? 1 : 0);
  }, 0);

  const latestRow = db.prepare('SELECT * FROM alerts ORDER BY id DESC LIMIT 1').get() as any;
  let latestAlert: Record<string, unknown> | null = null;

  if (latestRow?.data) {
    try {
      const parsed = JSON.parse(latestRow.data);
      latestAlert = {
        id: latestRow.id,
        alertId: parsed?.id || latestRow.alert_id || null,
        timestamp: latestRow.timestamp || null,
        category: String(parsed?.cat || ''),
        categoryName: parsed?.categoryName || parsed?.title || null,
        cities: Array.isArray(parsed?.data) ? parsed.data.length : 0
      };
    } catch {
      latestAlert = {
        id: latestRow.id,
        timestamp: latestRow.timestamp || null
      };
    }
  }

  res.json({
    now: new Date(nowMs).toISOString(),
    poll: {
      lastPollAt,
      ok: lastPollOk,
      statusCode: lastPollStatusCode,
      error: lastPollError
    },
    webhookConfigured: Boolean(settings.webhook_url),
    monitoredCitiesCount: monitoredCityList.length,
    defaultCooldownMs: CITY_WEBHOOK_COOLDOWN_MS,
    allClearCooldownMs: ALL_CLEAR_CITY_WEBHOOK_COOLDOWN_MS,
    activeCooldownCount,
    latestAlert
  });
});

app.get('/api/alerts/history', (req, res) => {
  const rawLimit = Number(req.query.limit);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 200) : 50;
  const rawCursor = Number(req.query.cursor);
  const hasCursor = Number.isFinite(rawCursor) && rawCursor > 0;

  const query = hasCursor
    ? 'SELECT * FROM alerts WHERE id < ? ORDER BY id DESC LIMIT ?'
    : 'SELECT * FROM alerts ORDER BY id DESC LIMIT ?';
  const alerts = hasCursor
    ? db.prepare(query).all(rawCursor, limit) as any[]
    : db.prepare(query).all(limit) as any[];

  const items = alerts.map((a) => ({ ...a, data: JSON.parse(a.data) }));
  const nextCursor = items.length > 0 ? items[items.length - 1].id : null;

  res.json({
    items,
    nextCursor,
    hasMore: items.length === limit
  });
});

app.get('/api/alerts/daily-summary', async (req, res) => {
  const MERGE_WINDOW_MS = 10 * 60 * 1000;
  const MISSILE_CATEGORY = '1';
  const rawDays = Number(req.query.days);
  const days = Number.isFinite(rawDays) ? Math.min(Math.max(rawDays, 1), 365) : 30;
  const now = new Date();
  const fromMs = now.getTime() - days * 24 * 60 * 60 * 1000;

  const parseOrefDateToMs = (value: string) => {
    const orefMatch = value.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
    if (orefMatch) {
      const [, y, m, d, hh, mm, ss] = orefMatch;
      return new Date(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss)).getTime();
    }
    return new Date(value).getTime();
  };

  const toCityList = (value: unknown) => {
    if (Array.isArray(value)) {
      return value.filter((c: unknown): c is string => typeof c === 'string');
    }
    if (typeof value !== 'string') {
      return [];
    }
    return value
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);
  };

  try {
    const response = await fetch('https://www.oref.org.il/warningMessages/alert/History/AlertsHistory.json', {
      headers: {
        'Referer': 'https://www.oref.org.il/',
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/javascript, */*; q=0.01'
      }
    });

    if (!response.ok) {
      res.status(502).json({
        error: 'Failed to fetch daily summary from Pikud HaOref',
        status: response.status
      });
      return;
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      const rawText = await response.text();
      console.error('Received non-JSON history payload from Pikud HaOref:', rawText.slice(0, 120));
      res.status(502).json({ error: 'Invalid daily summary payload from Pikud HaOref' });
      return;
    }

    const history = await response.json() as Array<{
      alertDate?: string;
      category?: number | string;
      data?: unknown;
    }>;

    const dailyMap = new Map<string, {
      day: string;
      cityTimestamps: Map<string, number[]>;
    }>();

    for (const item of Array.isArray(history) ? history : []) {
      if (String(item?.category ?? '') !== MISSILE_CATEGORY) {
        continue;
      }

      const tsMs = parseOrefDateToMs(String(item?.alertDate || ''));
      if (!Number.isFinite(tsMs) || tsMs < fromMs) {
        continue;
      }

      const day = new Date(tsMs).toISOString().slice(0, 10);
      const uniqueAlertCities = Array.from(new Set(
        toCityList(item?.data)
          .map((city) => normalizeCityName(city))
          .filter(Boolean)
      ));

      if (uniqueAlertCities.length === 0) {
        continue;
      }

      if (!dailyMap.has(day)) {
        dailyMap.set(day, {
          day,
          cityTimestamps: new Map()
        });
      }

      const dayEntry = dailyMap.get(day)!;
      for (const city of uniqueAlertCities) {
        if (!dayEntry.cityTimestamps.has(city)) {
          dayEntry.cityTimestamps.set(city, []);
        }
        dayEntry.cityTimestamps.get(city)!.push(tsMs);
      }
    }

    const daysSummary = Array.from(dailyMap.values())
      .sort((a, b) => b.day.localeCompare(a.day))
      .map((dayEntry) => {
        const cities = Array.from(dayEntry.cityTimestamps.entries()).map(([city, timestamps]) => {
          const sorted = [...timestamps].sort((a, b) => a - b);
          let mergedCount = 0;
          let lastTs = -Infinity;
          for (const t of sorted) {
            if (t - lastTs >= MERGE_WINDOW_MS) {
              mergedCount += 1;
            }
            lastTs = t;
          }
          return {
            city,
            alertsCount: mergedCount,
            missileCount: mergedCount
          };
        }).sort((a, b) => b.missileCount - a.missileCount || b.alertsCount - a.alertsCount || a.city.localeCompare(b.city));

        const totalMerged = cities.reduce((sum, c) => sum + c.missileCount, 0);
        return {
          day: dayEntry.day,
          category: MISSILE_CATEGORY,
          categoryName: CATEGORY_MAP[MISSILE_CATEGORY] || 'Missiles and rockets',
          mergeWindowMinutes: 10,
          alertsCount: totalMerged,
          missileCount: totalMerged,
          cities
        };
      });

    res.json({
      days,
      generatedAt: new Date().toISOString(),
      items: daysSummary
    });
  } catch (error) {
    console.error('Failed to build daily summary from Pikud HaOref history:', error);
    res.status(502).json({
      error: 'Failed to fetch daily summary from Pikud HaOref'
    });
  }
});

app.get('/api/alerts/by-city', (req, res) => {
  const city = String(req.query.city || '').trim();
  if (!city) {
    res.status(400).json({ error: 'city is required' });
    return;
  }

  const rawLimit = Number(req.query.limit);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 200) : 50;
  const rawCursor = Number(req.query.cursor);
  const initialCursor = Number.isFinite(rawCursor) && rawCursor > 0 ? rawCursor : Number.MAX_SAFE_INTEGER;

  const chunkSize = 300;
  const targetCount = limit + 1;
  const matched: any[] = [];
  let scanCursor = initialCursor;
  let reachedEnd = false;

  while (matched.length < targetCount) {
    const rows = db.prepare('SELECT * FROM alerts WHERE id < ? ORDER BY id DESC LIMIT ?').all(scanCursor, chunkSize) as any[];
    if (rows.length === 0) {
      reachedEnd = true;
      break;
    }

    for (const row of rows) {
      scanCursor = row.id;
      let parsed: any;
      try {
        parsed = JSON.parse(row.data);
      } catch {
        continue;
      }

      const cities = Array.isArray(parsed?.data) ? parsed.data.filter((c: unknown): c is string => typeof c === 'string') : [];
      const hasCity = cities.some((alertCity: string) => isCityMatch(city, alertCity));
      if (!hasCity) continue;

      matched.push({ ...row, data: parsed });
      if (matched.length >= targetCount) break;
    }
  }

  const hasMore = matched.length > limit || !reachedEnd;
  const items = matched.slice(0, limit);
  const nextCursor = items.length > 0 ? items[items.length - 1].id : null;

  res.json({
    city,
    items,
    nextCursor,
    hasMore
  });
});

app.post('/api/webhook/test', async (req, res) => {
  const settings = db.prepare('SELECT * FROM settings WHERE id = 1').get() as any;
  const webhookUrl = settings.webhook_url;
  const city = req.body?.city || 'באר יעקב';

  if (!webhookUrl) {
    res.status(400).json({ success: false, error: 'webhook_url is not configured' });
    return;
  }

  const result = await sendWebhook(webhookUrl, {
    type: 'TEST',
    category: '0',
    categoryName: 'בדיקת חיבור',
    title: 'Webhook test',
    cities: [city],
    desc: 'Manual webhook connectivity test',
    time: new Date().toISOString()
  });

  if (!result.ok) {
    res.status(502).json({ success: false, error: result.error || `webhook failed (${result.status ?? 'unknown'})` });
    return;
  }

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

async function pollAlerts() {
  try {
    lastPollAt = new Date().toISOString();
    const response = await fetch('https://www.oref.org.il/WarningMessages/alert/alerts.json', {
      headers: {
        'Referer': 'https://www.oref.org.il/',
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
      }
    });

    lastPollStatusCode = response.status;
    lastPollOk = response.ok;
    lastPollError = response.ok ? null : `HTTP ${response.status}`;

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
    lastPollAt = new Date().toISOString();
    lastPollOk = false;
    lastPollStatusCode = null;
    lastPollError = error instanceof Error ? error.message : String(error);
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
  // Prefer title from Oref payload; local map is fallback only.
  const categoryName = alertData.title || CATEGORY_MAP[category] || "התרעה";
  
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
      .map((c: string) => ({
        original: c.trim(),
        normalized: normalizeCityName(c)
      }))
      .filter((c: { original: string; normalized: string }) => c.original.length > 0 && c.normalized.length > 0);

    const matchedAlertCities = cities.filter((alertCity: string) =>
      monitoredCityList.some((monitoredCity: { normalized: string }) => isCityMatch(monitoredCity.normalized, alertCity))
    );
    const matchedMonitoredCities = monitoredCityList
      .filter((monitoredCity: { normalized: string }) =>
        cities.some((alertCity: string) => isCityMatch(monitoredCity.normalized, alertCity))
      )
      .map((monitoredCity: { original: string }) => monitoredCity.original);

    if (!webhookUrl) {
      void writeWebhookLog({
        time: new Date().toISOString(),
        status: 'SKIPPED_NO_WEBHOOK_URL',
        alertId,
        monitoredCitiesCount: monitoredCities.length,
        matchedCitiesCount: matchedMonitoredCities.length
      });
      return;
    }

    if (matchedMonitoredCities.length === 0) {
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

    if (matchedMonitoredCities.length > 0 && webhookUrl) {
      const isAllClear = category === "10";
      const cooldownMsForAlert = isAllClear ? ALL_CLEAR_CITY_WEBHOOK_COOLDOWN_MS : CITY_WEBHOOK_COOLDOWN_MS;
      const nowMs = Date.now();
      const citiesToSend: string[] = [];
      const cooldownSkippedCities: string[] = [];
      const allClearPreconditionSkippedCities: string[] = [];
      const seenKeys = new Set<string>();

      for (const city of matchedMonitoredCities) {
        const key = cooldownCityKey(city);
        if (!key || seenKeys.has(key)) continue;
        seenKeys.add(key);

        const cooldownEntry = cityLastWebhookAt.get(key);

        if (isAllClear) {
          const hadPreviousMissileThreat =
            cooldownEntry?.lastType === 'THREAT' &&
            String(cooldownEntry?.lastCategory || '') === '1';
          if (!hadPreviousMissileThreat) {
            allClearPreconditionSkippedCities.push(city);
            continue;
          }
        }

        const lastSentAt = cooldownEntry?.lastSentAtMs || 0;
        const activeCooldownMs = cooldownEntry?.cooldownMs || CITY_WEBHOOK_COOLDOWN_MS;
        if (nowMs - lastSentAt < activeCooldownMs) {
          cooldownSkippedCities.push(city);
          continue;
        }

        citiesToSend.push(city);
      }

      if (citiesToSend.length === 0) {
        if (isAllClear && allClearPreconditionSkippedCities.length > 0) {
          void writeWebhookLog({
            time: new Date().toISOString(),
            status: 'SKIPPED_ALL_CLEAR_NO_PREVIOUS_MISSILE_THREAT',
            alertId,
            skippedCities: allClearPreconditionSkippedCities.slice(0, 20)
          });
          return;
        }

        void writeWebhookLog({
          time: new Date().toISOString(),
          status: 'SKIPPED_CITY_COOLDOWN',
          alertId,
          cooldownMs: cooldownMsForAlert,
          matchedCities: matchedMonitoredCities.slice(0, 20)
        });
        return;
      }

      for (const city of citiesToSend) {
        cityLastWebhookAt.set(cooldownCityKey(city), {
          lastSentAtMs: nowMs,
          cooldownMs: cooldownMsForAlert,
          reason: isAllClear ? 'ALL_CLEAR' : 'DEFAULT',
          lastType: isAllClear ? 'ALL_CLEAR' : 'THREAT',
          lastCategory: String(category || '')
        });
      }

      if (cooldownSkippedCities.length > 0) {
        void writeWebhookLog({
          time: new Date().toISOString(),
          status: 'PARTIAL_CITY_COOLDOWN',
          alertId,
          cooldownMs: cooldownMsForAlert,
          sentCities: citiesToSend.slice(0, 20),
          skippedCities: cooldownSkippedCities.slice(0, 20)
        });
      }

      if (isAllClear && allClearPreconditionSkippedCities.length > 0) {
        void writeWebhookLog({
          time: new Date().toISOString(),
          status: 'PARTIAL_ALL_CLEAR_NO_PREVIOUS_MISSILE_THREAT',
          alertId,
          sentCities: citiesToSend.slice(0, 20),
          skippedCities: allClearPreconditionSkippedCities.slice(0, 20)
        });
      }
      
      for (const city of citiesToSend) {
        sendWebhook(webhookUrl, {
          type: isAllClear ? 'ALL_CLEAR' : 'THREAT',
          category: category,
          categoryName: categoryName,
          title: alertData.title,
          city,
          // Always include all matched monitored cities in payload, even when some are in cooldown.
          cities: matchedMonitoredCities,
          sentCities: citiesToSend,
          skippedCities: cooldownSkippedCities,
          matchedAlertCities: matchedAlertCities.slice(0, 50),
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

async function sendWebhook(url: string, payload: any): Promise<{ ok: boolean; status?: number; error?: string }> {
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
    return { ok: response.ok, status: response.status };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await writeWebhookLog({
      ...logEntryBase,
      status: 'FAILED',
      ok: false,
      error: errorMessage
    });
    console.error('Webhook failed:', error);
    return { ok: false, error: errorMessage };
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

