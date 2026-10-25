import { Injectable, Injector, effect, inject } from '@angular/core';
import { TrayMenuItem, events, os } from '@neutralinojs/lib';
import { BoxService } from './box.service';
import { ClashApiService } from './clash-api.service';
import { ProfileService } from './profile.service';
import { WindowService } from './window.service';

const ICONS = {
  running: '/www/tray/running.png',
  stopped: '/www/tray/stopped.png',
  busy: '/www/tray/busy.png',
};

const SEPARATOR: TrayMenuItem = { text: '-' };

/**
 * System tray icon and menu. The icon reflects the service status; the menu offers
 * show/hide, start/stop/restart, profile switching, Clash mode, system proxy and quit.
 */
@Injectable({ providedIn: 'root' })
export class TrayService {
  private readonly box = inject(BoxService);
  private readonly clash = inject(ClashApiService);
  private readonly profiles = inject(ProfileService);
  private readonly window = inject(WindowService);
  private readonly injector = inject(Injector);
  private onQuit: () => Promise<void> = async () => undefined;
  private started = false;

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
    switch (this.box.status()) {
      case 'started':
        return ICONS.running;
      case 'stopped':
        return ICONS.stopped;
      default:
        return ICONS.busy;
    }
  }

  private buildMenu(): TrayMenuItem[] {
    const status = this.box.status();
    const running = status === 'started';
    const selected = this.profiles.selected();
    const statusText = {
      started: 'Running',
      starting: 'Starting…',
      stopping: 'Stopping…',
      stopped: 'Stopped',
    }[status];

    const items: TrayMenuItem[] = [
      { id: 'window', text: this.window.visible() ? 'Hide window' : 'Show window' },
      SEPARATOR,
      { id: 'status', text: selected ? `${statusText} · ${selected.name}` : statusText, isDisabled: true },
      running
        ? { id: 'stop', text: 'Stop' }
        : { id: 'start', text: 'Start', isDisabled: status !== 'stopped' || !selected },
    ];
    if (running) items.push({ id: 'restart', text: 'Restart' });

    const profiles = this.profiles.profiles();
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

    if (running && this.clash.modeList().length > 1) {
      items.push(SEPARATOR, { id: 'modes', text: 'Mode', isDisabled: true });
      for (const mode of this.clash.modeList()) {
        items.push({ id: `mode:${mode}`, text: mode, isChecked: mode === this.clash.mode() });
      }
    }

    if (running && this.box.systemProxy().available) {
      items.push(SEPARATOR, {
        id: 'systemProxy',
        text: 'System HTTP proxy',
        isChecked: this.box.systemProxy().enabled,
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
      await this.clash.setMode(id.slice('mode:'.length)).catch((e) => console.warn('mode switch failed', e));
      return;
    }
    switch (id) {
      case 'window':
        await this.window.toggle();
        break;
      case 'start':
        await this.box.start();
        break;
      case 'stop':
        await this.box.stop();
        break;
      case 'restart':
        await this.box.restart();
        break;
      case 'systemProxy':
        await this.box.setSystemProxyEnabled(!this.box.systemProxy().enabled);
        break;
      case 'quit':
        await this.onQuit();
        break;
    }
  }

  private async switchProfile(id: number): Promise<void> {
    if (id === this.profiles.selectedId()) return;
    await this.profiles.select(id);
    // Same as the dashboard: a running service switches to the new profile right away.
    if (this.box.status() === 'started') await this.box.restart();
  }
}
