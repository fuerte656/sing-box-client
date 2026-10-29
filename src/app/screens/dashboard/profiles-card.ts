import { DatePipe } from '@angular/common';
import { Component, inject, signal, WritableSignal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatRadioModule } from '@angular/material/radio';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Router, RouterLink } from '@angular/router';
import { clipboard, os } from '@neutralinojs/lib';
import { SingBoxService } from '../../core/sing-box.service';
import { ImportLink, Profile, ProfileService, parseImportLink } from '../../core/profile.service';
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
  private readonly singBoxService: SingBoxService = inject(SingBoxService);
  private readonly dialogs: Dialogs = inject(Dialogs);
  private readonly router: Router = inject(Router);
  readonly profileService: ProfileService = inject(ProfileService);

  readonly updating: WritableSignal<number | null> = signal<number | null>(null);

  async select(profile: Profile): Promise<void> {
    if (profile.id === this.profileService.selectedId()) return;
    await this.profileService.select(profile.id);
    // Like SFA: switching profiles while running applies the new one immediately.
    if (this.singBoxService.status() === 'started') await this.singBoxService.restart();
  }

  async update(profile: Profile): Promise<void> {
    this.updating.set(profile.id);
    try {
      const changed: boolean = await this.profileService.updateRemote(profile.id);
      this.dialogs.toast(changed ? `Updated "${profile.name}"` : `"${profile.name}" is up to date`);
    } catch (e) {
      await this.dialogs.error('Update failed', e);
    } finally {
      this.updating.set(null);
    }
  }

  async export(profile: Profile): Promise<void> {
    const target: string = await os.showSaveDialog('Save configuration', {
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
    const link: string = `sing-box://import-remote-profile?url=${encodeURIComponent(profile.remoteUrl)}#${encodeURIComponent(profile.name)}`;
    await clipboard.writeText(link);
    this.dialogs.toast('Import link copied to clipboard');
  }

  async delete(profile: Profile): Promise<void> {
    const confirmed: boolean = await this.dialogs.confirm({
      title: 'Delete profile',
      message: `Delete "${profile.name}"? This cannot be undone.`,
      confirm: 'Delete',
      destructive: true,
    });
    if (!confirmed) return;
    const wasSelected: boolean = profile.id === this.profileService.selectedId();
    await this.profileService.delete(profile.id);
    if (wasSelected && this.singBoxService.status() !== 'stopped') await this.singBoxService.stop();
  }

  async importFile(): Promise<void> {
    const [file]: string[] = await os.showOpenDialog('Import configuration', {
      filters: [{ name: 'sing-box configuration', extensions: ['json', 'jsonc'] }],
    });
    if (!file) return;
    const name: string = file.replace(/\\/g, '/').split('/').pop()!.replace(/\.jsonc?$/i, '');
    try {
      await this.profileService.create({ name, type: 'local', importPath: file });
      this.dialogs.toast(`Imported "${name}"`);
    } catch (e) {
      await this.dialogs.error('Import failed', e);
    }
  }

  async importLink(): Promise<void> {
    const text: string = await clipboard.readText().catch(() => '');
    const link: ImportLink | null = parseImportLink(text);
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
