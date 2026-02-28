import React, { useState, useEffect } from 'react';
import { io } from 'socket.io-client';
import { Bell, Settings, ShieldAlert, CheckCircle, Trash2, Plus } from 'lucide-react';
import { ISRAEL_CITIES } from './constants/cities';

const socket = io();

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
  // DB timestamps are saved as Israel local wall-time in "YYYY-MM-DD HH:mm:ss".
  // Display them as-is (reordered) to avoid timezone double-conversion.
  const localDbMatch = value.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}:\d{2}:\d{2})$/);
  if (localDbMatch) {
    const [, year, month, day, time] = localDbMatch;
    return `${time} ${day}/${month}/${year}`;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return formatInIsraelTimezone(date);
}

export default function App() {
  const [activeTab, setActiveTab] = useState<'dashboard' | 'settings'>('dashboard');
  const [alerts, setAlerts] = useState<any[]>([]);
  const [cities, setCities] = useState<string[]>([]);
  const [webhookUrl, setWebhookUrl] = useState('');
  const [newCity, setNewCity] = useState('');
  const [allCities, setAllCities] = useState<string[]>([]);
  const [filteredCities, setFilteredCities] = useState<string[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    document.title = 'התרעות פיקוד העורף בוט';
    const iconEl = document.querySelector("link[rel='icon']") as HTMLLinkElement | null;
    if (iconEl) {
      iconEl.href = '/favicon-missile.svg?v=3';
    }

    fetch('/api/settings')
      .then(res => res.json())
      .then(data => {
        setCities(data.cities || []);
        setWebhookUrl(data.webhookUrl || data.webhook_url || '');
      });

    fetch('/api/cities')
      .then(res => res.json())
      .then(data => {
        if (Array.isArray(data) && data.length > 0) {
          setAllCities(data);
        } else {
          // Fallback to our robust list if API fails or returns empty
          setAllCities(ISRAEL_CITIES);
        }
      })
      .catch(err => {
        console.error('Failed to fetch cities', err);
        setAllCities(ISRAEL_CITIES);
      });

    fetch('/api/alerts/history')
      .then(res => res.json())
      .then(data => setAlerts(data));

    socket.on('new_alert', (alertData) => {
      setAlerts(prev => [{ alert_id: alertData.id, data: alertData, timestamp: new Date().toISOString() }, ...prev]);
    });

    return () => {
      socket.off('new_alert');
    };
  }, []);

  useEffect(() => {
    if (newCity.trim()) {
      // Use the merged list (allCities + ISRAEL_CITIES) to ensure maximum coverage
      const combinedList = [...new Set([...allCities, ...ISRAEL_CITIES])];
      const filtered = combinedList.filter(city => 
        city.toLowerCase().includes(newCity.toLowerCase()) && !cities.includes(city)
      ).slice(0, 10);
      
      setFilteredCities(filtered);
      setShowSuggestions(true);
    } else {
      setFilteredCities([]);
      setShowSuggestions(false);
    }
  }, [newCity, allCities, cities]);

  const saveSettings = async () => {
    setIsSaving(true);
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cities, webhook_url: webhookUrl })
    });
    setIsSaving(false);
  };

  const addCity = (city: string) => {
    if (city.trim() && !cities.includes(city.trim())) {
      setCities([...cities, city.trim()]);
      setNewCity('');
      setShowSuggestions(false);
    }
  };

  const removeCity = (city: string) => {
    setCities(cities.filter(c => c !== city));
  };

  const addTypedCity = () => {
    const typed = newCity.trim();
    if (!typed) return;
    addCity(typed);
  };

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900 font-sans" dir="rtl">
      <header className="bg-white border-b border-zinc-200 sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between h-16 items-center">
            <div className="flex items-center gap-2">
              <ShieldAlert className="w-6 h-6 text-red-600" />
              <h1 className="text-xl font-bold tracking-tight">התרעות פיקוד העורף</h1>
            </div>
            <nav className="flex gap-4">
              <button
                onClick={() => setActiveTab('dashboard')}
                className={`flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                  activeTab === 'dashboard' ? 'bg-zinc-100 text-zinc-900' : 'text-zinc-500 hover:text-zinc-900'
                }`}
              >
                <Bell className="w-4 h-4" />
                לוח בקרה
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
        {activeTab === 'dashboard' ? (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <h2 className="text-2xl font-bold tracking-tight">התרעות אחרונות</h2>
              <div className="flex items-center gap-2 text-sm text-zinc-500">
                <span className="relative flex h-3 w-3">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500"></span>
                </span>
                מחובר לשרת
              </div>
            </div>

            {alerts.length === 0 ? (
              <div className="text-center py-12 bg-white rounded-xl border border-zinc-200">
                <CheckCircle className="w-12 h-12 text-emerald-500 mx-auto mb-4" />
                <h3 className="text-lg font-medium">אין התרעות פעילות</h3>
                <p className="text-zinc-500 mt-1">המערכת מנטרת התרעות בזמן אמת</p>
              </div>
            ) : (
              <div className="grid gap-4">
                {alerts.map((alert, i) => (
                  <div key={i} className="bg-white p-5 rounded-xl border border-zinc-200 shadow-sm flex flex-col sm:flex-row gap-4 justify-between items-start sm:items-center">
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <span className={`text-xs font-medium px-2.5 py-0.5 rounded-full ${
                          alert.data?.cat === "10" ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'
                        }`}>
                          {alert.data?.categoryName || alert.data?.title || 'התרעה'}
                        </span>
                        <span className="text-sm text-zinc-500">
                          {formatAlertTimestamp(alert.timestamp)}
                        </span>
                      </div>
                      <p className="font-medium text-lg mt-2">
                        {alert.data?.data?.join(', ')}
                      </p>
                      <p className="text-zinc-600 text-sm mt-1">{alert.data?.desc}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="max-w-2xl mx-auto space-y-8">
            <div>
              <h2 className="text-2xl font-bold tracking-tight mb-6">הגדרות מערכת</h2>
              
              <div className="bg-white p-6 rounded-xl border border-zinc-200 shadow-sm space-y-6">
                <div>
                  <label className="block text-sm font-medium text-zinc-700 mb-2">
                    כתובת Webhook
                  </label>
                  <p className="text-sm text-zinc-500 mb-3">
                    הכתובת אליה יישלחו בקשות POST בעת קבלת התרעה או הודעת שחרור באזורים המוגדרים.
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
                  <label className="block text-sm font-medium text-zinc-700 mb-2">
                    אזורי התרעה (ערים / יישובים)
                  </label>
                  <p className="text-sm text-zinc-500 mb-3">
                    חפש ובחר את שמות היישובים מתוך הרשימה הרשמית.
                  </p>
                  
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
                            {filteredCities.map(city => (
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
                    {cities.map(city => (
                      <span key={city} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-zinc-100 border border-zinc-200 text-sm font-medium">
                        {city}
                        <button
                          onClick={() => removeCity(city)}
                          className="text-zinc-500 hover:text-red-600 transition-colors"
                        >
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
