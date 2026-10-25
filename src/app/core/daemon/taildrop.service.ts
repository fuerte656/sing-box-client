import { Injectable, Injector, computed, effect, inject, signal, untracked } from '@angular/core';
import { Router } from '@angular/router';
import { os } from '@neutralinojs/lib';
import { Dialogs } from '../../shared/dialogs';
import { NativeService } from '../native.service';
import { CorePlatform } from '../platform/core-platform';
import { SettingsService } from '../settings.service';
import { WindowService } from '../window.service';
import { DaemonService } from './daemon.service';
import { TaildropFile, TaildropReceivingFile } from './models';

export interface SavedTaildropFile {
  endpointTag: string;
  name: string;
  path: string;
  senderName: string;
  savedAt: number;
}

const RECENT_LIMIT = 50;

export interface ReceivingProgress {
  endpointTag: string;
  files: TaildropReceivingFile[];
  receivedBytes: number;
  totalBytes: number;
  /** 0–100 */
  percent: number;
}

/**
 * Background Taildrop handling, on any screen and while the window is in the tray:
 * - auto-save (default): received files are saved into the Taildrop folder and removed from the
 *   inbox, like the official Tailscale clients do;
 * - otherwise new files are announced and wait in the inbox for a manual save.
 */
@Injectable({ providedIn: 'root' })
export class TaildropService {
  private readonly daemon = inject(DaemonService);
  private readonly native = inject(NativeService);
  private readonly platform = inject(CorePlatform);
  private readonly settings = inject(SettingsService);
  private readonly window = inject(WindowService);
  private readonly dialogs = inject(Dialogs);
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);

  /** Files saved this session (auto or manual), newest first. */
  readonly recent = signal<SavedTaildropFile[]>([]);

  /** Files currently arriving, per endpoint (live while Tailscale reports receivingFileCount > 0). */
  private readonly receivingByEndpoint = signal<Record<string, TaildropReceivingFile[]>>({});
  private readonly receivingWatchers = new Map<string, AbortController>();
  /** Overall progress of everything arriving right now, or null when nothing is. */
  readonly receiving = computed<ReceivingProgress | null>(() => {
    const entries = Object.entries(this.receivingByEndpoint()).filter(([, files]) => files.length);
    if (!entries.length) return null;
    const files = entries.flatMap(([, f]) => f);
    const receivedBytes = files.reduce((sum, f) => sum + f.receivedBytes, 0);
    const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
    return {
      endpointTag: entries[0][0],
      files,
      receivedBytes,
      totalBytes,
      percent: totalBytes ? Math.min(100, (receivedBytes / totalBytes) * 100) : 0,
    };
  });

  /** Names already announced per endpoint (manual mode); the first look is only a baseline. */
  private readonly known = new Map<string, Set<string>>();
  /** Last waiting/unread counts per endpoint, to react only when they change. */
  private readonly counts = new Map<string, string>();
  /** One check at a time per endpoint; a change during a check schedules one more. */
  private readonly running = new Map<string, boolean>();
  private readonly rerun = new Set<string>();
  /** endpointTag/name of files whose auto-save failed: left for a manual save instead of retried in a loop. */
  private readonly failed = new Set<string>();
  private started = false;

  start(): void {
    if (this.started) return;
    this.started = true;
    effect(
      () => {
        const endpoints = this.daemon.tailscale();
        untracked(() => {
          const present = new Set(endpoints.map((e) => e.endpointTag));
          for (const tag of [...this.counts.keys()]) {
            if (!present.has(tag)) {
              this.known.delete(tag);
              this.counts.delete(tag);
            }
          }
          for (const [tag, watcher] of [...this.receivingWatchers]) {
            const endpoint = endpoints.find((e) => e.endpointTag === tag);
            if (!endpoint || !endpoint.receivingFileCount) this.stopWatchingReceiving(tag, watcher);
          }
          for (const e of endpoints) {
            if (!e.canShareFiles) continue;
            if (e.receivingFileCount && !this.receivingWatchers.has(e.endpointTag)) {
              this.watchReceiving(e.endpointTag);
            }
            const key = `${e.waitingFileCount}/${e.unreadFileCount}`;
            if (this.counts.get(e.endpointTag) === key) continue;
            this.counts.set(e.endpointTag, key);
            void this.check(e.endpointTag);
          }
        });
      },
      { injector: this.injector },
    );
  }

  /** Empties the "Recently saved" list; the files themselves stay where they were saved. */
  clearRecent(endpointTag?: string): void {
    this.recent.update((list) => (endpointTag ? list.filter((f) => f.endpointTag !== endpointTag) : []));
  }

  receivingFor(endpointTag: string): TaildropReceivingFile[] {
    return this.receivingByEndpoint()[endpointTag] ?? [];
  }

  savedPath(endpointTag: string, name: string): string | undefined {
    return this.recent().find((f) => f.endpointTag === endpointTag && f.name === name)?.path;
  }

  /** Folder received files go to: the configured one, else the OS Downloads folder. */
  async folder(): Promise<string> {
    const configured = this.settings.get('taildropFolder');
    return (configured || (await os.getPath('downloads'))).replace(/\\/g, '/').replace(/\/$/, '');
  }

  /** Saves one inbox file to `target` and records it (a manual save also clears a failed auto-save). */
  async save(endpointTag: string, file: TaildropFile, target: string, onProgress?: (written: number, total: number) => void) {
    await this.daemon.downloadTaildropFile(endpointTag, file.name, file.size, target, onProgress);
    this.failed.delete(`${endpointTag}/${file.name}`);
    const saved: SavedTaildropFile = { endpointTag, name: file.name, path: target, senderName: file.senderName, savedAt: Date.now() };
    this.recent.update((list) => [saved, ...list.filter((f) => f.path !== target)].slice(0, RECENT_LIMIT));
    return saved;
  }

  async reveal(path: string): Promise<void> {
    await this.platform.revealFile(path.replace(/\\/g, '/'));
  }

  /** Live inbox subscription while files arrive; its `receiving` entries carry byte progress. */
  private watchReceiving(endpointTag: string): void {
    const abort = new AbortController();
    this.receivingWatchers.set(endpointTag, abort);
    void this.daemon
      .subscribeTaildropInbox(
        endpointTag,
        (inbox) => this.receivingByEndpoint.update((all) => ({ ...all, [endpointTag]: inbox.receiving })),
        abort.signal,
      )
      .catch(() => undefined)
      .finally(() => {
        if (this.receivingWatchers.get(endpointTag) === abort) this.stopWatchingReceiving(endpointTag, abort);
      });
  }

  private stopWatchingReceiving(endpointTag: string, watcher: AbortController): void {
    watcher.abort();
    this.receivingWatchers.delete(endpointTag);
    this.receivingByEndpoint.update((all) => {
      const { [endpointTag]: _, ...rest } = all;
      return rest;
    });
  }

  private async check(endpointTag: string): Promise<void> {
    if (this.running.get(endpointTag)) {
      this.rerun.add(endpointTag);
      return;
    }
    this.running.set(endpointTag, true);
    try {
      do {
        this.rerun.delete(endpointTag);
        await this.process(endpointTag);
      } while (this.rerun.has(endpointTag));
    } finally {
      this.running.set(endpointTag, false);
    }
  }

  private async process(endpointTag: string): Promise<void> {
    let files: TaildropFile[];
    try {
      files = (await this.daemon.fetchTaildropInbox(endpointTag)).files;
    } catch {
      return;
    }
    if (this.settings.get('taildropAutoSave')) {
      await this.autoSave(endpointTag, files);
      return;
    }
    const known = this.known.get(endpointTag);
    this.known.set(endpointTag, new Set(files.map((f) => f.name)));
    const added = known ? files.filter((f) => !known.has(f.name)) : [];
    if (added.length) await this.announce(endpointTag, added);
  }

  /** Saves every waiting file into the Taildrop folder, then removes it from the inbox. */
  private async autoSave(endpointTag: string, files: TaildropFile[]): Promise<void> {
    if (!files.length) return;
    const folder = await this.folder();
    await this.native.ensureDir(folder).catch(() => undefined);
    const saved: SavedTaildropFile[] = [];
    for (const file of files) {
      const key = `${endpointTag}/${file.name}`;
      if (this.failed.has(key)) continue;
      try {
        const target = await this.uniquePath(folder, file.name);
        saved.push(await this.save(endpointTag, file, target));
        await this.daemon.deleteTaildropFile(endpointTag, file.name);
      } catch (e) {
        this.failed.add(key);
        void this.dialogs.error(`Could not save ${file.name}`, e);
      }
    }
    if (saved.length) await this.announceSaved(saved, folder);
  }

  /** "name.ext", then "name (1).ext", "name (2).ext", … — never overwrite an existing file. */
  private async uniquePath(folder: string, name: string): Promise<string> {
    const safe = name.replace(/[\\/:*?"<>|]/g, '_');
    const dot = safe.lastIndexOf('.');
    const [base, ext] = dot > 0 ? [safe.slice(0, dot), safe.slice(dot)] : [safe, ''];
    for (let n = 0; ; n++) {
      const candidate = `${folder}/${n ? `${base} (${n})${ext}` : safe}`;
      if (!(await this.native.exists(candidate))) return candidate;
    }
  }

  private async announceSaved(saved: SavedTaildropFile[], folder: string): Promise<void> {
    if (!this.settings.get('taildropNotifications')) return;
    const folderName = folder.split('/').pop() || folder;
    const from = saved[0].senderName ? ` from ${saved[0].senderName}` : '';
    const what = saved.length === 1 ? saved[0].name : `${saved.length} files`;
    await this.platform.showNotification('Taildrop: file received', `${what}${from}, saved to ${folderName}`).catch(() => undefined);
    if (await this.dialogs.toastAction(`Received ${what}${from} · saved to ${folderName}`, 'Show in folder', 8000, { notify: false })) {
      await this.reveal(saved[0].path).catch((e) => this.dialogs.error('Could not open the folder', e));
    }
  }

  /** Manual-save mode: announce new inbox files and offer to open the inbox. */
  private async announce(endpointTag: string, files: TaildropFile[]): Promise<void> {
    if (!this.settings.get('taildropNotifications')) return;
    const from = files[0].senderName ? ` from ${files[0].senderName}` : '';
    const what = files.length === 1 ? files[0].name : `${files.length} files`;
    await this.platform.showNotification('Taildrop: file received', `${what}${from}`).catch(() => undefined);
    const inboxUrl = `/tools/tailscale/${encodeURIComponent(endpointTag)}/taildrop`;
    if (this.router.url.startsWith(inboxUrl)) return; // the open inbox already shows it
    if (await this.dialogs.toastAction(`Received ${what}${from}`, 'Open', 8000, { notify: false })) {
      if (!this.window.visible()) await this.window.show();
      await this.router.navigateByUrl(inboxUrl);
    }
  }
}
