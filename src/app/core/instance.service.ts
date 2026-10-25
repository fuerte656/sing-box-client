import { Injectable, inject } from '@angular/core';
import { events, filesystem } from '@neutralinojs/lib';
import { NativeService } from './native.service';
import { CorePlatform } from './platform/core-platform';

interface InstanceLock {
  pid: number;
  /** Executable name, to tell a live instance from an unrelated process that reused the PID. */
  image: string;
  startedAt: number;
}

interface QuitRequest {
  pid: number;
  requestedBy: number;
}

const DIR = 'instance';
const LOCK_FILE = 'instance.json';
const QUIT_FILE = 'quit-request.json';
/** The previous instance stops sing-box gracefully (up to ~7 s) before it exits. */
const HANDOVER_TIMEOUT = 15_000;

/**
 * Keeps a single running copy of the app. A newly launched instance takes over: it asks the
 * running one to quit (via a request file it watches), waits for it to stop sing-box cleanly,
 * and force-kills it only if it does not exit in time.
 */
@Injectable({ providedIn: 'root' })
export class InstanceService {
  private readonly native = inject(NativeService);
  private readonly platform = inject(CorePlatform);
  private watcherId: number | null = null;

  /** Takes over from a running instance, then listens for quit requests from future ones. */
  async claim(onQuitRequested: () => Promise<void>): Promise<void> {
    const dir = await this.native.path(DIR);
    await this.native.ensureDir(dir);
    const image = (await this.platform.processImageName(NL_PID)) ?? '';

    const previous = await this.native.readJson<InstanceLock>(`${dir}/${LOCK_FILE}`);
    if (previous && previous.pid !== NL_PID && (await this.isInstance(previous))) {
      await this.native.writeJson(`${dir}/${QUIT_FILE}`, { pid: previous.pid, requestedBy: NL_PID } satisfies QuitRequest);
      if (!(await this.waitForExit(previous))) {
        await this.platform.forceKill(previous.pid).catch(() => undefined);
      }
    }
    await this.closeUntracked(image);
    await this.native.remove(`${dir}/${QUIT_FILE}`);
    await this.native.writeJson(`${dir}/${LOCK_FILE}`, { pid: NL_PID, image, startedAt: Date.now() } satisfies InstanceLock);

    await events.on('watchFile', (ev) => {
      const detail = (ev as CustomEvent<{ id: number; filename: string }>).detail;
      if (detail.id === this.watcherId && detail.filename === QUIT_FILE) {
        void this.checkQuitRequest(dir, onQuitRequested);
      }
    });
    this.watcherId = await filesystem.createWatcher(dir);
  }

  /** Removes the lock on a normal exit, unless another instance already owns it. */
  async release(): Promise<void> {
    const lockPath = await this.native.path(DIR, LOCK_FILE);
    const lock = await this.native.readJson<InstanceLock>(lockPath);
    if (lock?.pid === NL_PID) await this.native.remove(lockPath);
  }

  /**
   * Copies started without the lock (older builds) cannot receive a quit request, so they are
   * terminated. Skipped for the bare Neutralino runtime used in development, whose name other
   * Neutralino apps share.
   */
  private async closeUntracked(image: string): Promise<void> {
    if (!image || image.toLowerCase().startsWith('neutralino')) return;
    const others = (await this.platform.findProcesses(image)).filter((pid) => pid !== NL_PID);
    for (const pid of others) {
      await this.platform.forceKill(pid).catch(() => undefined);
    }
  }

  private async checkQuitRequest(dir: string, onQuitRequested: () => Promise<void>): Promise<void> {
    const request = await this.native.readJson<QuitRequest>(`${dir}/${QUIT_FILE}`);
    if (request?.pid === NL_PID) await onQuitRequested();
  }

  private async isInstance(lock: InstanceLock): Promise<boolean> {
    const image = await this.platform.processImageName(lock.pid);
    return !!image && (!lock.image || image.toLowerCase() === lock.image.toLowerCase());
  }

  private async waitForExit(lock: InstanceLock): Promise<boolean> {
    const deadline = Date.now() + HANDOVER_TIMEOUT;
    while (Date.now() < deadline) {
      if (!(await this.isInstance(lock))) return true;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return false;
  }
}
