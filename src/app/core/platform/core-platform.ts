import { os } from '@neutralinojs/lib';

export type PlatformId = 'windows' | 'linux' | 'macos';

export interface ExecResult {
  stdOut: string;
  stdErr: string;
  exitCode: number;
}

/**
 * Outcome of {@link CorePlatform.acquireTunPrivileges}:
 * - `granted`: sing-box can now open a TUN interface; start it again.
 * - `relaunch`: an elevated copy of the app is starting; the current one should quit.
 */
export type TunPrivilegeResult = 'granted' | 'relaunch';

/**
 * Everything about running sing-box that differs between operating systems.
 * Obtain the instance for the current OS through {@link createCorePlatform}.
 */
export abstract class CorePlatform {
  abstract readonly id: PlatformId;
  /** File name of the core executable inside the data folder. */
  abstract readonly binaryName: string;
  /** Label of the button that calls {@link acquireTunPrivileges}. */
  abstract readonly tunPrivilegeAction: string;
  /** Explains why a TUN profile cannot start yet and what the action does. */
  abstract readonly tunPrivilegeHint: string;

  /** Name of the GitHub release asset for this platform, e.g. sing-box-1.14.4-windows-amd64.zip. */
  abstract releaseAssetName(version: string, arch: string): string;

  /** Converts a forward-slash path (as used by the Neutralino filesystem API) to the native form. */
  abstract nativePath(path: string): string;

  /** Quotes a path or argument for the platform shell. */
  abstract quote(arg: string): string;

  /** Downloads a URL to a file. */
  abstract download(url: string, target: string, userAgent: string): Promise<void>;

  /** Extracts a release archive into a directory. */
  abstract extract(archive: string, targetDir: string): Promise<void>;

  /** Prepares an installed binary for execution (e.g. chmod +x). */
  abstract makeExecutable(path: string): Promise<void>;

  /**
   * PID of the sing-box process itself. Neutralino starts commands through a shell
   * (cmd.exe /c on Windows, /bin/sh -c elsewhere), so the spawned PID may be the shell's.
   */
  abstract resolveCorePid(spawnedPid: number): Promise<number>;

  /** The shell command that starts sing-box, from its quoted command line; unchanged by default. */
  coreCommand(commandLine: string): string {
    return commandLine;
  }

  /**
   * Asks sing-box to shut down cleanly so it can undo system proxy / routes.
   * Resolves true once the process has exited within the timeout.
   */
  abstract stopGracefully(pid: number, timeoutMs: number): Promise<boolean>;

  /** Readies a later stopGracefully(pid, timeoutMs) in advance, where that is slow to start; no-op by default. */
  async prepareStop(_pid: number, _timeoutMs: number): Promise<void> {}

  /** Drops what prepareStop readied, once sing-box exited on its own. */
  async cancelPreparedStop(): Promise<void> {}

  /** Terminates the process and its children. */
  abstract forceKill(pid: number): Promise<void>;

  /**
   * Starts a detached watchdog for the app's lifetime. Once the app is gone without stopping
   * sing-box (crash, kill), it stops sing-box (gracefully, then by force), taking the PID from the
   * instance lock at `lockPath`. Where supported, it also kills the app when the UI has lost its
   * connection to the Neutralino runtime on `appPort`, since nothing (not even Quit) works then.
   */
  abstract watchApp(appPid: number, appPort: number | undefined, lockPath: string): Promise<void>;

  /** Executable file name of a running process (e.g. "sing-box-client-win_x64.exe"), or null if not running. */
  abstract processImageName(pid: number): Promise<string | null>;

  /** PIDs of running processes with the given executable name. */
  abstract findProcesses(imageName: string): Promise<number[]>;

  /** Desktop notification (shown near the tray on Windows). */
  async showNotification(title: string, body: string): Promise<void> {
    await os.showNotification(this.notificationText(title), this.notificationText(body));
  }

  /** Adapts text to what the OS notification API can display; unchanged by default. */
  protected notificationText(text: string): string {
    return text;
  }

  /** Opens the file manager at a file's folder, with the file selected where the OS supports it. */
  abstract revealFile(path: string): Promise<void>;

  /**
   * Name and version of the webview engine where the OS can tell more than the user agent
   * (e.g. "WebKitGTK 2.48.3"); null to rely on the user agent and client hints.
   */
  async webviewEngine(): Promise<string | null> {
    return null;
  }

  /** Opens a folder in the file manager. */
  abstract openFolder(path: string): Promise<void>;

  /** Opens an http(s) URL in the default browser. */
  async openUrl(url: string): Promise<void> {
    if (!/^https?:\/\//i.test(url)) throw new Error(`Not a web URL: ${url}`);
    await this.launchUrl(url);
  }

  protected abstract launchUrl(url: string): Promise<void>;

  /** Runs an interactive command (e.g. SSH) in a new terminal window. */
  abstract openTerminal(command: string, title: string): Promise<void>;

  /** Whether sing-box (at `binary`) can open a TUN interface with the current privileges. */
  abstract hasTunPrivileges(binary: string): Promise<boolean>;

  /** Obtains the privileges a TUN inbound needs; asks the user via the OS prompt. */
  abstract acquireTunPrivileges(binary: string): Promise<TunPrivilegeResult>;

  /** Maps Neutralino's computer.getArch() to Go's GOARCH naming used in release assets. */
  goArch(arch: string): string {
    const value: string = arch.toLowerCase();
    if (value.includes('arm64') || value === 'aarch64') return 'arm64';
    if (value === 'arm' || value === 'armhf' || value.startsWith('armv7')) return 'armv7';
    if (value === 'ia32' || value === 'x86' || value === '386') return '386';
    return 'amd64';
  }
}
