import { Injector, Service, effect, inject } from '@angular/core';
import { TrayMenuItem, events, os } from '@neutralinojs/lib';
import { ServiceStatus, SingBoxService } from './sing-box.service';
import { ClashApiService } from './clash-api.service';
import { Profile, ProfileService } from './profile.service';
import { WindowService } from './window.service';

const ICONS: Record<'running' | 'stopped' | 'busy', string> = {
  running: '/www/tray/running.png',
  stopped: '/www/tray/stopped.png',
  busy: '/www/tray/busy.png',
};

const SEPARATOR: TrayMenuItem = { text: '-' };

/**
 * System tray icon and menu. The icon reflects the service status; the menu offers
 * show/hide, start/stop/restart, profile switching, Clash mode, system proxy and quit.
 */
@Service()
export class TrayService {
  private readonly singBoxService: SingBoxService = inject(SingBoxService);
  private readonly clashApiService: ClashApiService = inject(ClashApiService);
  private readonly profileService: ProfileService = inject(ProfileService);
  private readonly windowService: WindowService = inject(WindowService);
  private readonly injector: Injector = inject(Injector);
  private onQuit: () => Promise<void> = async () => undefined;
  private started: boolean = false;

  async start(onQuit: () => Promise<void>): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.onQuit = onQuit;
    await events.on('trayMenuItemClicked', (ev) => {
      void this.onItem((ev as CustomEvent<{ id: string }>).detail.id);
    });
    // Rebuilds the tray whenever anything shown in it changes.
    effect(() => void this.render(this.buildMenu(), this.icon()), { injector: this.injector });
  }

  private icon(): string {
    switch (this.singBoxService.status()) {
      case 'started':
        return ICONS.running;
      case 'stopped':
        return ICONS.stopped;
      default:
        return ICONS.busy;
    }
  }

  private buildMenu(): TrayMenuItem[] {
    const status: ServiceStatus = this.singBoxService.status();
    const running: boolean = status === 'started';
    const selected: Profile | null = this.profileService.selected();
    const statusText: string = {
      started: 'Running',
      starting: 'Starting…',
      stopping: 'Stopping…',
      stopped: 'Stopped',
    }[status];

    const items: TrayMenuItem[] = [
      { id: 'window', text: this.windowService.visible() ? 'Hide window' : 'Show window' },
      SEPARATOR,
      { id: 'status', text: selected ? `${statusText} · ${selected.name}` : statusText, isDisabled: true },
      running
        ? { id: 'stop', text: 'Stop' }
        : { id: 'start', text: 'Start', isDisabled: status !== 'stopped' || !selected },
    ];
    if (running) items.push({ id: 'restart', text: 'Restart' });

    const profiles: Profile[] = this.profileService.profiles();
    if (profiles.length > 1) {
      items.push(SEPARATOR, { id: 'profiles', text: 'Profiles', isDisabled: true });
      for (const profile of profiles) {
        items.push({
          id: `profile:${profile.id}`,
          text: profile.name,
          isChecked: profile.id === selected?.id,
          isDisabled: status === 'starting' || status === 'stopping',
        });
      }
    }

    if (running && this.clashApiService.modeList().length > 1) {
      items.push(SEPARATOR, { id: 'modes', text: 'Mode', isDisabled: true });
      for (const mode of this.clashApiService.modeList()) {
        items.push({ id: `mode:${mode}`, text: mode, isChecked: mode === this.clashApiService.mode() });
      }
    }

    if (running && this.singBoxService.systemProxy().available) {
      items.push(SEPARATOR, {
        id: 'systemProxy',
        text: 'System HTTP proxy',
        isChecked: this.singBoxService.systemProxy().enabled,
      });
    }

    items.push(SEPARATOR, { id: 'quit', text: 'Quit' });
    return items;
  }

  private async render(menuItems: TrayMenuItem[], icon: string): Promise<void> {
    await os.setTray({ icon, menuItems }).catch((e) => console.warn('tray unavailable', e));
  }

  private async onItem(id: string): Promise<void> {
    if (id.startsWith('profile:')) {
      await this.switchProfile(Number(id.slice('profile:'.length)));
      return;
    }
    if (id.startsWith('mode:')) {
      await this.clashApiService.setMode(id.slice('mode:'.length)).catch((e) => console.warn('mode switch failed', e));
      return;
    }
    switch (id) {
      case 'window':
        await this.windowService.toggle();
        break;
      case 'start':
        await this.singBoxService.start();
        break;
      case 'stop':
        await this.singBoxService.stop();
        break;
      case 'restart':
        await this.singBoxService.restart();
        break;
      case 'systemProxy':
        await this.singBoxService.setSystemProxyEnabled(!this.singBoxService.systemProxy().enabled);
        break;
      case 'quit':
        await this.onQuit();
        break;
    }
  }

  private async switchProfile(id: number): Promise<void> {
    if (id === this.profileService.selectedId()) return;
    await this.profileService.select(id);
    // Same as the dashboard: a running service switches to the new profile right away.
    if (this.singBoxService.status() === 'started') await this.singBoxService.restart();
  }
}
