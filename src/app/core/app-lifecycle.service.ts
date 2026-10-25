import { Injectable, inject } from '@angular/core';
import { app, events } from '@neutralinojs/lib';
import { BoxService } from './box.service';
import { CoreBinaryService } from './core-binary.service';
import { TaildropService } from './daemon/taildrop.service';
import { InstanceService } from './instance.service';
import { NativeService } from './native.service';
import { ProfileService } from './profile.service';
import { SettingsService } from './settings.service';
import { TrayService } from './tray.service';
import { WindowService } from './window.service';

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
  private quitting = false;

  async initialize(): Promise<void> {
    if (!this.native.available) return;
    // The window starts hidden (neutralino.config.json) so "start minimized" does not flash it.
    try {
      // Only one copy runs: a running instance is asked to quit (it stops sing-box first).
      await this.instance.claim(() => this.quit());
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

  async quit(): Promise<void> {
    if (this.quitting) return;
    this.quitting = true;
    await this.window.saveBounds().catch(() => undefined);
    await this.box.stop();
    await this.settings.flush();
    await this.instance.release().catch(() => undefined);
    await app.exit();
  }

  private async onWindowClose(): Promise<void> {
    if (this.settings.get('closeToTray')) {
      await this.window.hide();
    } else {
      await this.quit();
    }
  }
}
