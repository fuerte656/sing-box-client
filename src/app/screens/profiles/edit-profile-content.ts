import { Location } from '@angular/common';
import { Component, computed, effect, inject, input, Signal, InputSignal, signal, viewChild, WritableSignal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { CoreBinaryService } from '../../core/core-binary.service';
import { Profile, ProfileService, validateJson } from '../../core/profile.service';
import { Dialogs } from '../../shared/dialogs';
import { JsonEditor } from '../../shared/json-editor';

@Component({
  selector: 'app-edit-profile-content',
  imports: [MatButtonModule, MatIconModule, MatProgressBarModule, MatTooltipModule, JsonEditor],
  templateUrl: './edit-profile-content.html',
  styleUrl: './edit-profile-content.scss',
})
export class EditProfileContent {
  private readonly profileService: ProfileService = inject(ProfileService);
  private readonly coreBinaryService: CoreBinaryService = inject(CoreBinaryService);
  private readonly dialogs: Dialogs = inject(Dialogs);
  private readonly location: Location = inject(Location);
  private readonly editor: Signal<JsonEditor> = viewChild.required(JsonEditor);

  /** Route parameter. */
  readonly id: InputSignal<string> = input.required<string>();

  readonly profile: Signal<Profile | undefined> = computed(() => this.profileService.get(Number(this.id())));
  readonly readOnly: Signal<boolean> = computed(() => this.profile()?.type === 'remote');
  readonly original: WritableSignal<string> = signal('');
  readonly content: WritableSignal<string> = signal('');
  readonly loading: WritableSignal<boolean> = signal(true);
  readonly busy: WritableSignal<boolean> = signal(false);
  readonly dirty: Signal<boolean> = computed(() => !this.loading() && this.content() !== this.original());

  constructor() {
    effect(() => {
      const id: number = Number(this.id());
      void this.profileService.readContent(id).then((text) => {
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
      const error: string | null = await this.coreBinaryService.check(this.content());
      if (error) await this.dialogs.error('Configuration check failed', error);
      else this.dialogs.toast('Configuration is valid');
    } catch (e) {
      await this.dialogs.error('Configuration check failed', e);
    } finally {
      this.busy.set(false);
    }
  }

  async save(): Promise<void> {
    const profile: Profile | undefined = this.profile();
    if (!profile) return;
    try {
      validateJson(this.content());
    } catch (e) {
      await this.dialogs.error('Cannot save', e);
      return;
    }
    this.busy.set(true);
    try {
      await this.profileService.writeContent(profile.id, this.content());
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
      const discard: boolean = await this.dialogs.confirm({
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
