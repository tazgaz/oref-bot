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
type GeoPoint = [number, number];
type PolygonCoordinates = GeoPoint[][];
type MultiPolygonCoordinates = GeoPoint[][][];
type CityPolygonItem = {
  city: string;
  sourceCity: string;
  geometryType: 'Polygon' | 'MultiPolygon';
  coordinates: PolygonCoordinates | MultiPolygonCoordinates;
  bbox: [number, number, number, number];
};
const cityPolygonCache = new Map<string, CityPolygonItem | null>();

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

app.get('/api/alerts/daily-summary', (req, res) => {
  const MERGE_WINDOW_MS = 10 * 60 * 1000;
  const MISSILE_CATEGORY = '1';
  const rawDays = Number(req.query.days);
  const days = Number.isFinite(rawDays) ? Math.min(Math.max(rawDays, 1), 365) : 30;
  const settings = db.prepare('SELECT * FROM settings WHERE id = 1').get() as any;
  const monitoredCities = JSON.parse(settings.cities || '[]');
  const monitoredCityList = (Array.isArray(monitoredCities) ? monitoredCities : [])
    .filter((c: unknown): c is string => typeof c === 'string')
    .map((c: string) => normalizeCityName(c))
    .filter(Boolean);
  const rows = db.prepare('SELECT * FROM alerts ORDER BY id DESC').all() as any[];
  const now = new Date();
  const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  const dailyMap = new Map<string, {
    day: string;
    cityTimestamps: Map<string, number[]>;
  }>();

  const toTimestampMs = (value: string) => {
    const localDbMatch = value.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
    if (localDbMatch) {
      const [, y, m, d, hh, mm, ss] = localDbMatch;
      return new Date(`${y}-${m}-${d}T${hh}:${mm}:${ss}+02:00`).getTime();
    }
    return new Date(value).getTime();
  };

  for (const row of rows) {
    let parsed: any;
    try {
      parsed = JSON.parse(row.data);
    } catch {
      continue;
    }

    if (String(parsed?.cat || '') !== MISSILE_CATEGORY) {
      continue;
    }

    const cities = Array.isArray(parsed?.data) ? parsed.data.filter((c: unknown): c is string => typeof c === 'string') : [];
    const ts = String(row.timestamp || '');
    const tsMs = toTimestampMs(ts);
    if (!Number.isFinite(tsMs)) continue;
    const tsDate = new Date(tsMs);
    if (tsDate < from) continue;
    const day = tsDate.toISOString().slice(0, 10);

    const matchedMonitoredCities = cities
      .map((alertCity: string) => monitoredCityList.find((monitoredCity: string) => isCityMatch(monitoredCity, alertCity)) || null)
      .filter((city: string | null): city is string => Boolean(city));
    const uniqueMatchedMonitoredCities: string[] = Array.from(new Set<string>(matchedMonitoredCities));

    if (uniqueMatchedMonitoredCities.length === 0) {
      continue;
    }

    if (!dailyMap.has(day)) {
      dailyMap.set(day, {
        day,
        cityTimestamps: new Map()
      });
    }

    const dayEntry = dailyMap.get(day)!;
    for (const city of uniqueMatchedMonitoredCities) {
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

app.get('/api/cities/polygons', async (req, res) => {
  const rawCities = String(req.query.cities || '');
  const requestedCities = rawCities
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean)
    .slice(0, 30);

  if (requestedCities.length === 0) {
    res.json({ items: [] });
    return;
  }

  const uniqueCityEntries = Array.from(new Map(
    requestedCities.map((city) => [cooldownCityKey(city), city])
  ).entries());

  const items: CityPolygonItem[] = [];
  for (const [cityKey, requestedCity] of uniqueCityEntries) {
    if (!cityKey) continue;
    let polygon = cityPolygonCache.get(cityKey);
    if (polygon === undefined) {
      polygon = await fetchCityPolygonFromOsm(requestedCity);
      cityPolygonCache.set(cityKey, polygon ?? null);
    }

    if (polygon) {
      items.push({
        ...polygon,
        city: requestedCity
      });
    }
  }

  res.json({ items });
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
      const rawText = await response.text();
      // Oref occasionally returns empty or malformed payloads (for example NUL bytes).
      const cleanedText = rawText.replace(/\u0000/g, '').trim();
      if (cleanedText !== '') {
        let data: any = null;
        try {
          data = JSON.parse(cleanedText);
        } catch {
          lastPollOk = false;
          lastPollError = 'Malformed JSON from Oref alerts endpoint';
          setTimeout(pollAlerts, 2000);
          return;
        }

        if (data?.id && data.id !== lastAlertId) {
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

function getGeometryBbox(coords: PolygonCoordinates | MultiPolygonCoordinates, type: 'Polygon' | 'MultiPolygon') {
  let minLon = Number.POSITIVE_INFINITY;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLon = Number.NEGATIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;

  const rings = type === 'Polygon'
    ? coords as PolygonCoordinates
    : (coords as MultiPolygonCoordinates).flat();

  for (const ring of rings) {
    for (const point of ring) {
      const lon = Number(point?.[0]);
      const lat = Number(point?.[1]);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      minLon = Math.min(minLon, lon);
      minLat = Math.min(minLat, lat);
      maxLon = Math.max(maxLon, lon);
      maxLat = Math.max(maxLat, lat);
    }
  }

  if (!Number.isFinite(minLon) || !Number.isFinite(minLat) || !Number.isFinite(maxLon) || !Number.isFinite(maxLat)) {
    return null;
  }
  return [minLon, minLat, maxLon, maxLat] as [number, number, number, number];
}

async function fetchCityPolygonFromOsm(city: string): Promise<CityPolygonItem | null> {
  const queryCity = cityBaseName(city) || city;
  if (!queryCity) return null;

  try {
    const escapedCity = queryCity.replace(/["\\]/g, '');
    const query = `
[out:json][timeout:25];
area["ISO3166-1"="IL"]["admin_level"="2"]->.a;
(
  relation["boundary"="administrative"]["admin_level"~"7|8"]["name"="${escapedCity}"](area.a);
  relation["boundary"="administrative"]["admin_level"~"7|8"]["name:he"="${escapedCity}"](area.a);
  way["boundary"="administrative"]["admin_level"~"7|8"]["name"="${escapedCity}"](area.a);
  way["boundary"="administrative"]["admin_level"~"7|8"]["name:he"="${escapedCity}"](area.a);
);
out geom;
`.trim();

    const response = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: {
        'User-Agent': 'oref-alerts/1.0 (city-polygon-fetch-overpass)',
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: `data=${encodeURIComponent(query)}`
    });

    if (!response.ok) return null;
    const payload = await response.json() as any;
    const elements = Array.isArray(payload?.elements) ? payload.elements : [];

    const rings: GeoPoint[][] = [];
    for (const element of elements) {
      if (element?.type === 'relation' && Array.isArray(element?.members)) {
        for (const member of element.members) {
          if (member?.role === 'inner') continue;
          if (!Array.isArray(member?.geometry)) continue;
          const ring = member.geometry
            .map((point: any) => [Number(point?.lon), Number(point?.lat)] as GeoPoint)
            .filter((point: GeoPoint) => Number.isFinite(point[0]) && Number.isFinite(point[1]));
          if (ring.length >= 3) rings.push(ring);
        }
      }

      if (element?.type === 'way' && Array.isArray(element?.geometry)) {
        const ring = element.geometry
          .map((point: any) => [Number(point?.lon), Number(point?.lat)] as GeoPoint)
          .filter((point: GeoPoint) => Number.isFinite(point[0]) && Number.isFinite(point[1]));
        if (ring.length >= 3) rings.push(ring);
      }
    }

    if (rings.length === 0) return null;

    const coordinates = rings as PolygonCoordinates;
    const bbox = getGeometryBbox(coordinates, 'Polygon');
    if (!bbox) return null;

    return {
      city: queryCity,
      sourceCity: queryCity,
      geometryType: 'Polygon',
      coordinates,
      bbox
    };
  } catch (error) {
    console.error('Failed to fetch city polygon:', city, error);
    return null;
  }
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

