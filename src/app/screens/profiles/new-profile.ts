import { Location } from '@angular/common';
import { Component, computed, inject, input, Signal, InputSignal, signal, WritableSignal } from '@angular/core';
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
import { MIN_AUTO_UPDATE_INTERVAL, Profile, ProfileService, ProfileType } from '../../core/profile.service';
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
  private readonly profileService: ProfileService = inject(ProfileService);
  private readonly dialogs: Dialogs = inject(Dialogs);
  private readonly router: Router = inject(Router);
  private readonly location: Location = inject(Location);

  /** Optional query parameters, used by "Import link from clipboard". */
  readonly typeParam: InputSignal<string | undefined> = input<string | undefined>(undefined, { alias: 'type' });
  readonly urlParam: InputSignal<string | undefined> = input<string | undefined>(undefined, { alias: 'url' });
  readonly nameParam: InputSignal<string | undefined> = input<string | undefined>(undefined, { alias: 'name' });

  readonly minInterval: number = MIN_AUTO_UPDATE_INTERVAL;
  readonly name: WritableSignal<string> = signal('');
  readonly type: WritableSignal<ProfileType> = signal<ProfileType>('local');
  readonly source: WritableSignal<LocalSource> = signal<LocalSource>('create');
  readonly importPath: WritableSignal<string> = signal('');
  readonly remoteUrl: WritableSignal<string> = signal('');
  readonly autoUpdate: WritableSignal<boolean> = signal(true);
  readonly autoUpdateInterval: WritableSignal<number> = signal(60);
  readonly creating: WritableSignal<boolean> = signal(false);

  readonly valid: Signal<boolean> = computed(() => {
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
    const [file]: string[] = await os.showOpenDialog('Select configuration', {
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
      const remote: boolean = this.type() === 'remote';
      const profile: Profile = await this.profileService.create({
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
