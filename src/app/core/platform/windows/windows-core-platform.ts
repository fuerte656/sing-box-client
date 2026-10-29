import { events, os, SpawnedProcess } from '@neutralinojs/lib';
import { cyrillicToLatin, normalizeText } from '../../../shared/text-utils';
import { CorePlatform, ExecResult, PlatformId, TunPrivilegeResult } from '../core-platform';
import INTERRUPT_SCRIPT from './scripts/interrupt.ps1';
import CONSOLE_SOURCE from './scripts/SingBoxClientConsole.cs';
import WATCH_APP_SCRIPT from './scripts/watch-app.ps1';

/** interrupt.ps1 started ahead of a stop (see WindowsCorePlatform.prepareStop). */
/** Detail of Neutralino's spawnedProcess event. */
interface SpawnedProcessEvent {
  id: number;
  action: string;
  data: unknown;
}

interface Standby {
  /** sing-box PID it was started for. */
  pid: number;
  /** Neutralino's id of the spawned process. */
  id: number;
  exited: boolean;
  /** The script's exit code. */
  exit: Promise<number>;
}

/** PowerShell single-quoted (literal) string. */
const psQuote: (s: string) => string = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** cmd.exe's limit for a whole command line; Neutralino runs every command through cmd /c. */
const MAX_COMMAND_LENGTH: number = 8191;

/**
 * The C# helper on one line: it is passed inside the encoded command, which has to stay short.
 * Line comments go first, or on one line they would swallow the rest of the source.
 */
const CONSOLE_SOURCE_MIN: string = CONSOLE_SOURCE.replace(/\/\/.*$/gm, '').replace(/\s+/g, ' ').trim();

/**
 * A script as PowerShell's -EncodedCommand expects it: UTF-16LE, base64 (so about 2.7 characters
 * per source character). Comment lines and indentation are dropped first, to stay under
 * MAX_COMMAND_LENGTH.
 */
