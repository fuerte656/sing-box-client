import { Injectable, inject } from '@angular/core';
import { app, events } from '@neutralinojs/lib';
import { BoxService } from './box.service';
import { CoreBinaryService } from './core-binary.service';
import { TaildropService } from './daemon/taildrop.service';
import { InstanceService } from './instance.service';
import { NativeService } from './native.service';
import { CorePlatform } from './platform/core-platform';
import { ProfileService } from './profile.service';
import { SettingsService } from './settings.service';
import { TrayService } from './tray.service';
import { WindowService } from './window.service';

/** A clean quit can take ~12 s when sing-box has to be killed after its graceful stop; past this it is force-quit. */
const QUIT_TIMEOUT = 20_000;

/** App start-up, window-close handling and quitting. */
@Injectable({ providedIn: 'root' })
export class AppLifecycleService {
  private readonly native = inject(NativeService);
  private readonly settings = inject(SettingsService);
  private readonly profiles = inject(ProfileService);
  private readonly core = inject(CoreBinaryService);
  private readonly box = inject(BoxService);
  private readonly tray = inject(TrayService);
  private readonly window = inject(WindowService);
  private readonly instance = inject(InstanceService);
  private readonly taildrop = inject(TaildropService);
  private readonly platform = inject(CorePlatform);
  private quitting = false;

  async initialize(): Promise<void> {
    if (!this.native.available) return;
    // The window starts hidden (neutralino.config.json) so "start minimized" does not flash it.
    try {
      // Only one copy runs: a running instance is asked to quit (it stops sing-box first).
      await this.instance.claim(() => this.quit());
      // Stops sing-box if this copy dies, and kills this copy if its UI is lost (Quit cannot work then).
      void this.platform
        .watchApp(NL_PID, NL_PORT, await this.instance.lockPath())
        .catch((e) => console.warn('watchdog unavailable', e));
      await this.settings.load();
      await this.profiles.load();
      await this.core.refresh();

      await events.on('windowClose', () => void this.onWindowClose());
      await this.tray.start(() => this.quit());
      this.taildrop.start();

      if (this.settings.get('autoStart') && this.core.version() && this.profiles.selected()) {
        void this.box.start();
      }
    } finally {
      if (!(this.settings.get('startMinimized') && this.settings.get('closeToTray'))) {
        await this.window.restore();
      }
    }
  }

  /** Stops sing-box cleanly and exits; force-quits if that hangs or Quit is chosen again. */
  async quit(): Promise<void> {
    if (this.quitting) return this.forceQuit();
    this.quitting = true;
    setTimeout(() => void this.forceQuit(), QUIT_TIMEOUT);
    await this.window.saveBounds().catch(() => undefined);
    await this.box.stop();
    await this.settings.flush();
    await this.instance.release().catch(() => undefined);
    await app.exit();
  }

  /**
   * Kills sing-box, then this process (app.exit() itself may be what hangs). The next launch
   * cleans up the stale instance lock.
   */
  private async forceQuit(): Promise<void> {
    await this.box.kill();
    await this.platform.forceKill(NL_PID);
  }

  private async onWindowClose(): Promise<void> {
    if (this.settings.get('closeToTray')) {
      await this.window.hide();
    } else {
      await this.quit();
    }
  }
}
