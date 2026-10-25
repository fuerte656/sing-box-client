import { DatePipe, Location } from '@angular/common';
import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { RouterLink } from '@angular/router';
import { MIN_AUTO_UPDATE_INTERVAL, ProfileService } from '../../core/profile.service';
import { Dialogs } from '../../shared/dialogs';

@Component({
  selector: 'app-edit-profile',
  imports: [
    DatePipe,
    FormsModule,
    RouterLink,
    MatButtonModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatProgressBarModule,
    MatSlideToggleModule,
  ],
  templateUrl: './edit-profile.html',
  styleUrl: './profile-form.scss',
})
export class EditProfile {
  private readonly profiles = inject(ProfileService);
  private readonly dialogs = inject(Dialogs);
  private readonly location = inject(Location);

  /** Route parameter. */
  readonly id = input.required<string>();

  readonly minInterval = MIN_AUTO_UPDATE_INTERVAL;
  readonly profile = computed(() => this.profiles.get(Number(this.id())));
  readonly name = signal('');
  readonly remoteUrl = signal('');
  readonly autoUpdate = signal(true);
  readonly autoUpdateInterval = signal(60);
  readonly busy = signal(false);

  readonly dirty = computed(() => {
    const p = this.profile();
    if (!p) return false;
    return (
      this.name() !== p.name ||
      (p.type === 'remote' &&
        (this.remoteUrl() !== (p.remoteUrl ?? '') ||
          this.autoUpdate() !== !!p.autoUpdate ||
          this.autoUpdateInterval() !== (p.autoUpdateInterval ?? 60)))
    );
  });

  readonly valid = computed(
    () =>
      !!this.name().trim() &&
      (this.profile()?.type !== 'remote' ||
        (/^https?:\/\/\S+$/i.test(this.remoteUrl().trim()) && this.autoUpdateInterval() >= this.minInterval)),
  );

  constructor() {
    // Populate the form once the profile is known (and again if the route id changes).
    let loadedId: number | null = null;
    effect(() => {
      const p = this.profile();
      if (!p || p.id === loadedId) return;
      loadedId = p.id;
      this.name.set(p.name);
      this.remoteUrl.set(p.remoteUrl ?? '');
      this.autoUpdate.set(!!p.autoUpdate);
      this.autoUpdateInterval.set(p.autoUpdateInterval ?? 60);
    });
  }

  async save(): Promise<void> {
    const p = this.profile();
    if (!p || !this.valid()) return;
    this.busy.set(true);
    try {
      await this.profiles.edit(p.id, {
        name: this.name().trim(),
        ...(p.type === 'remote'
          ? {
              remoteUrl: this.remoteUrl().trim(),
              autoUpdate: this.autoUpdate(),
              autoUpdateInterval: this.autoUpdateInterval(),
            }
          : {}),
      });
      this.dialogs.toast('Profile saved');
    } catch (e) {
      await this.dialogs.error('Failed to save profile', e);
    } finally {
      this.busy.set(false);
    }
  }

  async updateNow(): Promise<void> {
    const p = this.profile();
    if (!p) return;
    if (this.dirty()) await this.save();
    this.busy.set(true);
    try {
      const changed = await this.profiles.updateRemote(p.id);
      this.dialogs.toast(changed ? 'Profile updated' : 'Profile is up to date');
    } catch (e) {
      await this.dialogs.error('Update failed', e);
    } finally {
      this.busy.set(false);
    }
  }

  async back(): Promise<void> {
    if (this.dirty()) {
      const discard = await this.dialogs.confirm({
        title: 'Unsaved changes',
        message: 'Discard your changes to this profile?',
        confirm: 'Discard',
        destructive: true,
      });
      if (!discard) return;
    }
    this.location.back();
  }
}
