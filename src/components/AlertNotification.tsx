import React, { useState, useEffect, useRef } from 'react';
import { AlertService, type AlertData, type AlertType } from '@/services/alertsService';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { X } from 'lucide-react';

const DISPLAY_MS = 6000;
/** A gift bomb shouldn't bury the screen. */
const MAX_VISIBLE = 5;

const PLATFORM_STYLES: Record<AlertData['platform'], { badge: string; accent: string }> = {
  twitch: { badge: 'bg-purple-500', accent: '#a855f7' },
  youtube: { badge: 'bg-red-500', accent: '#ef4444' },
};

const TYPE_STYLES: Record<AlertType, { icon: string; label: string; className: string }> = {
  sub: { icon: '⭐', label: 'SUB', className: 'bg-green-100 text-green-800' },
  gift: { icon: '🎁', label: 'GIFT', className: 'bg-purple-100 text-purple-800' },
  redemption: { icon: '💎', label: 'REDEMPTION', className: 'bg-blue-100 text-blue-800' },
  superchat: { icon: '💰', label: 'SUPER CHAT', className: 'bg-yellow-100 text-yellow-800' },
  member: { icon: '🏅', label: 'MEMBER', className: 'bg-emerald-100 text-emerald-800' },
};

type ShownAlert = AlertData & { id: string };

const AlertNotification: React.FC = () => {
  const [alerts, setAlerts] = useState<ShownAlert[]>([]);
  const timeouts = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const pending = timeouts.current;
    const unsubscribe = AlertService.getInstance().subscribe((alert) => {
      const shown = { ...alert, id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}` };
      setAlerts(prev => [...prev, shown].slice(-MAX_VISIBLE));
      pending.set(shown.id, setTimeout(() => {
        pending.delete(shown.id);
        setAlerts(prev => prev.filter(a => a.id !== shown.id));
      }, DISPLAY_MS));
    });
    return () => {
      unsubscribe();
      pending.forEach(clearTimeout);
      pending.clear();
    };
  }, []);

  const dismissAlert = (id: string) => {
    clearTimeout(timeouts.current.get(id));
    timeouts.current.delete(id);
    setAlerts(prev => prev.filter(a => a.id !== id));
  };

  if (alerts.length === 0) {
    return null;
  }

  return (
    <div className="fixed top-4 right-4 z-50 space-y-2">
      {alerts.map((alert) => {
        const platform = PLATFORM_STYLES[alert.platform];
        const type = TYPE_STYLES[alert.alert_type];
        return (
          <Card
            key={alert.id}
            className="w-80 p-4 shadow-lg border-l-4 animate-in slide-in-from-right"
            style={{ borderLeftColor: platform.accent }}
          >
            <div className="flex items-start justify-between">
              <div className="flex items-start space-x-3 flex-1">
                <div className="text-2xl">{type.icon}</div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center space-x-2 mb-1">
                    <Badge className={platform.badge}>{alert.platform.toUpperCase()}</Badge>
                    <Badge variant="outline" className={type.className}>{type.label}</Badge>
                  </div>
                  <p className="font-medium text-sm">{alert.user_name}</p>
                  <p className="text-sm text-muted-foreground mt-1">{alert.message}</p>
                  {alert.detail && <p className="text-sm italic mt-1 break-words">“{alert.detail}”</p>}
                </div>
              </div>
              <button
                onClick={() => dismissAlert(alert.id)}
                className="text-gray-400 hover:text-gray-600 transition-colors"
                aria-label="Dismiss alert"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </Card>
        );
      })}
    </div>
  );
};

export default AlertNotification;
