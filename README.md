# Oref Bot - התרעות פיקוד העורף

אפליקציה לניטור התרעות פיקוד העורף, סינון לפי יישובים, ושליחת Webhook אוטומטי ל-n8n או לכל endpoint אחר.

## מה האפליקציה עושה

- מושכת התרעות בזמן אמת מ-`alerts.json` של פיקוד העורף.
- מסננת רק לפי היישובים שהוגדרו במערכת.
- שולחת Webhook נפרד לכל עיר (לא מאוחד).
- כוללת מנגנון `cooldown` של 3 דקות לכל עיר כדי למנוע כפילויות.
- תומכת בהודעות `THREAT`, `ALL_CLEAR` וגם `TEST`.
- שומרת היסטוריית התרעות ב-SQLite ולוגים של webhook בקובץ.

## טכנולוגיות

- Node.js + Express
- Vite + React (ממשק ניהול)
- SQLite (`better-sqlite3`)
- Docker + Docker Compose

## הרצה עם Docker (מומלץ)

```bash
docker compose up -d --build
```

האפליקציה תהיה זמינה ב:

- UI/API דרך host: `http://localhost:3002`
- בתוך קונטיינר: `http://localhost:3000`

## הרצה מקומית (ללא Docker)

```bash
npm install
npm run dev
```

## הגדרות חשובות

- `DB_PATH` - נתיב קובץ SQLite (ברירת מחדל: `alerts.db`)
- `WEBHOOK_LOG_PATH` - נתיב קובץ לוג webhook (ברירת מחדל: `logs/webhook.log`)
- `TZ` - אזור זמן (ברירת מחדל: `Asia/Jerusalem`)
- `RUNNING_IN_CONTAINER` - כשווה `true`, המערכת תחליף `localhost` ל-`host.docker.internal` עבור webhook

## נתיבי API עיקריים

- `GET /api/settings` - קבלת הגדרות
- `POST /api/settings` - שמירת יישובים ו-Webhook URL
- `GET /api/cities` - רשימת יישובים (עם fallback לרשימה מקומית)
- `GET /api/alerts/history` - היסטוריית התרעות
- `POST /api/webhook/test` - בדיקת webhook ידנית
- `GET /api/cooldown/status` - מצב cooldown לכל עיר

## מבנה payload שנשלח ל-Webhook

דוגמה להתרעה:

```json
{
  "type": "THREAT",
  "category": "1",
  "categoryName": "ירי רקטות וטילים",
  "title": "ירי רקטות וטילים",
  "city": "באר יעקב",
  "cities": ["באר יעקב"],
  "desc": "היכנסו למרחב מוגן...",
  "time": "2026-02-28T11:35:00.000Z"
}
```

## הערות

- הרשימה בממשק תומכת גם בהוספה ידנית של יישוב (Enter או כפתור `+`).
- אם לא מוגדר `webhook_url`, לא תתבצע שליחה.
- לוגי שליחה נכתבים ל-`logs/webhook.log`.
