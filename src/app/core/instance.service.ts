import { Service, inject } from '@angular/core';
import { events, filesystem } from '@neutralinojs/lib';
import { NativeService } from './native.service';
import { CorePlatform } from './platform/core-platform';

interface InstanceLock {
  pid: number;
  /** Executable name, to tell a live instance from an unrelated process that reused the PID. */
  image: string;
  startedAt: number;
  /** PID of the sing-box this instance runs, if any; it outlives the app when the app is killed or hangs. */
  corePid?: number | null;
}

/** Detail of Neutralino's watchFile event. */
interface WatchFileDetail {
  id: number;
  filename: string;
}

interface QuitRequest {
  pid: number;
  requestedBy: number;
}

const DIR: string = 'instance';
const LOCK_FILE: string = 'instance.json';
const QUIT_FILE: string = 'quit-request.json';
/** The previous instance stops sing-box gracefully (up to ~7 s) before it exits. */
const HANDOVER_TIMEOUT: number = 15_000;

/**
 * Keeps a single running copy of the app. A newly launched instance takes over: it asks the
 * running one to quit (via a request file it watches), waits for it to stop sing-box cleanly,
 * and force-kills it only if it does not exit in time.
 */
@Service()
export class InstanceService {
  private readonly nativeService: NativeService = inject(NativeService);
  private readonly platform: CorePlatform = inject(CorePlatform);
  private watcherId: number | null = null;
  private lock: InstanceLock | null = null;

  /** Takes over from a running instance, then listens for quit requests from future ones. */
  async claim(onQuitRequested: () => Promise<void>): Promise<void> {
    const dir: string = await this.nativeService.path(DIR);
    await this.nativeService.ensureDir(dir);
    const image: string = (await this.platform.processImageName(NL_PID)) ?? '';

    const previous: InstanceLock | null = await this.nativeService.readJson<InstanceLock>(`${dir}/${LOCK_FILE}`);
    if (previous && previous.pid !== NL_PID && (await this.isInstance(previous))) {
      await this.nativeService.writeJson(`${dir}/${QUIT_FILE}`, { pid: previous.pid, requestedBy: NL_PID } satisfies QuitRequest);
      if (!(await this.waitForExit(previous))) {
        await this.platform.forceKill(previous.pid).catch(() => undefined);
      }
    }
    // A previous copy that hung, crashed or was killed leaves its sing-box running, which keeps
    // the cache file locked ("initialize cache-file: timeout"); stop it before going on.
    if (previous?.corePid && previous.pid !== NL_PID) {
      await this.stopLeftoverCore(previous.corePid);
    }
    await this.closeUntracked(image);
    await this.nativeService.remove(`${dir}/${QUIT_FILE}`);
    this.lock = { pid: NL_PID, image, startedAt: Date.now(), corePid: null };
    await this.nativeService.writeJson(`${dir}/${LOCK_FILE}`, this.lock);

    await events.on('watchFile', (ev) => {
      const detail: WatchFileDetail = (ev as CustomEvent<WatchFileDetail>).detail;
      if (detail.id === this.watcherId && detail.filename === QUIT_FILE) {
        void this.checkQuitRequest(dir, onQuitRequested);
      }
    });
    this.watcherId = await filesystem.createWatcher(dir);
  }

  /**
   * Appends to instance/events.log, which the watchdog (watch-app.ps1) also writes to: how and
   * why this copy quit, which the in-memory log cannot tell once the app is gone.
   */
  async logEvent(message: string): Promise<void> {
    // Local time, like the watchdog's lines (PowerShell's Get-Date -Format s).
    const now: Date = new Date();
    const local: string = new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
    const line: string = `${local} [app ${NL_PID}] ${message}\n`;
    await filesystem.appendFile(await this.nativeService.path(DIR, 'events.log'), line).catch(() => undefined);
  }

  /** The lock file, which also records the running sing-box PID. */
  lockPath(): Promise<string> {
    return this.nativeService.path(DIR, LOCK_FILE);
  }

  /** Records the running sing-box PID (null when stopped) so a later copy can clean it up. */
  async setCorePid(corePid: number | null): Promise<void> {
    if (!this.lock) return;
    const lockPath: string = await this.lockPath();
    const current: InstanceLock | null = await this.nativeService.readJson<InstanceLock>(lockPath);
    if (current && current.pid !== NL_PID) return; // another copy has taken over
    this.lock = { ...this.lock, corePid };
    await this.nativeService.writeJson(lockPath, this.lock);
  }

  /** Removes the lock on a normal exit, unless another instance already owns it. */
  async release(): Promise<void> {
    const lockPath: string = await this.lockPath();
    const lock: InstanceLock | null = await this.nativeService.readJson<InstanceLock>(lockPath);
    if (lock?.pid === NL_PID) await this.nativeService.remove(lockPath);
  }

  /**
   * Copies started without the lock (older builds) cannot receive a quit request, so they are
   * terminated. Skipped for the bare Neutralino runtime used in development, whose name other
   * Neutralino apps share.
   */
  private async closeUntracked(image: string): Promise<void> {
    if (!image || image.toLowerCase().startsWith('neutralino')) return;
    const others: number[] = (await this.platform.findProcesses(image)).filter((pid) => pid !== NL_PID);
    for (const pid of others) {
      await this.platform.forceKill(pid).catch(() => undefined);
    }
  }

  private async stopLeftoverCore(pid: number): Promise<void> {
    if ((await this.platform.processImageName(pid))?.toLowerCase() !== this.platform.binaryName.toLowerCase()) return;
    if (!(await this.platform.stopGracefully(pid, 5000).catch(() => false))) {
      await this.platform.forceKill(pid).catch(() => undefined);
    }
  }

  private async checkQuitRequest(dir: string, onQuitRequested: () => Promise<void>): Promise<void> {
    const request: QuitRequest | null = await this.nativeService.readJson<QuitRequest>(`${dir}/${QUIT_FILE}`);
    if (request?.pid === NL_PID) await onQuitRequested();
  }

  private async isInstance(lock: InstanceLock): Promise<boolean> {
    const image: string | null = await this.platform.processImageName(lock.pid);
    return !!image && (!lock.image || image.toLowerCase() === lock.image.toLowerCase());
  }

  private async waitForExit(lock: InstanceLock): Promise<boolean> {
    const deadline: number = Date.now() + HANDOVER_TIMEOUT;
    while (Date.now() < deadline) {
      if (!(await this.isInstance(lock))) return true;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return false;
  }
}
