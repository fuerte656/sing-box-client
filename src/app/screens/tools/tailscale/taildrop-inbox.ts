import { DatePipe, Location } from '@angular/common';
import { Component, DestroyRef, computed, inject, input, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { os } from '@neutralinojs/lib';
import { DaemonService } from '../../../core/daemon/daemon.service';
import { TaildropService } from '../../../core/daemon/taildrop.service';
import { CorePlatform } from '../../../core/platform/core-platform';
import { SettingsService } from '../../../core/settings.service';
import { TaildropFile, TaildropInbox, TaildropReceivingFile } from '../../../core/daemon/models';
import { Dialogs } from '../../../shared/dialogs';
import { BytesPipe } from '../../../shared/format';

@Component({
  selector: 'app-taildrop-inbox',
  imports: [DatePipe, MatButtonModule, MatIconModule, MatMenuModule, MatProgressBarModule, MatTooltipModule, BytesPipe],
  template: `
    <div class="page">
      <header class="page-header">
        <button mat-icon-button (click)="back()"><mat-icon>arrow_back</mat-icon></button>
        <h1>Taildrop</h1>
        <button mat-icon-button [matMenuTriggerFor]="menu" [disabled]="!inbox()?.files?.length" matTooltip="More options">
          <mat-icon>more_vert</mat-icon>
        </button>
        <mat-menu #menu="matMenu">
          <button mat-menu-item (click)="deleteAll()">
            <mat-icon>delete_sweep</mat-icon>
            <span>Delete all</span>
          </button>
        </mat-menu>
      </header>

      <div class="content">
        @if (inbox()?.receiving?.length) {
          <h2 class="section-title">Receiving</h2>
          <div class="group">
            @for (file of inbox()!.receiving; track file.senderID + file.name) {
              <div class="item">
                <mat-icon class="lead">downloading</mat-icon>
                <div class="text">
                  <span class="title ellipsis">{{ file.name }}</span>
                  <span class="sub muted">
                    from {{ file.senderName || file.senderID }} · {{ file.receivedBytes | bytes }} / {{ file.size | bytes }}
                  </span>
                  <mat-progress-bar mode="determinate" [value]="percent(file)" />
                </div>
                <button mat-icon-button (click)="cancel(file)" matTooltip="Cancel">
                  <mat-icon>close</mat-icon>
                </button>
              </div>
            }
          </div>
        }

        @if (autoSave()) {
          <p class="muted hint">
            Received files are saved automatically to <span class="mono">{{ folder() }}</span>.
          </p>
        }

        @if (!autoSave() || inbox()?.files?.length) {
        <h2 class="section-title">{{ autoSave() ? 'Waiting to be saved' : 'Received files' }}</h2>
        <div class="group">
          @for (file of inbox()?.files ?? []; track file.name) {
            <div class="item">
              <mat-icon class="lead">description</mat-icon>
              <div class="text">
                <span class="title ellipsis">{{ file.name }}</span>
                <span class="sub muted">
                  {{ file.size | bytes }}
                  @if (file.senderName) {
                    · from {{ file.senderName }}
                  }
                  @if (file.modifiedAt) {
                    · {{ file.modifiedAt * 1000 | date: 'short' }}
                  }
                </span>
                @if (savedPath(file.name); as path) {
                  <span class="sub muted ellipsis">Saved to {{ path }}</span>
                }
                @if (saving() === file.name) {
                  <mat-progress-bar mode="determinate" [value]="saveProgress()" />
                }
              </div>
              @if (savedPath(file.name); as path) {
                <button mat-icon-button (click)="reveal(path)" [matTooltip]="'Show in folder: ' + path">
                  <mat-icon>folder_open</mat-icon>
                </button>
              }
              <button mat-icon-button (click)="save(file)" [disabled]="saving() !== null" matTooltip="Save">
                <mat-icon>download</mat-icon>
              </button>
              <button mat-icon-button (click)="delete(file)" [disabled]="saving() === file.name" matTooltip="Delete">
                <mat-icon>delete</mat-icon>
              </button>
            </div>
          } @empty {
            <div class="item muted">{{ inbox() ? 'No received files.' : 'Loading…' }}</div>
          }
        </div>
        }

        <div class="section-row">
          <h2 class="section-title">Recently saved</h2>
          @if (recent().length) {
            <button mat-button (click)="clearRecent()" matTooltip="Clears the list; saved files are kept">
              <mat-icon>clear_all</mat-icon> Clear
            </button>
          }
        </div>
        <div class="group">
          @for (file of recent(); track file.path) {
            <div class="item">
              <mat-icon class="lead">task</mat-icon>
              <div class="text">
                <span class="title ellipsis">{{ file.name }}</span>
                <span class="sub muted ellipsis">
                  {{ file.savedAt | date: 'short' }}
                  @if (file.senderName) {
                    · from {{ file.senderName }}
                  }
                  · {{ file.path }}
                </span>
              </div>
              <button mat-icon-button (click)="reveal(file.path)" matTooltip="Show in folder">
                <mat-icon>folder_open</mat-icon>
              </button>
            </div>
          } @empty {
            <div class="item muted">Nothing saved yet in this session.</div>
          }
        </div>
        <p class="muted hint">Files sent to this device from other Tailscale devices appear here.</p>
      </div>
    </div>
  `,
  styleUrl: './tailscale.scss',
})
export class TaildropInboxScreen {
  private readonly daemon = inject(DaemonService);
  private readonly taildrop = inject(TaildropService);
  private readonly platform = inject(CorePlatform);
  private readonly settings = inject(SettingsService);
  private readonly dialogs = inject(Dialogs);
  private readonly location = inject(Location);
  private readonly abort = new AbortController();

  /** Route parameter. */
  readonly tag = input.required<string>();

  readonly inbox = signal<TaildropInbox | null>(null);
  readonly saving = signal<string | null>(null);
  readonly saveProgress = signal(0);
  readonly autoSave = computed(() => this.settings.values().taildropAutoSave);
  readonly folder = signal('');
  readonly recent = computed(() => this.taildrop.recent().filter((f) => f.endpointTag === this.tag()));

  constructor() {
    inject(DestroyRef).onDestroy(() => this.abort.abort());
  }

  ngOnInit(): void {
    void this.subscribe();
    void this.taildrop.folder().then((f) => this.folder.set(this.platform.nativePath(f)));
  }

  back(): void {
    this.location.back();
  }

  percent(file: TaildropReceivingFile): number {
    return file.size ? (file.receivedBytes / file.size) * 100 : 0;
  }

  async save(file: TaildropFile): Promise<void> {
    const target = await os.showSaveDialog('Save received file', { defaultPath: file.name });
    if (!target) return;
    this.saving.set(file.name);
    this.saveProgress.set(0);
    try {
      await this.taildrop.save(this.tag(), file, target, (written, total) =>
        this.saveProgress.set(total ? (written / total) * 100 : 0),
      );
      this.saving.set(null);
      if (await this.dialogs.toastAction(`Saved ${file.name}`, 'Show in folder')) {
        await this.reveal(target);
      }
    } catch (e) {
      await this.dialogs.error('Failed to save file', e);
    } finally {
      this.saving.set(null);
    }
  }

  clearRecent(): void {
    this.taildrop.clearRecent(this.tag());
  }

  savedPath(name: string): string | undefined {
    return this.taildrop.savedPath(this.tag(), name);
  }

  async reveal(path: string): Promise<void> {
    try {
      await this.taildrop.reveal(path);
    } catch (e) {
      await this.dialogs.error('Could not open the folder', e);
    }
  }

  async delete(file: TaildropFile): Promise<void> {
    try {
      await this.daemon.deleteTaildropFile(this.tag(), file.name);
    } catch (e) {
      await this.dialogs.error('Failed to delete file', e);
    }
  }

  async deleteAll(): Promise<void> {
    const files = this.inbox()?.files ?? [];
    const confirmed = await this.dialogs.confirm({
      title: 'Delete all files',
      message: `Delete ${files.length} received files?`,
      confirm: 'Delete all',
      destructive: true,
    });
    if (!confirmed) return;
    try {
      for (const file of files) await this.daemon.deleteTaildropFile(this.tag(), file.name);
    } catch (e) {
      await this.dialogs.error('Failed to delete files', e);
    }
  }

  async cancel(file: TaildropReceivingFile): Promise<void> {
    try {
      await this.daemon.cancelTaildropReceiving(this.tag(), file.senderID, file.name);
    } catch (e) {
      await this.dialogs.error('Failed to cancel', e);
    }
  }

  /** Live inbox; opening the screen marks received files as read, as in SFA. */
  private async subscribe(): Promise<void> {
    const signal = this.abort.signal;
    void this.daemon.markTaildropInboxRead(this.tag()).catch(() => undefined);
    while (!signal.aborted) {
      try {
        await this.daemon.subscribeTaildropInbox(this.tag(), (inbox) => this.inbox.set(inbox), signal);
      } catch (e) {
        if (signal.aborted) return;
        this.inbox.update((current) => current ?? { endpointTag: this.tag(), files: [], receiving: [] });
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}
