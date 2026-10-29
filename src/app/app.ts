import { Component, DestroyRef, WritableSignal, Signal, computed, effect, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSidenavModule } from '@angular/material/sidenav';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { AppLifecycleService } from './core/app-lifecycle.service';
import { TaildropSendService } from './core/daemon/taildrop-send.service';
import { TaildropService } from './core/daemon/taildrop.service';
import { SingBoxService, ServiceAlert, ServiceStatus } from './core/sing-box.service';
import { ClashApiService } from './core/clash-api.service';
import { NativeService } from './core/native.service';
import { CorePlatform } from './core/platform/core-platform';
import { ProfileService } from './core/profile.service';
import { SettingsService, ThemeMode } from './core/settings.service';
import { WindowService } from './core/window.service';
import { AlertText, alertText } from './shared/alert-messages';
import { Dialogs } from './shared/dialogs';

interface NavItem {
  path: string;
  label: string;
  icon: string;
}

@Component({
  selector: 'app-root',
  imports: [
    RouterOutlet,
    RouterLink,
    RouterLinkActive,
    MatSidenavModule,
    MatListModule,
    MatIconModule,
    MatProgressBarModule,
    MatTooltipModule,
  ],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  private readonly singBoxService: SingBoxService = inject(SingBoxService);
  private readonly settingsService: SettingsService = inject(SettingsService);
  private readonly dialogs: Dialogs = inject(Dialogs);
  private readonly router: Router = inject(Router);
  private readonly appLifecycleService: AppLifecycleService = inject(AppLifecycleService);
  private readonly windowService: WindowService = inject(WindowService);
  private readonly platform: CorePlatform = inject(CorePlatform);
  private readonly profileService: ProfileService = inject(ProfileService);
  private readonly clashApiService: ClashApiService = inject(ClashApiService);
  readonly nativeService: NativeService = inject(NativeService);
  readonly taildropService: TaildropService = inject(TaildropService);
  readonly taildropSendService: TaildropSendService = inject(TaildropSendService);

  readonly status: WritableSignal<ServiceStatus> = this.singBoxService.status;
  readonly statusLabel: Signal<string> = computed(() => {
    switch (this.status()) {
      case 'started':
        return 'Running';
      case 'starting':
        return 'Starting…';
      case 'stopping':
        return 'Stopping…';
      default:
        return 'Stopped';
    }
  });

  /** Groups is hidden when the profile has no selector/urltest outbounds, except for GLOBAL in global mode. */
  private readonly showGroups: Signal<boolean> = computed(
    () =>
      this.profileService.selectedHasGroups() !== false ||
      (this.status() === 'started' && this.clashApiService.mode().toLowerCase() === 'global'),
  );

  readonly nav: Signal<NavItem[]> = computed<NavItem[]>(() => [
    { path: '/dashboard', label: 'Dashboard', icon: 'dashboard' },
    ...(this.showGroups() ? [{ path: '/groups', label: 'Groups', icon: 'account_tree' }] : []),
    { path: '/connections', label: 'Connections', icon: 'swap_vert' },
    { path: '/log', label: 'Log', icon: 'article' },
    { path: '/tools', label: 'Tools', icon: 'terminal' },
    { path: '/settings', label: 'Settings', icon: 'settings' },
  ]);

  constructor() {
    effect(() => {
      if (!this.showGroups() && this.router.url.startsWith('/groups')) void this.router.navigateByUrl('/dashboard');
    });
    // Only explicit drop zones accept files; elsewhere a drop would navigate the webview to the file.
    const ignoreDrop: (event: DragEvent) => void = (event: DragEvent) => {
      if (!event.defaultPrevented) event.preventDefault();
    };
    window.addEventListener('dragover', ignoreDrop);
    window.addEventListener('drop', ignoreDrop);
    effect(() => {
      const theme: ThemeMode = this.settingsService.values().theme;
      document.documentElement.dataset['theme'] = theme;
    });
    this.singBoxService.alerts.pipe(takeUntilDestroyed(inject(DestroyRef))).subscribe((alert) => void this.showAlert(alert));
  }

  private async showAlert(alert: ServiceAlert): Promise<void> {
    const { title, message }: AlertText = alertText(alert);
    // The dialog below waits for the user; while the app sits in the tray, also notify.
    if (!this.windowService.visible() && this.settingsService.get('notifications')) {
      await this.platform.showNotification(title, message || title).catch(() => undefined);
    }
    switch (alert.type) {
      case 'coreMissing':
        if (await this.dialogs.confirm({ title, message, confirm: 'Open Settings' })) {
          await this.router.navigateByUrl('/settings');
        }
        break;
      case 'emptyConfiguration':
        if (await this.dialogs.confirm({ title, message, confirm: 'New Profile' })) {
          await this.router.navigateByUrl('/profiles/new');
        }
        break;
      case 'needElevation':
        if (await this.dialogs.confirm({ title, message, confirm: this.platform.tunPrivilegeAction })) {
          try {
            if ((await this.singBoxService.acquireTunPrivileges()) === 'relaunch') {
              await this.appLifecycleService.quit('relaunched as administrator');
            }
          } catch (e) {
            await this.dialogs.error('Could not get TUN permission', e);
          }
        }
        break;
      default:
        await this.dialogs.confirm({ title, message, cancel: null });
    }
  }
}
