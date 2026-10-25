import { Location } from '@angular/common';
import { Component, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { Router } from '@angular/router';
import { os } from '@neutralinojs/lib';
import { MIN_AUTO_UPDATE_INTERVAL, ProfileService, ProfileType } from '../../core/profile.service';
import { Dialogs } from '../../shared/dialogs';

type LocalSource = 'create' | 'import';

@Component({
  selector: 'app-new-profile',
  imports: [
    FormsModule,
    MatButtonModule,
    MatButtonToggleModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatProgressBarModule,
    MatSlideToggleModule,
  ],
  templateUrl: './new-profile.html',
  styleUrl: './profile-form.scss',
})
export class NewProfile {
  private readonly profiles = inject(ProfileService);
  private readonly dialogs = inject(Dialogs);
  private readonly router = inject(Router);
  private readonly location = inject(Location);

  /** Optional query parameters, used by "Import link from clipboard". */
  readonly typeParam = input<string | undefined>(undefined, { alias: 'type' });
  readonly urlParam = input<string | undefined>(undefined, { alias: 'url' });
  readonly nameParam = input<string | undefined>(undefined, { alias: 'name' });

  readonly minInterval = MIN_AUTO_UPDATE_INTERVAL;
  readonly name = signal('');
  readonly type = signal<ProfileType>('local');
  readonly source = signal<LocalSource>('create');
  readonly importPath = signal('');
  readonly remoteUrl = signal('');
  readonly autoUpdate = signal(true);
  readonly autoUpdateInterval = signal(60);
  readonly creating = signal(false);

  readonly valid = computed(() => {
    if (!this.name().trim()) return false;
    if (this.type() === 'remote') {
      return /^https?:\/\/\S+$/i.test(this.remoteUrl().trim()) && this.autoUpdateInterval() >= this.minInterval;
    }
    return this.source() === 'create' || !!this.importPath();
  });

  ngOnInit(): void {
    if (this.typeParam() === 'remote') this.type.set('remote');
    if (this.urlParam()) this.remoteUrl.set(this.urlParam()!);
    if (this.nameParam()) this.name.set(this.nameParam()!);
  }

  async browse(): Promise<void> {
    const [file] = await os.showOpenDialog('Select configuration', {
      filters: [{ name: 'sing-box configuration', extensions: ['json', 'jsonc'] }],
    });
    if (!file) return;
    this.importPath.set(file);
    if (!this.name().trim()) {
      this.name.set(file.replace(/\\/g, '/').split('/').pop()!.replace(/\.jsonc?$/i, ''));
    }
  }

  async create(): Promise<void> {
    if (!this.valid()) return;
    this.creating.set(true);
    try {
      const remote = this.type() === 'remote';
      const profile = await this.profiles.create({
        name: this.name(),
        type: this.type(),
        importPath: !remote && this.source() === 'import' ? this.importPath() : undefined,
        remoteUrl: remote ? this.remoteUrl() : undefined,
        autoUpdate: this.autoUpdate(),
        autoUpdateInterval: this.autoUpdateInterval(),
      });
      // A brand-new empty local profile goes straight to the editor.
      if (!remote && this.source() === 'create') {
        await this.router.navigate(['/profiles', profile.id, 'content'], { replaceUrl: true });
      } else {
        await this.router.navigateByUrl('/dashboard', { replaceUrl: true });
      }
    } catch (e) {
      await this.dialogs.error('Failed to create profile', e);
    } finally {
      this.creating.set(false);
    }
  }

  back(): void {
    this.location.back();
  }
}
