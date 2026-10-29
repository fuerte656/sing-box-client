import { CdkVirtualScrollViewport, ScrollingModule } from '@angular/cdk/scrolling';
import { Component, WritableSignal, Signal, afterRenderEffect, computed, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatMenuModule } from '@angular/material/menu';
import { MatSelectModule } from '@angular/material/select';
import { MatTooltipModule } from '@angular/material/tooltip';
import { clipboard, os } from '@neutralinojs/lib';
import { SingBoxService } from '../../core/sing-box.service';
import { LOG_LEVELS, LogEntry, LogLevel, LogService } from '../../core/log.service';
import { NativeService } from '../../core/native.service';
import { Dialogs } from '../../shared/dialogs';

interface LogViewState {
  level: WritableSignal<LogLevel>;
  query: WritableSignal<string>;
}

const viewState: LogViewState = {
  level: signal<LogLevel>('trace'),
  query: signal<string>(''),
};

@Component({
  selector: 'app-log',
  imports: [
    FormsModule,
    ScrollingModule,
    MatButtonModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatMenuModule,
    MatSelectModule,
    MatTooltipModule,
  ],
  templateUrl: './log.html',
  styleUrl: './log.scss',
})
export class Log {
  private readonly logService: LogService = inject(LogService);
  private readonly nativeService: NativeService = inject(NativeService);
  private readonly dialogs: Dialogs = inject(Dialogs);
  readonly singBoxService: SingBoxService = inject(SingBoxService);

  readonly levels: LogLevel[] = LOG_LEVELS;
  readonly level: WritableSignal<LogLevel> = viewState.level;
  readonly query: WritableSignal<string> = viewState.query;
  /** While paused the view keeps showing a frozen snapshot. */
  readonly paused: WritableSignal<boolean> = signal(false);
  private readonly snapshot: WritableSignal<LogEntry[]> = signal<LogEntry[]>([]);
  readonly followTail: WritableSignal<boolean> = signal(true);

  private readonly viewport: Signal<CdkVirtualScrollViewport | undefined> = viewChild(CdkVirtualScrollViewport);
  /** Line height in px (log.scss .line), for the virtual scroll viewport. */
  readonly lineHeight: number = 56;
  readonly trackById: (_: number, e: LogEntry) => number = (_: number, e: LogEntry) => e.id;

  readonly visible: Signal<LogEntry[]> = computed(() => {
    const source: LogEntry[] = this.paused() ? this.snapshot() : this.logService.entries();
    const minLevel: number = LOG_LEVELS.indexOf(this.level());
    const query: string = this.query().trim().toLowerCase();
    return source.filter(
      (e) => LOG_LEVELS.indexOf(e.level) >= minLevel && (!query || e.message.toLowerCase().includes(query)),
    );
  });

  constructor() {
    afterRenderEffect(() => {
      this.visible();
      if (this.followTail()) this.toBottom();
    });
  }

  onScroll(): void {
    const viewport: CdkVirtualScrollViewport | undefined = this.viewport();
    if (viewport) this.followTail.set(viewport.measureScrollOffset('bottom') < 24);
  }

  scrollToBottom(): void {
    this.followTail.set(true);
    this.toBottom();
  }

  /** On the next frame: the viewport resizes its scroll area for new entries only after rendering. */
  private toBottom(): void {
    requestAnimationFrame(() => this.viewport()?.scrollTo({ bottom: 0 }));
  }

  togglePause(): void {
    if (!this.paused()) this.snapshot.set(this.logService.entries());
    this.paused.update((p) => !p);
  }

  clear(): void {
    this.logService.clear();
    this.snapshot.set([]);
  }

  async copy(): Promise<void> {
    const text: string = this.asText();
    if (!text) {
      this.dialogs.toast('No logs to copy');
      return;
    }
    await clipboard.writeText(text);
    this.dialogs.toast('Logs copied to clipboard');
  }

  async save(): Promise<void> {
    const text: string = this.asText();
    if (!text) {
      this.dialogs.toast('No logs to save');
      return;
    }
    const target: string = await os.showSaveDialog('Save logs', {
      defaultPath: `sing-box-${new Date().toISOString().replace(/[:.]/g, '-')}.log`,
      filters: [{ name: 'Log', extensions: ['log', 'txt'] }],
    });
    if (!target) return;
    try {
      await this.nativeService.writeText(target.replace(/\\/g, '/'), text);
      this.dialogs.toast('Logs saved');
    } catch (e) {
      await this.dialogs.error('Failed to save logs', e);
    }
  }

  private asText(): string {
    return this.visible()
      .map((e) => `${e.level.toUpperCase()} ${e.message}`)
      .join('\n');
  }
}
