import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import {
  BarChart3,
  Bell,
  CheckCircle,
  Loader2,
  Plus,
  RefreshCw,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Siren,
  TestTube2,
  Trash2,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { ISRAEL_CITIES } from './constants/cities';

const socket = io();
const ALERTS_PAGE_SIZE = 50;

type TabKey = 'dashboard' | 'daily' | 'settings';

type AlertItem = {
  id?: number;
  alert_id?: string;
  timestamp: string;
  data: {
    id?: string;
    cat?: string;
    title?: string;
    categoryName?: string;
    data?: string[];
    desc?: string;
  };
};

type DailyCityItem = {
  city: string;
  alertsCount: number;
  missileCount: number;
};

type DailySummaryItem = {
  day: string;
  alertsCount: number;
  missileCount: number;
  category?: string;
  categoryName?: string;
  mergeWindowMinutes?: number;
  cities: DailyCityItem[];
};

type FeedbackType = 'success' | 'warning' | 'error';

type SystemStatus = {
  poll?: {
    lastPollAt?: string | null;
    ok?: boolean;
    error?: string | null;
  };
  webhookConfigured?: boolean;
  monitoredCitiesCount?: number;
  activeCooldownCount?: number;
  latestAlert?: {
    category?: string;
  } | null;
};

function formatInIsraelTimezone(date: Date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jerusalem',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);

  const get = (type: string) => parts.find((p) => p.type === type)?.value || '';
  return `${get('hour')}:${get('minute')}:${get('second')} ${get('day')}/${get('month')}/${get('year')}`;
}

function formatAlertTimestamp(value: string) {
  const localDbMatch = value.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}:\d{2}:\d{2})$/);
  if (localDbMatch) {
    const [, year, month, day, time] = localDbMatch;
    return `${time} ${day}/${month}/${year}`;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return formatInIsraelTimezone(date);
}

