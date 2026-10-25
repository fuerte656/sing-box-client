import { Component, DestroyRef, computed, effect, inject } from '@angular/core';
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
import { BoxService, ServiceAlert } from './core/box.service';
import { ClashApiService } from './core/clash-api.service';
import { NativeService } from './core/native.service';
import { CorePlatform } from './core/platform/core-platform';
import { ProfileService } from './core/profile.service';
import { SettingsService } from './core/settings.service';
import { WindowService } from './core/window.service';
import { alertText } from './shared/alert-messages';
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
  private readonly box = inject(BoxService);
  private readonly settings = inject(SettingsService);
  private readonly dialogs = inject(Dialogs);
  private readonly router = inject(Router);
  private readonly lifecycle = inject(AppLifecycleService);
  private readonly window = inject(WindowService);
  private readonly platform = inject(CorePlatform);
  private readonly profiles = inject(ProfileService);
  private readonly clash = inject(ClashApiService);
  readonly native = inject(NativeService);
  readonly taildrop = inject(TaildropService);
  readonly sender = inject(TaildropSendService);

  readonly status = this.box.status;
  readonly statusLabel = computed(() => {
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
  private readonly showGroups = computed(
    () =>
      this.profiles.selectedHasGroups() !== false ||
      (this.status() === 'started' && this.clash.mode().toLowerCase() === 'global'),
  );

  readonly nav = computed<NavItem[]>(() => [
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
    const ignoreDrop = (event: DragEvent) => {
      if (!event.defaultPrevented) event.preventDefault();
    };
    window.addEventListener('dragover', ignoreDrop);
    window.addEventListener('drop', ignoreDrop);
    effect(() => {
      const theme = this.settings.values().theme;
      document.documentElement.dataset['theme'] = theme;
    });
    this.box.alerts.pipe(takeUntilDestroyed(inject(DestroyRef))).subscribe((alert) => void this.showAlert(alert));
  }

  private async showAlert(alert: ServiceAlert): Promise<void> {
    const { title, message } = alertText(alert);
    // The dialog below waits for the user; while the app sits in the tray, also notify.
    if (!this.window.visible() && this.settings.get('notifications')) {
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
            if ((await this.box.acquireTunPrivileges()) === 'relaunch') await this.lifecycle.quit();
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
