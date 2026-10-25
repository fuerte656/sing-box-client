import { Location } from '@angular/common';
import { Component, computed, effect, inject, input, signal, viewChild } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { CoreBinaryService } from '../../core/core-binary.service';
import { ProfileService, validateJson } from '../../core/profile.service';
import { Dialogs } from '../../shared/dialogs';
import { JsonEditor } from '../../shared/json-editor';

@Component({
  selector: 'app-edit-profile-content',
  imports: [MatButtonModule, MatIconModule, MatProgressBarModule, MatTooltipModule, JsonEditor],
  templateUrl: './edit-profile-content.html',
  styleUrl: './edit-profile-content.scss',
})
export class EditProfileContent {
  private readonly profiles = inject(ProfileService);
  private readonly core = inject(CoreBinaryService);
  private readonly dialogs = inject(Dialogs);
  private readonly location = inject(Location);
  private readonly editor = viewChild.required(JsonEditor);

  /** Route parameter. */
  readonly id = input.required<string>();

  readonly profile = computed(() => this.profiles.get(Number(this.id())));
  readonly readOnly = computed(() => this.profile()?.type === 'remote');
  readonly original = signal('');
  readonly content = signal('');
  readonly loading = signal(true);
  readonly busy = signal(false);
  readonly dirty = computed(() => !this.loading() && this.content() !== this.original());

  constructor() {
    effect(() => {
      const id = Number(this.id());
      void this.profiles.readContent(id).then((text) => {
        this.original.set(text);
        this.content.set(text);
        this.loading.set(false);
      });
    });
  }

  format(): void {
    try {
      this.editor().format();
    } catch (e) {
      void this.dialogs.error('Cannot format', e);
    }
  }

  async check(): Promise<void> {
    this.busy.set(true);
    try {
      const error = await this.core.check(this.content());
      if (error) await this.dialogs.error('Configuration check failed', error);
      else this.dialogs.toast('Configuration is valid');
    } catch (e) {
      await this.dialogs.error('Configuration check failed', e);
    } finally {
      this.busy.set(false);
    }
  }

  async save(): Promise<void> {
    const profile = this.profile();
    if (!profile) return;
    try {
      validateJson(this.content());
    } catch (e) {
      await this.dialogs.error('Cannot save', e);
      return;
    }
    this.busy.set(true);
    try {
      await this.profiles.writeContent(profile.id, this.content());
      this.original.set(this.content());
      this.dialogs.toast('Configuration saved');
    } catch (e) {
      await this.dialogs.error('Failed to save configuration', e);
    } finally {
      this.busy.set(false);
    }
  }

  async back(): Promise<void> {
    if (this.dirty()) {
      const discard = await this.dialogs.confirm({
        title: 'Unsaved changes',
        message: 'Discard your changes to this configuration?',
        confirm: 'Discard',
        destructive: true,
      });
      if (!discard) return;
    }
    this.location.back();
  }

  onKeydown(event: KeyboardEvent): void {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      if (this.dirty() && !this.readOnly()) void this.save();
    }
  }
}
