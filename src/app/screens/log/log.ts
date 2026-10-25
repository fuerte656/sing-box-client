import { Component, ElementRef, afterRenderEffect, computed, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatMenuModule } from '@angular/material/menu';
import { MatSelectModule } from '@angular/material/select';
import { MatTooltipModule } from '@angular/material/tooltip';
import { clipboard, os } from '@neutralinojs/lib';
import { BoxService } from '../../core/box.service';
import { LOG_LEVELS, LogEntry, LogLevel, LogService } from '../../core/log.service';
import { NativeService } from '../../core/native.service';
import { Dialogs } from '../../shared/dialogs';

const viewState = {
  level: signal<LogLevel>('trace'),
  query: signal(''),
};

@Component({
  selector: 'app-log',
  imports: [
    FormsModule,
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
  private readonly logs = inject(LogService);
  private readonly native = inject(NativeService);
  private readonly dialogs = inject(Dialogs);
  readonly box = inject(BoxService);

  readonly levels = LOG_LEVELS;
  readonly level = viewState.level;
  readonly query = viewState.query;
  /** While paused the view keeps showing a frozen snapshot. */
  readonly paused = signal(false);
  private readonly snapshot = signal<LogEntry[]>([]);
  readonly followTail = signal(true);

  private readonly viewport = viewChild.required<ElementRef<HTMLElement>>('viewport');

  readonly visible = computed(() => {
    const source = this.paused() ? this.snapshot() : this.logs.entries();
    const minLevel = LOG_LEVELS.indexOf(this.level());
    const query = this.query().trim().toLowerCase();
    return source.filter(
      (e) => LOG_LEVELS.indexOf(e.level) >= minLevel && (!query || e.message.toLowerCase().includes(query)),
    );
  });

  constructor() {
    afterRenderEffect(() => {
      this.visible();
      if (this.followTail()) {
        const el = this.viewport().nativeElement;
        el.scrollTop = el.scrollHeight;
      }
    });
  }

  onScroll(): void {
    const el = this.viewport().nativeElement;
    this.followTail.set(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
  }

  scrollToBottom(): void {
    this.followTail.set(true);
    const el = this.viewport().nativeElement;
    el.scrollTop = el.scrollHeight;
  }

  togglePause(): void {
    if (!this.paused()) this.snapshot.set(this.logs.entries());
    this.paused.update((p) => !p);
  }

  clear(): void {
    this.logs.clear();
    this.snapshot.set([]);
  }

  async copy(): Promise<void> {
    const text = this.asText();
    if (!text) {
      this.dialogs.toast('No logs to copy');
      return;
    }
    await clipboard.writeText(text);
    this.dialogs.toast('Logs copied to clipboard');
  }

  async save(): Promise<void> {
    const text = this.asText();
    if (!text) {
      this.dialogs.toast('No logs to save');
      return;
    }
    const target = await os.showSaveDialog('Save logs', {
      defaultPath: `sing-box-${new Date().toISOString().replace(/[:.]/g, '-')}.log`,
      filters: [{ name: 'Log', extensions: ['log', 'txt'] }],
    });
    if (!target) return;
    try {
      await this.native.writeText(target.replace(/\\/g, '/'), text);
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
