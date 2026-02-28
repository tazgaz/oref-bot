import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { BarChart3, Bell, CheckCircle, Plus, Settings, ShieldAlert, Trash2 } from 'lucide-react';
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

export default function App() {
  const [activeTab, setActiveTab] = useState<TabKey>('dashboard');
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [alertsCursor, setAlertsCursor] = useState<number | null>(null);
  const [alertsHasMore, setAlertsHasMore] = useState(true);
  const [alertsLoadingInitial, setAlertsLoadingInitial] = useState(false);
  const [alertsLoadingMore, setAlertsLoadingMore] = useState(false);

  const [dailySummary, setDailySummary] = useState<DailySummaryItem[]>([]);
  const [dailyLoading, setDailyLoading] = useState(false);
  const [dailyLoadedOnce, setDailyLoadedOnce] = useState(false);
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

  const loadMoreRef = useRef<HTMLDivElement | null>(null);

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

  const fetchDailySummary = useCallback(async () => {
    setDailyLoading(true);
    try {
      const res = await fetch('/api/alerts/daily-summary?days=90');
      const data = await res.json();
      setDailySummary(Array.isArray(data?.items) ? data.items : []);
      setDailyLoadedOnce(true);
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

    const onNewAlert = (alertData: any) => {
      const liveItem: AlertItem = {
        alert_id: alertData.id,
        data: alertData,
        timestamp: new Date().toISOString(),
      };
      setAlerts((prev) => [liveItem, ...prev.filter((a) => a.alert_id !== liveItem.alert_id)]);
    };

    socket.on('new_alert', onNewAlert);

    return () => {
      socket.off('new_alert', onNewAlert);
    };
  }, [fetchAlertsPage]);

  useEffect(() => {
    if (activeTab === 'daily' && !dailyLoadedOnce && !dailyLoading) {
      void fetchDailySummary();
    }
  }, [activeTab, dailyLoadedOnce, dailyLoading, fetchDailySummary]);

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
    setIsSaving(true);
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cities, webhook_url: webhookUrl }),
    });
    setIsSaving(false);
  };

  const addCity = (city: string) => {
    const normalized = city.trim();
    if (normalized && !cities.includes(normalized)) {
      setCities([...cities, normalized]);
      setNewCity('');
      setShowSuggestions(false);
    }
  };

  const removeCity = (city: string) => {
    setCities(cities.filter((c) => c !== city));
  };

  const addTypedCity = () => {
    addCity(newCity);
  };

  const groupedDaily = useMemo(() => dailySummary, [dailySummary]);

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

      <main className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {activeTab === 'dashboard' && (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <h2 className="text-2xl font-bold tracking-tight">כל ההתראות</h2>
              <div className="flex items-center gap-2 text-sm text-zinc-500">
                <span className="relative flex h-3 w-3">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500"></span>
                </span>
                מחובר לשרת
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
                          {alert.data?.categoryName || alert.data?.title || 'התרעה'}
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
            <div className="flex items-center justify-between">
              <h2 className="text-2xl font-bold tracking-tight">סיכום יומי - ירי רקטות וטילים (איחוד 10 דקות)</h2>
              <button
                onClick={() => fetchDailySummary()}
                className="px-3 py-2 rounded-md border border-zinc-300 text-sm hover:bg-zinc-100 transition-colors"
              >
                רענון
              </button>
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
                                {alert.data?.categoryName || alert.data?.title || 'התרעה'}
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
                <div>
                  <label className="block text-sm font-medium text-zinc-700 mb-2">כתובת Webhook</label>
                  <p className="text-sm text-zinc-500 mb-3">
                    הכתובת אליה יישלחו בקשות POST בעת קבלת התרעה או הודעת חזרה לשגרה.
                  </p>
                  <input
                    type="url"
                    value={webhookUrl}
                    onChange={(e) => setWebhookUrl(e.target.value)}
                    placeholder="https://your-webhook-url.com/endpoint"
                    className="w-full px-4 py-2 border border-zinc-300 rounded-lg focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900 outline-none transition-all text-left"
                    dir="ltr"
                  />
                </div>

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

                <div className="pt-4">
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