function encodeCommand(script: string): string {
  const body: string = script.replace(/^[ \t]*#.*(\r?\n|$)/gm, '').replace(/^[ \t]+/gm, '');
  let binary: string = '';
  for (let i: number = 0; i < body.length; i++) {
    const code: number = body.charCodeAt(i);
    binary += String.fromCharCode(code & 0xff, code >> 8);
  }
  return btoa(binary);
}

export class WindowsCorePlatform extends CorePlatform {
  readonly id: PlatformId = 'windows';
  readonly binaryName: string = 'sing-box.exe';
  readonly tunPrivilegeAction: string = 'Restart as administrator';
  readonly tunPrivilegeHint: string =
    'This profile uses a TUN inbound, which requires running the client as administrator.';

  private standby: Standby | null = null;
  private readonly standbyExits: Map<number, (code: number) => void> = new Map<number, (code: number) => void>();
  private listeningToStandby: boolean = false;

  releaseAssetName(version: string, arch: string): string {
    return `sing-box-${version}-windows-${this.goArch(arch)}.zip`;
  }

  nativePath(path: string): string {
    return path.replace(/\//g, '\\');
  }

  quote(arg: string): string {
    return `"${arg.replace(/"/g, '\\"')}"`;
  }

  async download(url: string, target: string, userAgent: string): Promise<void> {
    // curl.exe ships with Windows 10 1803+.
    const result: ExecResult = await this.exec(
      `curl.exe -fsSL --connect-timeout 15 --max-time 300 -A ${this.quote(userAgent)} -o ${this.quote(this.nativePath(target))} ${this.quote(url)}`,
    );
    if (result.exitCode !== 0) {
      throw new Error(result.stdErr.trim() || `curl exited with code ${result.exitCode}`);
    }
  }

  async extract(archive: string, targetDir: string): Promise<void> {
    // Use the system bsdtar (handles .zip) rather than a tar from Git or MSYS on PATH.
    const systemRoot: string = (await os.getEnv('SystemRoot')) || 'C:\\Windows';
    const result: ExecResult = await this.exec(
      `${this.quote(`${systemRoot}\\System32\\tar.exe`)} -xf ${this.quote(this.nativePath(archive))} -C ${this.quote(this.nativePath(targetDir))}`,
    );
    if (result.exitCode !== 0) {
      throw new Error(result.stdErr.trim() || 'Failed to extract archive');
    }
  }

  async makeExecutable(): Promise<void> {
    // Nothing to do on Windows.
  }

  async resolveCorePid(spawnedPid: number): Promise<number> {
    // Neutralino runs spawned commands as `cmd.exe /c <command>`; find the sing-box child.
    const result: ExecResult = await this.powershell(
      `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${spawnedPid} AND Name='${this.binaryName}'").ProcessId`,
    );
    const pid: number = parseInt(result.stdOut.trim(), 10);
    return Number.isFinite(pid) ? pid : spawnedPid;
  }

  /**
   * `start /B /WAIT` runs sing-box as the leader of its own process group, in the same console
   * and with the same output pipes, and the shell still exits with it. stopGracefully can then
   * signal that group alone: the console is shared with the app whenever the app was started
   * from one (a terminal, or the elevated relaunch), and a console-wide CTRL_BREAK quits the app too.
   */
  override coreCommand(commandLine: string): string {
    return `start "sing-box" /B /WAIT ${commandLine}`;
  }

  /**
   * Starts interrupt.ps1 in standby: PowerShell startup and compiling the C# helper take about
   * 2 s, which would otherwise come before every stop.
   */
  override async prepareStop(pid: number, timeoutMs: number): Promise<void> {
    await this.cancelPreparedStop();
    const command: string = this.powershellCommand(
      INTERRUPT_SCRIPT,
      `-TargetPid ${pid} -TimeoutMs ${timeoutMs} -ConsoleSource ${psQuote(CONSOLE_SOURCE_MIN)} -Standby`,
    );
    this.listenToStandby();
    const proc: SpawnedProcess = await os.spawnProcess(command);
    const standby: Standby = { pid, id: proc.id, exited: false, exit: Promise.resolve(-1) };
    standby.exit = new Promise<number>((resolve) =>
      this.standbyExits.set(proc.id, (code) => {
        standby.exited = true;
        resolve(code);
      }),
    );
    this.standby = standby;
  }

  override async cancelPreparedStop(): Promise<void> {
    const standby: Standby | null = this.standby;
    this.standby = null;
    // Closing stdin makes the script exit (code 5).
    if (standby && !standby.exited) await os.updateSpawnedProcess(standby.id, 'stdInEnd').catch(() => undefined);
  }

  async stopGracefully(pid: number, timeoutMs: number): Promise<boolean> {
    const standby: Standby | null = this.standby;
    this.standby = null;
    if (standby?.pid === pid && !standby.exited) {
      try {
        await os.updateSpawnedProcess(standby.id, 'stdIn', 'stop\n');
        const timeout: Promise<number> = new Promise<number>((resolve) => setTimeout(() => resolve(-1), timeoutMs + 3000));
        return (await Promise.race([standby.exit, timeout])) === 0;
      } catch {
        // Gone in the meantime: start the script now instead.
      }
    }
    const result: ExecResult = await this.powershell(
      INTERRUPT_SCRIPT,
      `-TargetPid ${pid} -TimeoutMs ${timeoutMs} -ConsoleSource ${psQuote(CONSOLE_SOURCE_MIN)}`,
    );
    return result.exitCode === 0;
  }

  async forceKill(pid: number): Promise<void> {
    await this.exec(`taskkill /PID ${pid} /T /F`);
  }

  async watchApp(appPid: number, appPort: number | undefined, lockPath: string): Promise<void> {
    await this.powershell(
      WATCH_APP_SCRIPT,
      `-AppPid ${appPid} -AppPort ${appPort ?? 0} -LockPath ${psQuote(this.nativePath(lockPath))} ` +
        `-ConsoleSource ${psQuote(CONSOLE_SOURCE_MIN)}`,
      true,
    );
  }

  async processImageName(pid: number): Promise<string | null> {
    // CSV row: "image","pid","session","#","mem"; tasklist prints an INFO line when nothing matches.
    const result: ExecResult = await this.exec(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`);
    const match: RegExpExecArray | null = /^"([^"]+)","(\d+)"/m.exec(result.stdOut);
    return match && Number(match[2]) === pid ? match[1] : null;
  }

  async findProcesses(imageName: string): Promise<number[]> {
    const result: ExecResult = await this.exec(`tasklist /FI "IMAGENAME eq ${imageName.replace(/"/g, '')}" /FO CSV /NH`);
    return [...result.stdOut.matchAll(/^"[^"]+","(\d+)"/gm)].map((m) => Number(m[1]));
  }

  /**
   * Neutralino's Windows notifications mangle every non-ASCII character (UTF-8 read as ANSI),
   * so text is transliterated: Cyrillic to Latin, common punctuation to ASCII, the rest to "?".
   */
  protected override notificationText(text: string): string {
    // Cyrillic first: decomposing would turn "й" into "и" + breve.
    return normalizeText(cyrillicToLatin(text));
  }

  async revealFile(path: string): Promise<void> {
    // explorer.exe exits with 1 even on success, so its result is not checked.
    await this.exec(`explorer.exe /select,${this.quote(this.nativePath(path))}`);
  }

  async openFolder(path: string): Promise<void> {
    // Same as revealFile: explorer.exe's exit code means nothing.
    await this.exec(`explorer.exe ${this.quote(this.nativePath(path))}`);
  }

  protected async launchUrl(url: string): Promise<void> {
    // os.open (ShellExecute) does nothing when the app runs elevated; explorer.exe hands the
    // URL to the user's own (non-elevated) shell, which opens the default browser.
    await this.exec(`explorer.exe ${this.quote(url)}`);
  }

  async openTerminal(command: string, title: string): Promise<void> {
    // `start` opens a new console window; the extra quotes keep cmd /k from stripping the command's own.
    const result: ExecResult = await this.exec(`start "${title.replace(/"/g, '')}" cmd /k "${command}"`);
    if (result.exitCode !== 0) {
      throw new Error(result.stdErr.trim() || 'Failed to open a terminal');
    }
  }

  async hasTunPrivileges(): Promise<boolean> {
    // wintun needs an elevated process; fltmc only succeeds in one.
    return (await this.exec('fltmc')).exitCode === 0;
  }

  /**
   * Relaunches the app elevated (UAC prompt); the new copy takes over from this one.
   * The elevated copy gets its own WebView2 data folder: WebView2 cannot share one between
   * processes of different elevation, and while this copy's browser process is still around the
   * new window ends up without a working UI (tray shown, but nothing responds, not even Quit).
   * WEBVIEW2_USER_DATA_FOLDER overrides the folder the runtime picks; RunAs does not pass the
   * environment on, so an elevated PowerShell sets it and starts the app from there.
   */
  async acquireTunPrivileges(): Promise<TunPrivilegeResult> {
    const [exe, ...args]: string[] = NL_ARGS;
    const exeName: string = exe.split(/[\\/]/).pop()!;
    const userDataFolder: string = `${await os.getEnv('APPDATA')}\\${exeName}\\EBWebView-admin`;
    const argumentList: string = args.length ? ` -ArgumentList ${args.map(psQuote).join(',')}` : '';
    const elevated: string =
      `$env:WEBVIEW2_USER_DATA_FOLDER = ${psQuote(userDataFolder)}; ` +
      `Start-Process -FilePath ${psQuote(exe)}${argumentList} -WorkingDirectory ${psQuote(NL_PATH)}`;
    const script: string =
      `Start-Process -FilePath powershell -Verb RunAs -WindowStyle Hidden ` +
      `-ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${encodeCommand(elevated)}'`;
    const result: ExecResult = await this.powershell(script);
    if (result.exitCode !== 0) {
      throw new Error(result.stdErr.trim() || 'Elevation was cancelled');
    }
    return 'relaunch';
  }

  /** `background` returns right away and leaves the command running, even after the app exits. */
  private exec(command: string, background = false): Promise<ExecResult> {
    return os.execCommand(command, { background });
  }

  /** Runs a script via -EncodedCommand (UTF-16LE base64) so no quoting or temp files are needed. */
  private async powershell(script: string, args = '', background = false): Promise<ExecResult> {
    return this.exec(this.powershellCommand(script, args), background);
  }

  private powershellCommand(script: string, args = ''): string {
    const body: string = args ? `& {${script}} ${args}` : script;
    const command: string = `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encodeCommand(body)}`;
    // Past the limit cmd.exe fails without running anything, which looks like the script did nothing.
    if (command.length > MAX_COMMAND_LENGTH) {
      throw new Error(`PowerShell command too long (${command.length} > ${MAX_COMMAND_LENGTH})`);
    }
    return command;
  }

  /** Records the standby script's exit code; subscribed once. */
  private listenToStandby(): void {
    if (this.listeningToStandby) return;
    this.listeningToStandby = true;
    void events.on('spawnedProcess', (ev) => {
      const { id, action, data }: SpawnedProcessEvent = (ev as CustomEvent<SpawnedProcessEvent>).detail;
      const onExit: ((code: number) => void) | undefined = this.standbyExits.get(id);
      if (!onExit || action !== 'exit') return;
      this.standbyExits.delete(id);
      onExit(Number(data));
    });
  }
}
