import { Injectable, inject, signal } from '@angular/core';
import { SettingsService } from './settings.service';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'panic';

export const LOG_LEVELS: LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'panic'];

export interface LogEntry {
  id: number;
  level: LogLevel;
  message: string;
}

const LEVEL_PREFIX = /^(TRACE|DEBUG|INFO|WARN|ERROR|FATAL|PANIC)(\[\d+\])?\s*/;

/** Buffers sing-box process output, split into lines and tagged with their log level. */
@Injectable({ providedIn: 'root' })
export class LogService {
  private readonly settings = inject(SettingsService);
  private nextId = 1;
  private pending = '';

  readonly entries = signal<LogEntry[]>([]);

  /** Feeds a raw stdout/stderr chunk; incomplete trailing lines are kept until the next chunk. */
  append(chunk: string): void {
    const text = this.pending + chunk.replace(/\r/g, '');
    const lines = text.split('\n');
    this.pending = lines.pop() ?? '';
    this.push(lines);
  }

  flush(): void {
    if (this.pending) {
      this.push([this.pending]);
      this.pending = '';
    }
  }

  /** Adds a line produced by the client itself rather than sing-box. */
  system(message: string, level: LogLevel = 'info'): void {
    this.add([{ id: this.nextId++, level, message }]);
  }

  clear(): void {
    this.entries.set([]);
  }

  /** The last few error lines, used to explain why sing-box exited. */
  lastErrors(count = 3): string {
    const errors = this.entries().filter((e) => e.level === 'error' || e.level === 'fatal' || e.level === 'panic');
    return errors
      .slice(-count)
      .map((e) => e.message)
      .join('\n');
  }

  private push(lines: string[]): void {
    const parsed: LogEntry[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      const match = LEVEL_PREFIX.exec(line);
      if (match) {
        parsed.push({ id: this.nextId++, level: match[1].toLowerCase() as LogLevel, message: line.slice(match[0].length) });
      } else {
        // Continuation lines (stack traces, multi-line errors) inherit the previous level.
        const level = parsed[parsed.length - 1]?.level ?? this.entries()[this.entries().length - 1]?.level ?? 'info';
        parsed.push({ id: this.nextId++, level, message: line });
      }
    }
    this.add(parsed);
  }

  private add(items: LogEntry[]): void {
    if (!items.length) return;
    const max = this.settings.get('logMaxLines');
    this.entries.update((list) => {
      const next = list.concat(items);
      return next.length > max ? next.slice(next.length - max) : next;
    });
  }
}
