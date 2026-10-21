import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { AlertService, DEFAULT_ALERT_SETTINGS, type AlertSettings } from '@/services/alertsService';

type ToggleKey = Exclude<keyof AlertSettings, 'volume' | 'enabled'>;

const TOGGLES: { platform: string; note: string; items: { key: ToggleKey; label: string; description: string }[] }[] = [
  {
    platform: 'Twitch Alerts',
    note: 'Arrive while Twitch chat is connected. Subs and channel points need an Affiliate or Partner channel.',
    items: [
      { key: 'twitchSubs', label: 'New Subscriptions', description: 'Alert when someone subscribes to the channel' },
      { key: 'twitchGifts', label: 'Gifted Subscriptions', description: 'Alert when someone gifts subscriptions' },
      { key: 'twitchRedemptions', label: 'Channel Point Redemptions', description: 'Alert when viewers redeem channel points' },
    ],
  },
  {
    platform: 'YouTube Alerts',
    note: 'Arrive while YouTube live chat is connected.',
    items: [
      { key: 'youtubeSuperChats', label: 'Super Chats & Stickers', description: 'Alert when a viewer sends a Super Chat or Super Sticker' },
      { key: 'youtubeMemberships', label: 'Memberships', description: 'Alert on new, gifted and milestone memberships' },
    ],
  },
];

const AlertSettingsCard: React.FC = () => {
  const [settings, setSettings] = useState<AlertSettings>(DEFAULT_ALERT_SETTINGS);
  const [isSaved, setIsSaved] = useState(false);

  useEffect(() => {
    setSettings(AlertService.getInstance().getSettings());
  }, []);

  const handleSettingChange = <K extends keyof AlertSettings>(key: K, value: AlertSettings[K]) => {
    setSettings(prev => ({ ...prev, [key]: value }));
    setIsSaved(false);
  };

  const saveSettings = () => {
    AlertService.getInstance().updateSettings(settings);
    setIsSaved(true);
    setTimeout(() => setIsSaved(false), 2000);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <span>Integration Alerts</span>
          <Badge variant={settings.enabled ? "default" : "secondary"}>
            {settings.enabled ? "Enabled" : "Disabled"}
          </Badge>
        </CardTitle>
        <CardDescription>
          Read out and show subscriptions, Super Chats and other channel events
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <Label htmlFor="alerts-enabled">Enable Alerts</Label>
              <p className="text-sm text-muted-foreground">
                Turn all integration alerts on or off
              </p>
            </div>
            <Switch
              id="alerts-enabled"
              checked={settings.enabled}
              onCheckedChange={(checked) => handleSettingChange('enabled', checked)}
            />
          </div>

          {settings.enabled && (
            <>
              {TOGGLES.map(group => (
                <div key={group.platform} className="space-y-4 pt-4 border-t">
                  <div>
                    <h4 className="font-medium">{group.platform}</h4>
                    <p className="text-xs text-muted-foreground">{group.note}</p>
                  </div>
                  {group.items.map(item => (
                    <div key={item.key} className="flex items-center justify-between">
                      <div className="space-y-1">
                        <Label htmlFor={item.key}>{item.label}</Label>
                        <p className="text-sm text-muted-foreground">{item.description}</p>
                      </div>
                      <Switch
                        id={item.key}
                        checked={settings[item.key]}
                        onCheckedChange={(checked) => handleSettingChange(item.key, checked)}
                      />
                    </div>
                  ))}
                </div>
              ))}

              <div className="space-y-4 pt-4 border-t">
                <h4 className="font-medium">Alert Settings</h4>
                <div className="space-y-2">
                  <Label htmlFor="alert-volume">
                    Alert Volume: {Math.round(settings.volume * 100)}%
                  </Label>
                  <Slider
                    id="alert-volume"
                    min={0}
                    max={1}
                    step={0.1}
                    value={[settings.volume]}
                    onValueChange={([value]) => handleSettingChange('volume', value)}
                    className="w-full"
                  />
                </div>
              </div>
            </>
          )}
        </div>

        <div className="flex justify-between items-center pt-4 border-t">
          <Button
            variant="outline"
            onClick={() => {
              setSettings({ ...DEFAULT_ALERT_SETTINGS });
              setIsSaved(false);
            }}
          >
            Reset to Defaults
          </Button>
          <Button onClick={saveSettings} disabled={isSaved}>
            {isSaved ? "Saved!" : "Save Settings"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
};

export default AlertSettingsCard;
