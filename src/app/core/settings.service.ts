import { Injectable, inject } from '@angular/core';
import { NativeService } from './native.service';
import { BaseSettings } from './settings/base-settings';

export type ThemeMode = 'system' | 'light' | 'dark';

export type DashboardCard = 'upload' | 'download' | 'connections' | 'clashMode' | 'systemProxy' | 'profiles';

export const ALL_DASHBOARD_CARDS: DashboardCard[] = [
  'upload',
  'download',
  'connections',
  'clashMode',
  'systemProxy',
  'profiles',
];

/** Last on-screen geometry of the main window (see WindowService). */
export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized: boolean;
}

export interface AppSettings {
  selectedProfile: number;
  theme: ThemeMode;
  /** Start the service when the app launches. */
  autoStart: boolean;
  /** Hide to the system tray instead of quitting when the window is closed. */
  closeToTray: boolean;
  /** Launch straight into the tray without showing the window (requires closeToTray). */
  startMinimized: boolean;
  /** Show a desktop notification for service alerts while the window is hidden. */
  notifications: boolean;
  /** Notify when a Taildrop file has been received. */
  taildropNotifications: boolean;
  /** Save received Taildrop files into taildropFolder automatically (and clear them from the inbox). */
  taildropAutoSave: boolean;
  /** Where received files are saved; empty means the OS Downloads folder. */
  taildropFolder: string;
  /** Mirrors SFA's system HTTP proxy toggle: applied to inbounds that declare set_system_proxy. */
  systemProxyEnabled: boolean;
  /** Port used for the injected Clash API when the profile does not define one. */
  clashApiPort: number;
  /** Port of the injected sing-box API service (Tools: Tailscale, …) when the profile has none. */
  apiServicePort: number;
  /** Size of the in-memory log buffer shown on the Log screen. */
  logMaxLines: number;
  dashboardCards: DashboardCard[];
  windowBounds: WindowBounds | null;
}

/** Application settings, persisted to <data>/settings.json. */
@Injectable({ providedIn: 'root' })
export class SettingsService extends BaseSettings<AppSettings> {
  protected readonly fileName = 'settings.json';
  protected readonly defaults: AppSettings = {
    selectedProfile: -1,
    theme: 'system',
    autoStart: false,
    closeToTray: true,
    startMinimized: false,
    notifications: true,
    taildropNotifications: true,
    taildropAutoSave: true,
    taildropFolder: '',
    systemProxyEnabled: true,
    clashApiPort: 9090,
    apiServicePort: 9091,
    logMaxLines: 3000,
    dashboardCards: ALL_DASHBOARD_CARDS,
    windowBounds: null,
  };

  constructor() {
    super(inject(NativeService));
  }

  protected override normalize(values: AppSettings): AppSettings {
    const port = (value: number, fallback: number) => {
      const n = Math.trunc(Number(value));
      return n >= 1 && n <= 65535 ? n : fallback;
    };
    return {
      ...values,
      clashApiPort: port(values.clashApiPort, this.defaults.clashApiPort),
      apiServicePort: port(values.apiServicePort, this.defaults.apiServicePort),
      logMaxLines: Math.min(Math.max(Math.trunc(Number(values.logMaxLines)) || 0, 100), 100_000),
    };
  }
}
