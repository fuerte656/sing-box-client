import { Signal, WritableSignal, computed, signal } from '@angular/core';
import { NativeService } from '../native.service';

const STORAGE_PREFIX: string = 'sing-box-client:settings:';
const REPLICATION_DELAY: number = 300;

/**
 * A group of settings persisted in a JSON file in the data folder.
 *
 * - On {@link load} the JSON file is the source of truth: it is read, merged with the
 *   defaults and copied into webview storage (localStorage).
 * - Every {@link set}/{@link update} writes to webview storage synchronously, then
 *   replicates the whole document to the JSON file (debounced, writes never overlap).
 *
 * The webview origin changes with Neutralino's random port, so localStorage alone would not
 * survive restarts; the JSON file is what carries settings across launches.
 */
export abstract class BaseSettings<T extends object> {
  /** File name inside the data folder, e.g. "settings.json". */
  protected abstract readonly fileName: string;
  /** Values used for keys missing from the file. */
  protected abstract readonly defaults: T;

  private readonly state: WritableSignal<T | null> = signal<T | null>(null);
  private loading?: Promise<void>;
  private replicationTimer?: ReturnType<typeof setTimeout>;
  private replication: Promise<void> = Promise.resolve();
  private dirty: boolean = false;

  /** Current values; defaults until {@link load} completes. */
  readonly values: Signal<T> = computed(() => this.state() ?? this.defaults);

  constructor(protected readonly nativeService: NativeService) {}

  private get storageKey(): string {
    return STORAGE_PREFIX + this.fileName;
  }

  /** Loads the JSON file into webview storage and memory. Safe to call repeatedly. */
  load(): Promise<void> {
    this.loading ??= (async () => {
      const fromFile: Partial<T> | null = this.nativeService.available ? await this.nativeService.readJson<Partial<T>>(await this.filePath()) : null;
      // Fall back to webview storage only when the file is missing or unreadable.
      const stored: Partial<T> | null = fromFile ?? this.readStorage();
      const values: T = this.normalize({ ...this.defaults, ...stored });
      this.writeStorage(values);
      this.state.set(values);
      // Keep the file complete (new keys, normalized values) so it always mirrors storage.
      if (JSON.stringify(fromFile) !== JSON.stringify(values)) {
        this.dirty = true;
        await this.replicate();
      }
    })();
    return this.loading;
  }

  get<K extends keyof T>(key: K): T[K] {
    return this.values()[key];
  }

  set<K extends keyof T>(key: K, value: T[K]): Promise<void> {
    return this.update({ [key]: value } as unknown as Partial<T>);
  }

  /** Applies a patch: memory and webview storage immediately, the JSON file shortly after. */
  update(patch: Partial<T>): Promise<void> {
    const values: T = this.normalize({ ...this.values(), ...patch });
    this.state.set(values);
    this.writeStorage(values);
    return this.scheduleReplication();
  }

  /** Restores the defaults (and replicates them). */
  reset(): Promise<void> {
    return this.update(this.defaults);
  }

  /** Writes pending changes to the JSON file now, e.g. before the app exits. */
  async flush(): Promise<void> {
    clearTimeout(this.replicationTimer);
    this.replicationTimer = undefined;
    await this.replicate();
  }

  /** Hook for subclasses to clamp or migrate values; called on load and on every change. */
  protected normalize(values: T): T {
    return values;
  }

  private scheduleReplication(): Promise<void> {
    this.dirty = true;
    clearTimeout(this.replicationTimer);
    return new Promise((resolve, reject) => {
      this.replicationTimer = setTimeout(() => {
        this.replicationTimer = undefined;
        this.replicate().then(resolve, reject);
      }, REPLICATION_DELAY);
    });
  }

  /** Serialises file writes so an older snapshot can never overwrite a newer one. */
  private replicate(): Promise<void> {
    const run: () => Promise<void> = async () => {
      if (!this.dirty || !this.nativeService.available) return;
      this.dirty = false;
      await this.nativeService.writeJson(await this.filePath(), this.values());
    };
    this.replication = this.replication.then(run, run);
    return this.replication;
  }

  private filePath(): Promise<string> {
    return this.nativeService.path(this.fileName);
  }

  private readStorage(): Partial<T> | null {
    try {
      const raw: string | null = localStorage.getItem(this.storageKey);
      return raw ? (JSON.parse(raw) as Partial<T>) : null;
    } catch {
      return null;
    }
  }

  private writeStorage(values: T): void {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(values));
    } catch {
      // Storage can be unavailable (private mode, quota); the JSON file still persists.
    }
  }
}
