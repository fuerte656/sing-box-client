import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatCardModule } from '@angular/material/card';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatTooltipModule } from '@angular/material/tooltip';
import { clipboard, os } from '@neutralinojs/lib';
import { BoxService } from '../../core/box.service';
import { CoreBinaryService, LatestRelease, compareVersions } from '../../core/core-binary.service';
import { TaildropService } from '../../core/daemon/taildrop.service';
import { NativeService } from '../../core/native.service';
import { CorePlatform } from '../../core/platform/core-platform';
import { ALL_DASHBOARD_CARDS, DashboardCard, SettingsService, ThemeMode } from '../../core/settings.service';
import { Dialogs } from '../../shared/dialogs';
import { BytesPipe } from '../../shared/format';

const CARD_LABELS: Record<DashboardCard, string> = {
  upload: 'Upload',
  download: 'Download',
  connections: 'Connections',
  clashMode: 'Mode',
  systemProxy: 'System HTTP proxy',
  profiles: 'Profiles',
};

@Component({
  selector: 'app-settings',
  imports: [
    FormsModule,
    MatButtonModule,
    MatButtonToggleModule,
    MatCardModule,
    MatCheckboxModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatProgressBarModule,
    MatSlideToggleModule,
    MatTooltipModule,
    BytesPipe,
  ],
  templateUrl: './settings.html',
  styleUrl: './settings.scss',
})
export class Settings {
  private readonly native = inject(NativeService);
  private readonly dialogs = inject(Dialogs);
  readonly platform = inject(CorePlatform);
  readonly core = inject(CoreBinaryService);
  readonly box = inject(BoxService);
  readonly settings = inject(SettingsService);
  private readonly taildrop = inject(TaildropService);
  /** Effective Taildrop folder (the Downloads folder unless one is chosen). */
  readonly taildropFolder = signal('');

  readonly cards = ALL_DASHBOARD_CARDS;
  readonly cardLabels = CARD_LABELS;
  readonly appVersion = typeof NL_APPVERSION === 'undefined' ? 'dev' : NL_APPVERSION;
  readonly neutralinoVersion = typeof NL_VERSION === 'undefined' ? '-' : NL_VERSION;

  readonly latest = signal<LatestRelease | null>(null);
  readonly dataDir = signal('');
  readonly workDirSize = signal<number | null>(null);

  readonly updating = computed(() => this.core.stage() !== 'idle');
  readonly stageLabel = computed(() => {
    switch (this.core.stage()) {
      case 'checking':
        return 'Checking for updates…';
      case 'downloading':
        return 'Downloading…';
      case 'extracting':
        return 'Extracting…';
      case 'installing':
        return 'Installing…';
      default:
        return '';
    }
  });

  constructor() {
    if (this.native.available) {
      void this.native.dataDir().then((dir) => this.dataDir.set(this.platform.nativePath(dir)));
      void this.refreshWorkDirSize();
      void this.core.refresh();
      void this.refreshTaildropFolder();
    }
  }

  /** Fetches the latest production release and installs it when it is newer (or nothing is installed). */
  async updateCore(): Promise<void> {
    let release: LatestRelease;
    try {
      release = await this.core.latestRelease();
      this.latest.set(release);
    } catch (e) {
      await this.dialogs.error('Failed to check for updates', e);
      return;
    }

    const installed = this.core.version();
    if (installed && compareVersions(release.version, installed) <= 0) {
      const reinstall = await this.dialogs.confirm({
        title: 'sing-box is up to date',
        message: `Installed version ${installed} is the latest release.`,
        confirm: 'Reinstall',
        cancel: 'Close',
      });
      if (!reinstall) return;
    } else {
      const install = await this.dialogs.confirm({
        title: installed ? 'Update sing-box' : 'Install sing-box',
        message: installed
          ? `Update sing-box from ${installed} to ${release.version}?`
          : `Download sing-box ${release.version} (${release.assetName}) into the data folder?`,
        confirm: installed ? 'Update' : 'Install',
      });
      if (!install) return;
    }

    // The running binary is locked on Windows: stop, replace, then start again.
    const wasRunning = this.box.status() !== 'stopped';
    try {
      if (wasRunning) await this.box.stop();
      await this.core.install(release);
      this.dialogs.toast(`sing-box ${this.core.version()} installed`);
    } catch (e) {
      await this.dialogs.error('Failed to install sing-box', e);
    } finally {
      if (wasRunning) await this.box.start();
    }
  }

  async copyCorePath(): Promise<void> {
    await clipboard.writeText(this.core.binaryPath());
    this.dialogs.toast('Path copied to clipboard');
  }

  async openDataDir(): Promise<void> {
    await this.native.open(await this.native.dataDir());
  }

  async openCoreDir(): Promise<void> {
    await this.native.open(await this.core.coreDir());
  }

  async clearWorkDir(): Promise<void> {
    if (this.box.status() !== 'stopped') {
      await this.dialogs.error('Service is running', 'Stop the service before clearing the working directory.');
      return;
    }
    const confirmed = await this.dialogs.confirm({
      title: 'Clear working directory',
      message: 'Delete sing-box cache files (cache.db, downloaded rule-sets)?',
      confirm: 'Clear',
      destructive: true,
    });
    if (!confirmed) return;
    await this.native.remove(await this.native.path('work'));
    await this.refreshWorkDirSize();
    this.dialogs.toast('Working directory cleared');
  }

  setTheme(theme: ThemeMode): Promise<void> {
    return this.settings.set('theme', theme);
  }

  toggleCard(card: DashboardCard, enabled: boolean): Promise<void> {
    const current = this.settings.get('dashboardCards');
    const next = enabled ? ALL_DASHBOARD_CARDS.filter((c) => c === card || current.includes(c)) : current.filter((c) => c !== card);
    return this.settings.set('dashboardCards', next);
  }

  async setClashApiPort(value: string): Promise<void> {
    await this.settings.set('clashApiPort', Number(value));
    if (this.box.status() === 'started') this.dialogs.toast('Restart the service to apply');
  }

  async setApiServicePort(value: string): Promise<void> {
    await this.settings.set('apiServicePort', Number(value));
    if (this.box.status() === 'started') this.dialogs.toast('Restart the service to apply');
  }

  async chooseTaildropFolder(): Promise<void> {
    const folder = await os.showFolderDialog('Folder for received Taildrop files', { defaultPath: this.taildropFolder() });
    if (!folder) return;
    await this.settings.set('taildropFolder', folder);
    await this.refreshTaildropFolder();
  }

  async resetTaildropFolder(): Promise<void> {
    await this.settings.set('taildropFolder', '');
    await this.refreshTaildropFolder();
  }

  async openTaildropFolder(): Promise<void> {
    await this.native.open(await this.taildrop.folder());
  }

  private async refreshTaildropFolder(): Promise<void> {
    this.taildropFolder.set(this.platform.nativePath(await this.taildrop.folder()));
  }

  setSystemProxy(enabled: boolean): Promise<void> {
    return this.box.setSystemProxyEnabled(enabled);
  }

  async openReleases(): Promise<void> {
    await this.native.open(this.latest()?.htmlUrl ?? 'https://github.com/SagerNet/sing-box/releases');
  }

  private async refreshWorkDirSize(): Promise<void> {
    this.workDirSize.set(await this.native.size(await this.native.path('work')));
  }
}
