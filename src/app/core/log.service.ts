import { Service, WritableSignal, inject, signal } from '@angular/core';
import { SettingsService } from './settings.service';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'panic';

export const LOG_LEVELS: LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'panic'];

export interface LogEntry {
  id: number;
  /** When the line arrived (ms since epoch); sing-box's own timestamps are off on the console. */
  time: number;
  level: LogLevel;
  message: string;
}

/** Local date and time of an entry, as `2026-10-30 14:03:22`. */
export function formatLogTime(time: number): string {
  const local: Date = new Date(time - new Date(time).getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 19).replace('T', ' ');
}

const LEVEL_PREFIX: RegExp = /^(TRACE|DEBUG|INFO|WARN|ERROR|FATAL|PANIC)(\[\d+\])?\s*/;

/** Buffers sing-box process output, split into lines and tagged with their log level. */
@Service()
export class LogService {
  private readonly settingsService: SettingsService = inject(SettingsService);
  private nextId: number = 1;
  private pending: string = '';

  readonly entries: WritableSignal<LogEntry[]> = signal<LogEntry[]>([]);

  /** Feeds a raw stdout/stderr chunk; incomplete trailing lines are kept until the next chunk. */
  append(chunk: string): void {
    const text: string = this.pending + chunk.replace(/\r/g, '');
    const lines: string[] = text.split('\n');
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
    this.add([{ id: this.nextId++, time: Date.now(), level, message }]);
  }

  clear(): void {
    this.entries.set([]);
  }

  /** The last few error lines, used to explain why sing-box exited. */
  lastErrors(count = 3): string {
    const errors: LogEntry[] = this.entries().filter((e) => e.level === 'error' || e.level === 'fatal' || e.level === 'panic');
    return errors
      .slice(-count)
      .map((e) => e.message)
      .join('\n');
  }

  private push(lines: string[]): void {
    const parsed: LogEntry[] = [];
    const time: number = Date.now();
    for (const line of lines) {
      if (!line.trim()) continue;
      const match: RegExpExecArray | null = LEVEL_PREFIX.exec(line);
      if (match) {
        parsed.push({ id: this.nextId++, time, level: match[1].toLowerCase() as LogLevel, message: line.slice(match[0].length) });
      } else {
        // Continuation lines (stack traces, multi-line errors) inherit the previous level.
        const level: LogLevel = parsed[parsed.length - 1]?.level ?? this.entries()[this.entries().length - 1]?.level ?? 'info';
        parsed.push({ id: this.nextId++, time, level, message: line });
      }
    }
    this.add(parsed);
  }

  private add(items: LogEntry[]): void {
    if (!items.length) return;
    const max: number = this.settingsService.get('logMaxLines');
    this.entries.update((list) => {
      const next: LogEntry[] = list.concat(items);
      return next.length > max ? next.slice(next.length - max) : next;
    });
  }
}
