import { Component, computed, inject, Signal, signal, WritableSignal } from '@angular/core';
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
import { SingBoxService } from '../../core/sing-box.service';
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
  private readonly nativeService: NativeService = inject(NativeService);
  private readonly dialogs: Dialogs = inject(Dialogs);
  readonly platform: CorePlatform = inject(CorePlatform);
  readonly coreBinaryService: CoreBinaryService = inject(CoreBinaryService);
  readonly singBoxService: SingBoxService = inject(SingBoxService);
  readonly settingsService: SettingsService = inject(SettingsService);
  private readonly taildropService: TaildropService = inject(TaildropService);
  /** Effective Taildrop folder (the Downloads folder unless one is chosen). */
  readonly taildropFolder: WritableSignal<string> = signal('');

  readonly cards: DashboardCard[] = ALL_DASHBOARD_CARDS;
  readonly cardLabels: Record<DashboardCard, string> = CARD_LABELS;
  readonly appVersion: string = typeof NL_APPVERSION === 'undefined' ? 'dev' : NL_APPVERSION;
  readonly neutralinoVersion: string = typeof NL_VERSION === 'undefined' ? '-' : NL_VERSION;

  readonly latest: WritableSignal<LatestRelease | null> = signal<LatestRelease | null>(null);
  readonly dataDir: WritableSignal<string> = signal('');
  readonly workDirSize: WritableSignal<number | null> = signal<number | null>(null);

  readonly updating: Signal<boolean> = computed(() => this.coreBinaryService.stage() !== 'idle');
  readonly stageLabel: Signal<string> = computed(() => {
    switch (this.coreBinaryService.stage()) {
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
    if (this.nativeService.available) {
      void this.nativeService.dataDir().then((dir) => this.dataDir.set(this.platform.nativePath(dir)));
      void this.refreshWorkDirSize();
      void this.coreBinaryService.refresh();
      void this.refreshTaildropFolder();
    }
  }

  /** Fetches the latest production release and installs it when it is newer (or nothing is installed). */
  async updateCore(): Promise<void> {
    let release: LatestRelease;
    try {
      release = await this.coreBinaryService.latestRelease();
      this.latest.set(release);
    } catch (e) {
      await this.dialogs.error('Failed to check for updates', e);
      return;
    }

    const installed: string | null = this.coreBinaryService.version();
    if (installed && compareVersions(release.version, installed) <= 0) {
      const reinstall: boolean = await this.dialogs.confirm({
        title: 'sing-box is up to date',
        message: `Installed version ${installed} is the latest release.`,
        confirm: 'Reinstall',
        cancel: 'Close',
      });
      if (!reinstall) return;
    } else {
      const install: boolean = await this.dialogs.confirm({
        title: installed ? 'Update sing-box' : 'Install sing-box',
        message: installed
          ? `Update sing-box from ${installed} to ${release.version}?`
          : `Download sing-box ${release.version} (${release.assetName}) into the data folder?`,
        confirm: installed ? 'Update' : 'Install',
      });
      if (!install) return;
    }

    // The running binary is locked on Windows: stop, replace, then start again.
    const wasRunning: boolean = this.singBoxService.status() !== 'stopped';
    try {
      if (wasRunning) await this.singBoxService.stop();
      await this.coreBinaryService.install(release);
      this.dialogs.toast(`sing-box ${this.coreBinaryService.version()} installed`);
    } catch (e) {
      await this.dialogs.error('Failed to install sing-box', e);
    } finally {
      if (wasRunning) await this.singBoxService.start();
    }
  }

  async copyCorePath(): Promise<void> {
    await clipboard.writeText(this.coreBinaryService.binaryPath());
    this.dialogs.toast('Path copied to clipboard');
  }

  async openDataDir(): Promise<void> {
    await this.platform.openFolder(await this.nativeService.dataDir());
  }

  async openCoreDir(): Promise<void> {
    await this.platform.openFolder(await this.coreBinaryService.coreDir());
  }

  async clearWorkDir(): Promise<void> {
    if (this.singBoxService.status() !== 'stopped') {
      await this.dialogs.error('Service is running', 'Stop the service before clearing the working directory.');
      return;
    }
    const confirmed: boolean = await this.dialogs.confirm({
      title: 'Clear working directory',
      message: 'Delete sing-box cache files (cache.db, downloaded rule-sets)?',
      confirm: 'Clear',
      destructive: true,
    });
    if (!confirmed) return;
    await this.nativeService.remove(await this.nativeService.path('work'));
    await this.refreshWorkDirSize();
    this.dialogs.toast('Working directory cleared');
  }

  setTheme(theme: ThemeMode): Promise<void> {
    return this.settingsService.set('theme', theme);
  }

  toggleCard(card: DashboardCard, enabled: boolean): Promise<void> {
    const current: DashboardCard[] = this.settingsService.get('dashboardCards');
    const next: DashboardCard[] = enabled ? ALL_DASHBOARD_CARDS.filter((c) => c === card || current.includes(c)) : current.filter((c) => c !== card);
    return this.settingsService.set('dashboardCards', next);
  }

  async setClashApiPort(value: string): Promise<void> {
    await this.settingsService.set('clashApiPort', Number(value));
    if (this.singBoxService.status() === 'started') this.dialogs.toast('Restart the service to apply');
  }

  async setApiServicePort(value: string): Promise<void> {
    await this.settingsService.set('apiServicePort', Number(value));
    if (this.singBoxService.status() === 'started') this.dialogs.toast('Restart the service to apply');
  }

  async chooseTaildropFolder(): Promise<void> {
    const folder: string = await os.showFolderDialog('Folder for received Taildrop files', { defaultPath: this.taildropFolder() });
    if (!folder) return;
    await this.settingsService.set('taildropFolder', folder);
    await this.refreshTaildropFolder();
  }

  async resetTaildropFolder(): Promise<void> {
    await this.settingsService.set('taildropFolder', '');
    await this.refreshTaildropFolder();
  }

  async openTaildropFolder(): Promise<void> {
    await this.platform.openFolder(await this.taildropService.folder());
  }

  private async refreshTaildropFolder(): Promise<void> {
    this.taildropFolder.set(this.platform.nativePath(await this.taildropService.folder()));
  }

  setSystemProxy(enabled: boolean): Promise<void> {
    return this.singBoxService.setSystemProxyEnabled(enabled);
  }

  async openReleases(): Promise<void> {
    await this.platform.openUrl(this.latest()?.htmlUrl ?? 'https://github.com/SagerNet/sing-box/releases');
  }

  private async refreshWorkDirSize(): Promise<void> {
    this.workDirSize.set(await this.nativeService.size(await this.nativeService.path('work')));
  }
}
