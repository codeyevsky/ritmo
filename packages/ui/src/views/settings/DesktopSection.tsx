import { Button } from '../../components/Button';
import { Toggle } from '../../components/Toggle';
import { useServices } from '../../services';
import { useSettings } from '../../hooks/useSettings';
import { useTranslation } from '../../hooks/useTranslation';
import { useUiStore } from '../../store';
import { SettingGroup, SettingRow } from './SettingRow';

export function DesktopSection() {
  const { t } = useTranslation();
  const { settings, patch } = useSettings();
  const { host } = useServices();
  const setShortcutsOpen = useUiStore((s) => s.setShortcutsOpen);

  if (host.platform !== 'desktop') return null;

  return (
    <div className="flex flex-col gap-4">
      <SettingGroup title={t('settings.windowBehaviour')}>
        <SettingRow
          label={t('settings.closeToTray')}
          description={t('settings.closeToTrayDesc')}
          htmlFor="setting-tray"
          control={
            <Toggle
              id="setting-tray"
              label={t('settings.closeToTray')}
              checked={settings.closeToTray}
              disabled={!host.capabilities.systemTray}
              onChange={(closeToTray) => patch({ closeToTray })}
            />
          }
        />
        <SettingRow
          label={t('settings.startMinimized')}
          description={t('settings.startMinimizedDesc')}
          htmlFor="setting-start-min"
          control={
            <Toggle
              id="setting-start-min"
              label={t('settings.startMinimized')}
              checked={settings.startMinimized}
              onChange={(startMinimized) => patch({ startMinimized })}
            />
          }
        />
        <SettingRow
          label={t('settings.notifications')}
          description={t('settings.notificationsDesc')}
          htmlFor="setting-notifications"
          control={
            <Toggle
              id="setting-notifications"
              label={t('settings.notifications')}
              checked={settings.showDesktopNotifications}
              disabled={host.notifications === undefined}
              onChange={(showDesktopNotifications) => patch({ showDesktopNotifications })}
            />
          }
        />
      </SettingGroup>

      <SettingGroup title={t('settings.shortcuts')}>
        <SettingRow
          label={t('settings.shortcuts')}
          description={t('settings.shortcutsDesc')}
          control={
            <Button variant="outline" size="sm" onClick={() => setShortcutsOpen(true)}>
              {t('settings.openShortcuts')}
            </Button>
          }
        />
      </SettingGroup>
    </div>
  );
}