function formatDayLabel(day: string) {
  const m = day.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return day;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

function formatRelative(isoValue: string | null | undefined) {
  if (!isoValue) return 'לא ידוע';
  const d = new Date(isoValue);
  if (Number.isNaN(d.getTime())) return 'לא ידוע';
  const diffSec = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (diffSec < 5) return 'הרגע';
  if (diffSec < 60) return `לפני ${diffSec} שנ׳`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `לפני ${diffMin} דק׳`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `לפני ${diffHour} שעות`;
  return formatAlertTimestamp(isoValue);
}

function isValidWebhookUrl(value: string) {
  if (!value.trim()) return true;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

export default function App() {
  const [activeTab, setActiveTab] = useState<TabKey>('dashboard');
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [alertsCursor, setAlertsCursor] = useState<number | null>(null);
  const [alertsHasMore, setAlertsHasMore] = useState(true);
  const [alertsLoadingInitial, setAlertsLoadingInitial] = useState(false);
  const [alertsLoadingMore, setAlertsLoadingMore] = useState(false);
  const [socketConnected, setSocketConnected] = useState(socket.connected);
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);

  const [dailySummary, setDailySummary] = useState<DailySummaryItem[]>([]);
  const [dailyDays, setDailyDays] = useState(90);
  const [dailyLoading, setDailyLoading] = useState(false);
  const [selectedSummaryCity, setSelectedSummaryCity] = useState<string | null>(null);
  const [selectedCityAlerts, setSelectedCityAlerts] = useState<AlertItem[]>([]);
  const [selectedCityAlertsCursor, setSelectedCityAlertsCursor] = useState<number | null>(null);
  const [selectedCityAlertsHasMore, setSelectedCityAlertsHasMore] = useState(false);
  const [selectedCityAlertsLoading, setSelectedCityAlertsLoading] = useState(false);
  const [selectedCityAlertsLoadingMore, setSelectedCityAlertsLoadingMore] = useState(false);

  const [cities, setCities] = useState<string[]>([]);
  const [webhookUrl, setWebhookUrl] = useState('');
  const [newCity, setNewCity] = useState('');
  const [allCities, setAllCities] = useState<string[]>([]);
  const [filteredCities, setFilteredCities] = useState<string[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isTestingWebhook, setIsTestingWebhook] = useState(false);
  const [saveFeedback, setSaveFeedback] = useState<{ type: FeedbackType; text: string } | null>(null);
  const [testFeedback, setTestFeedback] = useState<{ type: FeedbackType; text: string } | null>(null);

  const loadMoreRef = useRef<HTMLDivElement | null>(null);

  const webhookUrlError = useMemo(() => {
    if (!webhookUrl.trim()) return null;
    return isValidWebhookUrl(webhookUrl) ? null : 'כתובת Webhook לא תקינה (נדרש http:// או https://)';
  }, [webhookUrl]);

  const upsertAlerts = useCallback((incoming: AlertItem[], append: boolean) => {
    setAlerts((prev) => {
      const base = append ? [...prev] : [];
      const seen = new Set(base.map((a) => a.alert_id || String(a.id || '')));
      for (const item of incoming) {
        const key = item.alert_id || String(item.id || '');
        if (seen.has(key)) continue;
        base.push(item);
        seen.add(key);
      }
      return base;
    });
  }, []);

  const fetchSystemStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/system/status');
      if (!res.ok) return;
      const data = await res.json();
      setSystemStatus(data || null);
    } catch {
      // Keep previous status when fetch fails.
    }
  }, []);

  const fetchAlertsPage = useCallback(async (cursor: number | null, append: boolean) => {
    if (append) {
      setAlertsLoadingMore(true);
    } else {
      setAlertsLoadingInitial(true);
    }

    try {
      const params = new URLSearchParams();
      params.set('limit', String(ALERTS_PAGE_SIZE));
      if (cursor) params.set('cursor', String(cursor));

      const res = await fetch(`/api/alerts/history?${params.toString()}`);
      const data = await res.json();
      const items: AlertItem[] = Array.isArray(data?.items) ? data.items : [];

      upsertAlerts(items, append);
      setAlertsCursor(typeof data?.nextCursor === 'number' ? data.nextCursor : null);
      setAlertsHasMore(Boolean(data?.hasMore));
    } catch (err) {
      console.error('Failed to fetch alerts page', err);
    } finally {
      if (append) {
        setAlertsLoadingMore(false);
      } else {
        setAlertsLoadingInitial(false);
      }
    }
  }, [upsertAlerts]);

  const fetchDailySummary = useCallback(async (days: number) => {
    setDailyLoading(true);
    try {
      const res = await fetch(`/api/alerts/daily-summary?days=${days}`);
      const data = await res.json();
      setDailySummary(Array.isArray(data?.items) ? data.items : []);
    } catch (err) {
      console.error('Failed to fetch daily summary', err);
    } finally {
      setDailyLoading(false);
    }
  }, []);

  const fetchCityAlerts = useCallback(async (city: string, cursor: number | null, append: boolean) => {
    if (!city) return;
    if (append) {
      setSelectedCityAlertsLoadingMore(true);
    } else {
      setSelectedCityAlertsLoading(true);
    }

    try {
      const params = new URLSearchParams();
      params.set('city', city);
      params.set('limit', '30');
      if (cursor) params.set('cursor', String(cursor));

      const res = await fetch(`/api/alerts/by-city?${params.toString()}`);
      const data = await res.json();
      const items: AlertItem[] = Array.isArray(data?.items) ? data.items : [];

      setSelectedSummaryCity(city);
      setSelectedCityAlerts((prev) => {
        if (!append) return items;
        const merged = [...prev];
        const seen = new Set(merged.map((a) => a.alert_id || String(a.id || '')));
        for (const item of items) {
          const key = item.alert_id || String(item.id || '');
          if (seen.has(key)) continue;
          merged.push(item);
          seen.add(key);
        }
        return merged;
      });
      setSelectedCityAlertsCursor(typeof data?.nextCursor === 'number' ? data.nextCursor : null);
      setSelectedCityAlertsHasMore(Boolean(data?.hasMore));
    } catch (err) {
      console.error('Failed to fetch city alerts', err);
    } finally {
      if (append) {
        setSelectedCityAlertsLoadingMore(false);
      } else {
        setSelectedCityAlertsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    document.title = 'התרעות פיקוד העורף בוט';
    const iconEl = document.querySelector("link[rel='icon']") as HTMLLinkElement | null;
    if (iconEl) {
      iconEl.href = '/favicon-missile.svg?v=4';
    }

    fetch('/api/settings')
      .then((res) => res.json())
      .then((data) => {
        setCities(data.cities || []);
        setWebhookUrl(data.webhookUrl || data.webhook_url || '');
      });

    fetch('/api/cities')
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data) && data.length > 0) {
          setAllCities(data);
        } else {
          setAllCities(ISRAEL_CITIES);
        }
      })
      .catch((err) => {
        console.error('Failed to fetch cities', err);
        setAllCities(ISRAEL_CITIES);
      });

    fetchAlertsPage(null, false);
    void fetchSystemStatus();

    const onNewAlert = (alertData: any) => {
      const liveItem: AlertItem = {
        alert_id: alertData.id,
        data: alertData,
        timestamp: new Date().toISOString(),
      };
      setAlerts((prev) => [liveItem, ...prev.filter((a) => a.alert_id !== liveItem.alert_id)]);
      void fetchSystemStatus();
    };

    const onSocketConnect = () => setSocketConnected(true);
    const onSocketDisconnect = () => setSocketConnected(false);

    socket.on('new_alert', onNewAlert);
    socket.on('connect', onSocketConnect);
    socket.on('disconnect', onSocketDisconnect);
    const statusInterval = window.setInterval(() => {
      void fetchSystemStatus();
    }, 15000);

    return () => {
      socket.off('new_alert', onNewAlert);
      socket.off('connect', onSocketConnect);
      socket.off('disconnect', onSocketDisconnect);
      window.clearInterval(statusInterval);
    };
  }, [fetchAlertsPage, fetchSystemStatus]);

  useEffect(() => {
    if (activeTab === 'daily' && !dailyLoading) {
      void fetchDailySummary(dailyDays);
    }
  }, [activeTab, dailyDays, dailyLoading, fetchDailySummary]);

  useEffect(() => {
    if (!newCity.trim()) {
      setFilteredCities([]);
      setShowSuggestions(false);
      return;
    }

    const combinedList = [...new Set([...allCities, ...ISRAEL_CITIES])];
    const filtered = combinedList
      .filter((city) => city.toLowerCase().includes(newCity.toLowerCase()) && !cities.includes(city))
      .slice(0, 10);

    setFilteredCities(filtered);
    setShowSuggestions(true);
  }, [newCity, allCities, cities]);

  useEffect(() => {
    const node = loadMoreRef.current;
    if (!node) return;
    if (activeTab !== 'dashboard') return;
    if (!alertsHasMore || alertsLoadingMore || alertsLoadingInitial) return;

    const observer = new IntersectionObserver((entries) => {
      const first = entries[0];
      if (!first?.isIntersecting) return;
      if (!alertsHasMore || alertsLoadingMore || alertsLoadingInitial) return;
      void fetchAlertsPage(alertsCursor, true);
    }, { rootMargin: '300px' });

    observer.observe(node);
    return () => observer.disconnect();
  }, [activeTab, alertsCursor, alertsHasMore, alertsLoadingInitial, alertsLoadingMore, fetchAlertsPage]);

  const saveSettings = async () => {
    setSaveFeedback(null);
    if (webhookUrlError) {
      setSaveFeedback({ type: 'error', text: webhookUrlError });
      return;
    }
    if (!webhookUrl.trim()) {
      setSaveFeedback({ type: 'warning', text: 'לא הוגדרה כתובת Webhook. ללא כתובת לא תתבצע שליחה.' });
      return;
    }
    if (cities.length === 0) {
      setSaveFeedback({ type: 'warning', text: 'לא נבחרו ערים לניטור. יש לבחור לפחות יישוב אחד.' });
      return;
    }

    setIsSaving(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cities, webhook_url: webhookUrl }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSaveFeedback({ type: 'success', text: 'ההגדרות נשמרו בהצלחה.' });
      void fetchSystemStatus();
    } catch (err) {
      console.error('Failed to save settings', err);
      setSaveFeedback({ type: 'error', text: 'שמירת ההגדרות נכשלה. נסה שוב.' });
    } finally {
      setIsSaving(false);
    }
  };

  const testWebhook = async () => {
    setTestFeedback(null);

    if (webhookUrlError) {
      setTestFeedback({ type: 'error', text: webhookUrlError });
      return;
    }
    if (!webhookUrl.trim()) {
      setTestFeedback({ type: 'warning', text: 'לפני בדיקה יש להגדיר כתובת Webhook.' });
      return;
    }

    setIsTestingWebhook(true);
    try {
      const res = await fetch('/api/webhook/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ city: cities[0] || 'באר יעקב' }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload?.error || `HTTP ${res.status}`);
      setTestFeedback({ type: 'success', text: 'בדיקת ה-Webhook נשלחה בהצלחה.' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'שגיאה לא ידועה';
      setTestFeedback({ type: 'error', text: `בדיקת webhook נכשלה: ${msg}` });
    } finally {
      setIsTestingWebhook(false);
    }
  };

  const addCity = (city: string) => {
    const normalized = city.trim();
    if (normalized && !cities.includes(normalized)) {
      setCities([...cities, normalized]);
      setNewCity('');
      setShowSuggestions(false);
      setSaveFeedback(null);
    }
  };

  const removeCity = (city: string) => {
    setCities(cities.filter((c) => c !== city));
  };

  const addTypedCity = () => {
    addCity(newCity);
  };

  const groupedDaily = useMemo(() => dailySummary, [dailySummary]);

  const dailyTrend = useMemo(() => {
    const sorted = [...dailySummary].sort((a, b) => b.day.localeCompare(a.day));
    const current = sorted.slice(0, 7).reduce((sum, item) => sum + item.missileCount, 0);
    const previous = sorted.slice(7, 14).reduce((sum, item) => sum + item.missileCount, 0);
    return current - previous;
  }, [dailySummary]);

  const feedbackClass = (type: FeedbackType) => {
    if (type === 'success') return 'border-emerald-200 bg-emerald-50 text-emerald-800';
    if (type === 'warning') return 'border-amber-200 bg-amber-50 text-amber-800';
    return 'border-red-200 bg-red-50 text-red-800';
  };

  const latestCategory = String(systemStatus?.latestAlert?.category || '');
  const hasActiveThreat = Boolean(latestCategory && latestCategory !== '10');

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900 font-sans" dir="rtl">
      <header className="bg-white border-b border-zinc-200 sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between h-16 items-center">
            <div className="flex items-center gap-2">
              <ShieldAlert className="w-6 h-6 text-red-600" />
              <h1 className="text-xl font-bold tracking-tight">התרעות פיקוד העורף בוט</h1>
            </div>
            <nav className="flex gap-2 sm:gap-4">
              <button
                onClick={() => setActiveTab('dashboard')}
                className={`flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                  activeTab === 'dashboard' ? 'bg-zinc-100 text-zinc-900' : 'text-zinc-500 hover:text-zinc-900'
                }`}
              >
                <Bell className="w-4 h-4" />
                התרעות
              </button>
              <button
                onClick={() => setActiveTab('daily')}
                className={`flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                  activeTab === 'daily' ? 'bg-zinc-100 text-zinc-900' : 'text-zinc-500 hover:text-zinc-900'
                }`}
              >
                <BarChart3 className="w-4 h-4" />
                סיכום יומי
              </button>
              <button
                onClick={() => setActiveTab('settings')}
                className={`flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                  activeTab === 'settings' ? 'bg-zinc-100 text-zinc-900' : 'text-zinc-500 hover:text-zinc-900'
                }`}
              >
                <Settings className="w-4 h-4" />
                הגדרות
              </button>
            </nav>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {activeTab === 'dashboard' && (
          <div className="space-y-6">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className={`rounded-xl border p-4 ${hasActiveThreat ? 'border-red-200 bg-red-50' : 'border-emerald-200 bg-emerald-50'}`}>
                <div className="flex items-center justify-between gap-2">
                  <div className="text-sm font-medium">מצב נוכחי</div>
                  {hasActiveThreat ? <Siren className="w-5 h-5 text-red-700" /> : <ShieldCheck className="w-5 h-5 text-emerald-700" />}
                </div>
                <div className={`mt-2 text-lg font-bold ${hasActiveThreat ? 'text-red-800' : 'text-emerald-800'}`}>
                  {hasActiveThreat ? 'יש התרעה פעילה' : 'אין התרעה פעילה'}
                </div>
                <div className="mt-1 text-sm text-zinc-700">עודכן: {formatRelative(systemStatus?.poll?.lastPollAt || null)}</div>
              </div>
              <div className="rounded-xl border border-zinc-200 bg-white p-4">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-sm font-medium">בריאות מערכת</div>
                  <button
                    type="button"
                    onClick={() => fetchSystemStatus()}
                    className="text-xs px-2 py-1 border border-zinc-300 rounded-md hover:bg-zinc-100"
                  >
                    רענון
                  </button>
                </div>
                <div className="mt-2 grid grid-cols-3 gap-2 text-sm">
                  <div className="rounded-lg bg-zinc-50 border border-zinc-200 px-2 py-1.5 text-center">
                    ערים
                    <div className="font-semibold">{systemStatus?.monitoredCitiesCount ?? cities.length}</div>
                  </div>
                  <div className="rounded-lg bg-zinc-50 border border-zinc-200 px-2 py-1.5 text-center">
                    cooldown
                    <div className="font-semibold">{systemStatus?.activeCooldownCount ?? '-'}</div>
                  </div>
                  <div className="rounded-lg bg-zinc-50 border border-zinc-200 px-2 py-1.5 text-center">
                    polling
                    <div className={`font-semibold ${systemStatus?.poll?.ok === false ? 'text-red-700' : 'text-emerald-700'}`}>
                      {systemStatus?.poll?.ok === false ? 'תקלה' : 'תקין'}
                    </div>
                  </div>
                </div>
                {systemStatus?.poll?.error && (
                  <div className="mt-2 text-xs text-red-700">שגיאה: {systemStatus.poll.error}</div>
                )}
              </div>
            </div>

            <div className="flex items-center justify-between flex-wrap gap-2">
              <h2 className="text-2xl font-bold tracking-tight">כל ההתראות</h2>
              <div className="flex items-center gap-2 text-sm">
                {socketConnected ? <Wifi className="w-4 h-4 text-emerald-600" /> : <WifiOff className="w-4 h-4 text-red-600" />}
                <span className={socketConnected ? 'text-emerald-700' : 'text-red-700'}>
                  {socketConnected ? 'מחובר לשרת בזמן אמת' : 'מנותק מהשרת'}
                </span>
              </div>
            </div>

            {alertsLoadingInitial && alerts.length === 0 ? (
              <div className="text-center py-12 bg-white rounded-xl border border-zinc-200">
                טוען התראות...
              </div>
            ) : alerts.length === 0 ? (
              <div className="text-center py-12 bg-white rounded-xl border border-zinc-200">
                <CheckCircle className="w-12 h-12 text-emerald-500 mx-auto mb-4" />
                <h3 className="text-lg font-medium">אין התרעות פעילות</h3>
                <p className="text-zinc-500 mt-1">המערכת מנטרת התרעות בזמן אמת</p>
              </div>
            ) : (
              <div className="grid gap-4">
                {alerts.map((alert, i) => (
                  <div key={`${alert.alert_id || alert.id || i}`} className="bg-white p-5 rounded-xl border border-zinc-200 shadow-sm flex flex-col sm:flex-row gap-4 justify-between items-start sm:items-center">
                    <div>
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <span className={`text-xs font-medium px-2.5 py-0.5 rounded-full ${
                          alert.data?.cat === '10' ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'
                        }`}>
                          {alert.data?.title || alert.data?.categoryName || 'התרעה'}
                        </span>
                        <span className="text-sm text-zinc-500">{formatAlertTimestamp(alert.timestamp)}</span>
                      </div>
                      <p className="font-medium text-lg mt-2">{(alert.data?.data || []).join(', ')}</p>
                      <p className="text-zinc-600 text-sm mt-1">{alert.data?.desc}</p>
                    </div>
                  </div>
                ))}
                <div ref={loadMoreRef} className="h-8" />
                {alertsLoadingMore && (
                  <div className="text-center text-sm text-zinc-500 py-3">טוען עוד התראות...</div>
                )}
                {!alertsHasMore && alerts.length > 0 && (
                  <div className="text-center text-sm text-zinc-400 py-2">הגעת לסוף הרשימה</div>
                )}
              </div>
            )}
          </div>
        )}

        {activeTab === 'daily' && (
          <div className="space-y-6">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <h2 className="text-2xl font-bold tracking-tight">סיכום יומי - ירי רקטות וטילים (איחוד 10 דקות)</h2>
              <div className="flex items-center gap-2">
                {[7, 30, 90].map((days) => (
                  <button
                    key={days}
                    type="button"
                    onClick={() => setDailyDays(days)}
                    className={`px-3 py-2 rounded-md border text-sm transition-colors ${
                      dailyDays === days ? 'bg-zinc-900 text-white border-zinc-900' : 'border-zinc-300 hover:bg-zinc-100'
                    }`}
                  >
                    {days} ימים
                  </button>
                ))}
                <button
                  onClick={() => fetchDailySummary(dailyDays)}
                  className="px-3 py-2 rounded-md border border-zinc-300 text-sm hover:bg-zinc-100 transition-colors"
                >
                  רענון
                </button>
              </div>
            </div>

            <div className="bg-white rounded-xl border border-zinc-200 p-4 text-sm text-zinc-700">
              מגמה שבועית: <b className={dailyTrend > 0 ? 'text-red-700' : dailyTrend < 0 ? 'text-emerald-700' : 'text-zinc-700'}>
                {dailyTrend > 0 ? '+' : ''}{dailyTrend}
              </b> מול 7 הימים הקודמים.
            </div>

            {dailyLoading && groupedDaily.length === 0 ? (
              <div className="text-center py-10 bg-white rounded-xl border border-zinc-200">טוען סיכומים...</div>
            ) : groupedDaily.length === 0 ? (
              <div className="text-center py-10 bg-white rounded-xl border border-zinc-200">אין נתונים להצגה</div>
            ) : (
              <div className="space-y-4">
                {groupedDaily.map((day) => (
                  <div key={day.day} className="bg-white p-5 rounded-xl border border-zinc-200 shadow-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                      <h3 className="text-lg font-semibold">{formatDayLabel(day.day)}</h3>
                      <div className="text-sm text-zinc-600">
                        {day.categoryName || 'ירי רקטות וטילים'} (מאוחד &lt; 10 דק׳): <span className="font-semibold text-red-700">{day.missileCount}</span>
                      </div>
                    </div>

                    {day.cities.length === 0 ? (
                      <p className="text-sm text-zinc-500">אין ערים ליום זה</p>
                    ) : (
                      <div className="grid gap-2">
                        {day.cities.map((city) => (
                          <button
                            type="button"
                            key={`${day.day}-${city.city}`}
                            onClick={() => fetchCityAlerts(city.city, null, false)}
                            className={`flex items-center justify-between text-sm bg-zinc-50 border rounded-lg px-3 py-2 text-right transition-colors ${
                              selectedSummaryCity === city.city ? 'border-emerald-500 bg-emerald-50' : 'border-zinc-200 hover:bg-zinc-100'
                            }`}
                          >
                            <span className="font-medium">{city.city}</span>
                            <span className="text-zinc-600">
                              {day.categoryName || 'ירי רקטות וטילים'}: <b className="text-red-700">{city.missileCount}</b>
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ))}

                {selectedSummaryCity && (
                  <div className="bg-white p-5 rounded-xl border border-zinc-200 shadow-sm">
                    <div className="flex items-center justify-between gap-3 mb-3">
                      <h3 className="text-lg font-semibold">כל ההתראות עבור: {selectedSummaryCity}</h3>
                      <button
                        type="button"
                        onClick={() => fetchCityAlerts(selectedSummaryCity, null, false)}
                        className="px-3 py-1.5 rounded-md border border-zinc-300 text-sm hover:bg-zinc-100 transition-colors"
                      >
                        רענון
                      </button>
                    </div>

                    {selectedCityAlertsLoading && selectedCityAlerts.length === 0 ? (
                      <p className="text-sm text-zinc-500">טוען התראות לעיר...</p>
                    ) : selectedCityAlerts.length === 0 ? (
                      <p className="text-sm text-zinc-500">לא נמצאו התראות לעיר זו.</p>
                    ) : (
                      <div className="space-y-2">
                        {selectedCityAlerts.map((alert, i) => (
                          <div key={`${alert.alert_id || alert.id || i}`} className="border border-zinc-200 rounded-lg p-3 bg-zinc-50">
                            <div className="flex items-center gap-2 text-xs mb-1 flex-wrap">
                              <span className={`px-2 py-0.5 rounded-full ${
                                alert.data?.cat === '10' ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'
                              }`}>
                                {alert.data?.title || alert.data?.categoryName || 'התרעה'}
                              </span>
                              <span className="text-zinc-500">{formatAlertTimestamp(alert.timestamp)}</span>
                            </div>
                            <div className="text-sm font-medium">{(alert.data?.data || []).join(', ')}</div>
                            <div className="text-xs text-zinc-600 mt-1">{alert.data?.desc}</div>
                          </div>
                        ))}
                      </div>
                    )}

                    {selectedCityAlertsHasMore && (
                      <div className="mt-3">
                        <button
                          type="button"
                          disabled={selectedCityAlertsLoadingMore || !selectedSummaryCity}
                          onClick={() => {
                            if (!selectedSummaryCity) return;
                            fetchCityAlerts(selectedSummaryCity, selectedCityAlertsCursor, true);
                          }}
                          className="px-4 py-2 rounded-md border border-zinc-300 text-sm hover:bg-zinc-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        >
                          {selectedCityAlertsLoadingMore ? 'טוען...' : 'טען עוד התראות'}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {activeTab === 'settings' && (
          <div className="max-w-2xl mx-auto space-y-8">
            <div>
              <h2 className="text-2xl font-bold tracking-tight mb-6">הגדרות מערכת</h2>

              <div className="bg-white p-6 rounded-xl border border-zinc-200 shadow-sm space-y-6">
                <div className="grid gap-2 sm:grid-cols-3 text-sm">
                  <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-center">
                    webhook
                    <div className={`font-semibold ${systemStatus?.webhookConfigured ? 'text-emerald-700' : 'text-red-700'}`}>
                      {systemStatus?.webhookConfigured ? 'מוגדר' : 'לא מוגדר'}
                    </div>
                  </div>
                  <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-center">
                    ערים מנוטרות
                    <div className="font-semibold">{systemStatus?.monitoredCitiesCount ?? cities.length}</div>
                  </div>
                  <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-center">
                    polling אחרון
                    <div className="font-semibold">{formatRelative(systemStatus?.poll?.lastPollAt || null)}</div>
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-zinc-700 mb-2">כתובת Webhook</label>
                  <p className="text-sm text-zinc-500 mb-3">
                    הכתובת אליה יישלחו בקשות POST בעת קבלת התרעה או הודעת חזרה לשגרה.
                  </p>
                  <input
                    type="url"
                    value={webhookUrl}
                    onChange={(e) => {
                      setWebhookUrl(e.target.value);
                      setSaveFeedback(null);
                      setTestFeedback(null);
                    }}
                    placeholder="https://your-webhook-url.com/endpoint"
                    className={`w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900 outline-none transition-all text-left ${
                      webhookUrlError ? 'border-red-400' : 'border-zinc-300'
                    }`}
                    dir="ltr"
                  />
                  {webhookUrlError && (
                    <p className="text-sm text-red-700 mt-2">{webhookUrlError}</p>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={testWebhook}
                    disabled={isTestingWebhook}
                    className="px-4 py-2 rounded-lg border border-zinc-300 bg-white hover:bg-zinc-100 disabled:opacity-50 transition-colors text-sm font-medium inline-flex items-center gap-2"
                  >
                    {isTestingWebhook ? <Loader2 className="w-4 h-4 animate-spin" /> : <TestTube2 className="w-4 h-4" />}
                    בדיקת Webhook עכשיו
                  </button>
                  <button
                    type="button"
                    onClick={() => fetchSystemStatus()}
                    className="px-4 py-2 rounded-lg border border-zinc-300 bg-white hover:bg-zinc-100 transition-colors text-sm inline-flex items-center gap-2"
                  >
                    <RefreshCw className="w-4 h-4" />
                    רענון סטטוס
                  </button>
                </div>

                {testFeedback && (
                  <div className={`border rounded-lg px-3 py-2 text-sm ${feedbackClass(testFeedback.type)}`}>
                    {testFeedback.text}
                  </div>
                )}

                <hr className="border-zinc-200" />

                <div>
                  <label className="block text-sm font-medium text-zinc-700 mb-2">אזורי התרעה (ערים / יישובים)</label>
                  <p className="text-sm text-zinc-500 mb-3">חפש ובחר יישובים, או הוסף ידנית עם Enter / כפתור +.</p>

                  <div className="relative mb-4">
                    <div className="flex gap-2">
                      <div className="relative flex-1">
                        <input
                          type="text"
                          value={newCity}
                          onChange={(e) => setNewCity(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              addTypedCity();
                            }
                          }}
                          onFocus={() => setShowSuggestions(true)}
                          onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
                          placeholder="חפש יישוב..."
                          className="w-full px-4 py-2 border border-zinc-300 rounded-lg focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900 outline-none transition-all"
                        />
                        {showSuggestions && filteredCities.length > 0 && (
                          <div className="absolute z-20 w-full mt-1 bg-white border border-zinc-200 rounded-lg shadow-lg max-h-60 overflow-y-auto">
                            {filteredCities.map((city) => (
                              <button
                                key={city}
                                onClick={() => addCity(city)}
                                className="w-full text-right px-4 py-2 hover:bg-zinc-50 transition-colors text-sm"
                              >
                                {city}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={addTypedCity}
                        disabled={!newCity.trim()}
                        className="px-3 py-2 rounded-lg border border-zinc-300 bg-white hover:bg-zinc-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        title="הוסף יישוב ידנית"
                      >
                        <Plus className="w-4 h-4" />
                      </button>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {cities.map((city) => (
                      <span key={city} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-zinc-100 border border-zinc-200 text-sm font-medium">
                        {city}
                        <button onClick={() => removeCity(city)} className="text-zinc-500 hover:text-red-600 transition-colors">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </span>
                    ))}
                    {cities.length === 0 && (
                      <span className="text-sm text-zinc-500 italic">לא הוגדרו אזורים. המערכת לא תשלח התרעות ל-Webhook.</span>
                    )}
                  </div>
                </div>

                {saveFeedback && (
                  <div className={`border rounded-lg px-3 py-2 text-sm ${feedbackClass(saveFeedback.type)}`}>
                    {saveFeedback.text}
                  </div>
                )}

                <div className="pt-4 flex items-center gap-2 flex-wrap">
                  <button
                    onClick={saveSettings}
                    disabled={isSaving}
                    className="w-full sm:w-auto px-6 py-2.5 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50 transition-colors font-medium"
                  >
                    {isSaving ? 'שומר...' : 'שמור הגדרות'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
