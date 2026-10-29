import { Service, inject } from '@angular/core';
import { app, events } from '@neutralinojs/lib';
import { SingBoxService } from './sing-box.service';
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
const QUIT_TIMEOUT: number = 20_000;

/** App start-up, window-close handling and quitting. */
@Service()
export class AppLifecycleService {
  private readonly nativeService: NativeService = inject(NativeService);
  private readonly settingsService: SettingsService = inject(SettingsService);
  private readonly profileService: ProfileService = inject(ProfileService);
  private readonly coreBinaryService: CoreBinaryService = inject(CoreBinaryService);
  private readonly singBoxService: SingBoxService = inject(SingBoxService);
  private readonly trayService: TrayService = inject(TrayService);
  private readonly windowService: WindowService = inject(WindowService);
  private readonly instanceService: InstanceService = inject(InstanceService);
  private readonly taildropService: TaildropService = inject(TaildropService);
  private readonly platform: CorePlatform = inject(CorePlatform);
  private quitting: boolean = false;

  async initialize(): Promise<void> {
    if (!this.nativeService.available) return;
    // The window starts hidden (neutralino.config.json) so "start minimized" does not flash it.
    try {
      // Only one copy runs: a running instance is asked to quit (it stops sing-box first).
      await this.instanceService.claim(() => this.quit('another copy took over'));
      void this.instanceService.logEvent('started');
      // Stops sing-box if this copy dies, and kills this copy if its UI is lost (Quit cannot work then).
      void this.platform
        .watchApp(NL_PID, NL_PORT, await this.instanceService.lockPath())
        .catch((e) => console.warn('watchdog unavailable', e));
      await this.settingsService.load();
      await this.profileService.load();
      await this.coreBinaryService.refresh();

      await events.on('windowClose', () => void this.onWindowClose());
      await this.trayService.start(() => this.quit('tray Quit'));
      this.taildropService.start();

      if (this.settingsService.get('autoStart') && this.coreBinaryService.version() && this.profileService.selected()) {
        void this.singBoxService.start();
      }
    } finally {
      if (!(this.settingsService.get('startMinimized') && this.settingsService.get('closeToTray'))) {
        await this.windowService.restore();
      }
    }
  }

  /**
   * Stops sing-box cleanly and exits; force-quits if that hangs or Quit is chosen again.
   * `reason` goes to the events log.
   */
  async quit(reason: string): Promise<void> {
    if (this.quitting) return this.forceQuit(`${reason} while quitting`);
    this.quitting = true;
    await this.instanceService.logEvent(`quit: ${reason}`);
    setTimeout(() => void this.forceQuit('quit timed out'), QUIT_TIMEOUT);
    await this.windowService.saveBounds().catch(() => undefined);
    await this.singBoxService.stop();
    await this.settingsService.flush();
    await this.instanceService.release().catch(() => undefined);
    await app.exit();
  }

  /**
   * Kills sing-box, then this process (app.exit() itself may be what hangs). The next launch
   * cleans up the stale instance lock.
   */
  private async forceQuit(reason: string): Promise<void> {
    await this.instanceService.logEvent(`force quit: ${reason}`);
    await this.singBoxService.kill();
    await this.platform.forceKill(NL_PID);
  }

  private async onWindowClose(): Promise<void> {
    if (this.settingsService.get('closeToTray')) {
      await this.windowService.hide();
    } else {
      await this.quit('window closed');
    }
  }
}
