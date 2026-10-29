import { Service } from '@angular/core';
import { DirectoryEntry, events, filesystem, os } from '@neutralinojs/lib';

export interface ProcessEvent {
  id: number;
  pid: number;
  action: 'stdOut' | 'stdErr' | 'exit';
  data: string | number;
}

/**
 * OS-neutral wrapper around the Neutralino native API plus the app's data-folder layout.
 * Platform-specific behaviour lives in CorePlatform.
 */
@Service()
export class NativeService {
  readonly available: boolean = typeof NL_PORT !== 'undefined';

  private dataDirPromise?: Promise<string>;

  /** <OS data dir>/sing-box-client, using forward slashes. */
  dataDir(): Promise<string> {
    this.dataDirPromise ??= (async () => {
      const base: string = (await os.getPath('data')).replace(/\\/g, '/');
      const dir: string = `${base}/sing-box-client`;
      await this.ensureDir(dir);
      return dir;
    })();
    return this.dataDirPromise;
  }

  async path(...parts: string[]): Promise<string> {
    return [await this.dataDir(), ...parts].join('/');
  }

  async ensureDir(path: string): Promise<void> {
    if (!(await this.exists(path))) {
      await filesystem.createDirectory(path);
    }
  }

  async exists(path: string): Promise<boolean> {
    try {
      await filesystem.getStats(path);
      return true;
    } catch {
      return false;
    }
  }

  async readText(path: string): Promise<string | null> {
    try {
      return await filesystem.readFile(path);
    } catch {
      return null;
    }
  }

  async readJson<T>(path: string): Promise<T | null> {
    const text: string | null = await this.readText(path);
    if (text == null) return null;
    try {
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  }

  writeText(path: string, data: string): Promise<void> {
    return filesystem.writeFile(path, data);
  }

  writeJson(path: string, data: unknown): Promise<void> {
    return filesystem.writeFile(path, JSON.stringify(data, null, 2));
  }

  async remove(path: string): Promise<void> {
    if (await this.exists(path)) {
      await filesystem.remove(path);
    }
  }

  /** Total size in bytes of a directory tree. */
  async size(path: string): Promise<number> {
    if (!(await this.exists(path))) return 0;
    const entries: DirectoryEntry[] = await filesystem.readDirectory(path, { recursive: true });
    let total: number = 0;
    for (const entry of entries) {
      if (entry.type === 'FILE') {
        total += (await filesystem.getStats(entry.path)).size;
      }
    }
    return total;
  }

  exec(command: string) {
    return os.execCommand(command);
  }

  spawn(command: string, cwd?: string) {
    return os.spawnProcess(command, cwd ? { cwd } : undefined);
  }

  kill(id: number) {
    return os.updateSpawnedProcess(id, 'exit');
  }

  onProcessEvent(handler: (event: ProcessEvent) => void) {
    return events.on('spawnedProcess', (ev) => handler((ev as CustomEvent<ProcessEvent>).detail));
  }
}
