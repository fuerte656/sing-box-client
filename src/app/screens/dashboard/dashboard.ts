import { Component, computed, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { RouterLink } from '@angular/router';
import { BoxService } from '../../core/box.service';
import { ClashApiService } from '../../core/clash-api.service';
import { ProfileService } from '../../core/profile.service';
import { SettingsService } from '../../core/settings.service';
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
  private readonly dialogs = inject(Dialogs);
  readonly box = inject(BoxService);
  readonly clash = inject(ClashApiService);
  readonly profiles = inject(ProfileService);
  readonly settings = inject(SettingsService);

  readonly running = computed(() => this.box.status() === 'started');
  readonly busy = computed(() => this.box.status() === 'starting' || this.box.status() === 'stopping');
  readonly cards = computed(() => new Set(this.settings.values().dashboardCards));

  async setMode(mode: string): Promise<void> {
    try {
      await this.clash.setMode(mode);
    } catch (e) {
      await this.dialogs.error('Failed to switch mode', e);
    }
  }

  async setSystemProxy(enabled: boolean): Promise<void> {
    await this.box.setSystemProxyEnabled(enabled);
  }
}
