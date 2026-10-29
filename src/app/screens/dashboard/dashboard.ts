import { Component, computed, inject, Signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { RouterLink } from '@angular/router';
import { SingBoxService } from '../../core/sing-box.service';
import { ClashApiService } from '../../core/clash-api.service';
import { ProfileService } from '../../core/profile.service';
import { DashboardCard, SettingsService } from '../../core/settings.service';
import { Dialogs } from '../../shared/dialogs';
import { BytesPipe, SpeedPipe } from '../../shared/format';
import { Sparkline } from '../../shared/sparkline';
import { ProfilesCard } from './profiles-card';

@Component({
  selector: 'app-dashboard',
  imports: [
    RouterLink,
    MatButtonModule,
    MatButtonToggleModule,
    MatCardModule,
    MatIconModule,
    MatProgressSpinnerModule,
    MatSlideToggleModule,
    BytesPipe,
    SpeedPipe,
    Sparkline,
    ProfilesCard,
  ],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.scss',
})
export class Dashboard {
  private readonly dialogs: Dialogs = inject(Dialogs);
  readonly singBoxService: SingBoxService = inject(SingBoxService);
  readonly clashApiService: ClashApiService = inject(ClashApiService);
  readonly profileService: ProfileService = inject(ProfileService);
  readonly settingsService: SettingsService = inject(SettingsService);

  readonly running: Signal<boolean> = computed(() => this.singBoxService.status() === 'started');
  readonly busy: Signal<boolean> = computed(() => this.singBoxService.status() === 'starting' || this.singBoxService.status() === 'stopping');
  readonly cards: Signal<Set<DashboardCard>> = computed(() => new Set(this.settingsService.values().dashboardCards));

  async setMode(mode: string): Promise<void> {
    try {
      await this.clashApiService.setMode(mode);
    } catch (e) {
      await this.dialogs.error('Failed to switch mode', e);
    }
  }

  async setSystemProxy(enabled: boolean): Promise<void> {
    await this.singBoxService.setSystemProxyEnabled(enabled);
  }
}
