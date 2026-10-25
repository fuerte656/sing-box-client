import { DatePipe } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatRadioModule } from '@angular/material/radio';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Router, RouterLink } from '@angular/router';
import { clipboard, os } from '@neutralinojs/lib';
import { BoxService } from '../../core/box.service';
import { Profile, ProfileService, parseImportLink } from '../../core/profile.service';
import { Dialogs } from '../../shared/dialogs';

@Component({
  selector: 'app-profiles-card',
  imports: [
    DatePipe,
    RouterLink,
    MatCardModule,
    MatButtonModule,
    MatIconModule,
    MatMenuModule,
    MatRadioModule,
    MatTooltipModule,
    MatProgressSpinnerModule,
  ],
  templateUrl: './profiles-card.html',
  styleUrl: './profiles-card.scss',
})
export class ProfilesCard {
  private readonly box = inject(BoxService);
  private readonly dialogs = inject(Dialogs);
  private readonly router = inject(Router);
  readonly profileService = inject(ProfileService);

  readonly updating = signal<number | null>(null);

  async select(profile: Profile): Promise<void> {
    if (profile.id === this.profileService.selectedId()) return;
    await this.profileService.select(profile.id);
    // Like SFA: switching profiles while running applies the new one immediately.
    if (this.box.status() === 'started') await this.box.restart();
  }

  async update(profile: Profile): Promise<void> {
    this.updating.set(profile.id);
    try {
      const changed = await this.profileService.updateRemote(profile.id);
      this.dialogs.toast(changed ? `Updated "${profile.name}"` : `"${profile.name}" is up to date`);
    } catch (e) {
      await this.dialogs.error('Update failed', e);
    } finally {
      this.updating.set(null);
    }
  }

  async export(profile: Profile): Promise<void> {
    const target = await os.showSaveDialog('Save configuration', {
      defaultPath: `${profile.name}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (!target) return;
    try {
      await this.profileService.exportTo(profile.id, target);
      this.dialogs.toast('Configuration saved');
    } catch (e) {
      await this.dialogs.error('Save failed', e);
    }
  }

  async copyImportLink(profile: Profile): Promise<void> {
    if (!profile.remoteUrl) return;
    const link = `sing-box://import-remote-profile?url=${encodeURIComponent(profile.remoteUrl)}#${encodeURIComponent(profile.name)}`;
    await clipboard.writeText(link);
    this.dialogs.toast('Import link copied to clipboard');
  }

  async delete(profile: Profile): Promise<void> {
    const confirmed = await this.dialogs.confirm({
      title: 'Delete profile',
      message: `Delete "${profile.name}"? This cannot be undone.`,
      confirm: 'Delete',
      destructive: true,
    });
    if (!confirmed) return;
    const wasSelected = profile.id === this.profileService.selectedId();
    await this.profileService.delete(profile.id);
    if (wasSelected && this.box.status() !== 'stopped') await this.box.stop();
  }

  async importFile(): Promise<void> {
    const [file] = await os.showOpenDialog('Import configuration', {
      filters: [{ name: 'sing-box configuration', extensions: ['json', 'jsonc'] }],
    });
    if (!file) return;
    const name = file.replace(/\\/g, '/').split('/').pop()!.replace(/\.jsonc?$/i, '');
    try {
      await this.profileService.create({ name, type: 'local', importPath: file });
      this.dialogs.toast(`Imported "${name}"`);
    } catch (e) {
      await this.dialogs.error('Import failed', e);
    }
  }

  async importLink(): Promise<void> {
    const text = await clipboard.readText().catch(() => '');
    const link = parseImportLink(text);
    if (!link) {
      await this.dialogs.error(
        'No import link',
        'Copy a sing-box://import-remote-profile link to the clipboard first.',
      );
      return;
    }
    await this.router.navigate(['/profiles/new'], { queryParams: { type: 'remote', url: link.url, name: link.name } });
  }
}
