import { os } from '@neutralinojs/lib';
import { cyrillicToLatin, normalizeText } from '../../shared/text-utils';
import { CorePlatform, ExecResult, TunPrivilegeResult } from './core-platform';
import INTERRUPT_SCRIPT from './scripts/interrupt.ps1';
import CONSOLE_SOURCE from './scripts/SingBoxClientConsole.cs';

/** PowerShell single-quoted (literal) string. */
const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

export class WindowsCorePlatform extends CorePlatform {
  readonly id = 'windows';
  readonly binaryName = 'sing-box.exe';
  readonly tunPrivilegeAction = 'Restart as administrator';
  readonly tunPrivilegeHint =
    'This profile uses a TUN inbound, which requires running the client as administrator.';

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
    const result = await this.exec(
      `curl.exe -fsSL --connect-timeout 15 --max-time 300 -A ${this.quote(userAgent)} -o ${this.quote(this.nativePath(target))} ${this.quote(url)}`,
    );
    if (result.exitCode !== 0) {
      throw new Error(result.stdErr.trim() || `curl exited with code ${result.exitCode}`);
    }
  }

  async extract(archive: string, targetDir: string): Promise<void> {
    // Use the system bsdtar (handles .zip) rather than a tar from Git or MSYS on PATH.
    const systemRoot = (await os.getEnv('SystemRoot')) || 'C:\\Windows';
    const result = await this.exec(
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
    const result = await this.powershell(
      `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${spawnedPid} AND Name='${this.binaryName}'").ProcessId`,
    );
    const pid = parseInt(result.stdOut.trim(), 10);
    return Number.isFinite(pid) ? pid : spawnedPid;
  }

  async stopGracefully(pid: number, timeoutMs: number): Promise<boolean> {
    const result = await this.powershell(
      INTERRUPT_SCRIPT,
      `-TargetPid ${pid} -TimeoutMs ${timeoutMs} -ConsoleSource ${psQuote(CONSOLE_SOURCE)}`,
    );
    return result.exitCode === 0;
  }

  async forceKill(pid: number): Promise<void> {
    await this.exec(`taskkill /PID ${pid} /T /F`);
  }

  async processImageName(pid: number): Promise<string | null> {
    // CSV row: "image","pid","session","#","mem"; tasklist prints an INFO line when nothing matches.
    const result = await this.exec(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`);
    const match = /^"([^"]+)","(\d+)"/m.exec(result.stdOut);
    return match && Number(match[2]) === pid ? match[1] : null;
  }

  async findProcesses(imageName: string): Promise<number[]> {
    const result = await this.exec(`tasklist /FI "IMAGENAME eq ${imageName.replace(/"/g, '')}" /FO CSV /NH`);
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

  async openTerminal(command: string, title: string): Promise<void> {
    // `start` opens a new console window; the extra quotes keep cmd /k from stripping the command's own.
    const result = await this.exec(`start "${title.replace(/"/g, '')}" cmd /k "${command}"`);
    if (result.exitCode !== 0) {
      throw new Error(result.stdErr.trim() || 'Failed to open a terminal');
    }
  }

  async hasTunPrivileges(): Promise<boolean> {
    // wintun needs an elevated process; fltmc only succeeds in one.
    return (await this.exec('fltmc')).exitCode === 0;
  }

  /** Relaunches the app elevated (UAC prompt); the new copy takes over from this one. */
  async acquireTunPrivileges(): Promise<TunPrivilegeResult> {
    const [exe, ...args] = NL_ARGS;
    const argumentList = args.length ? ` -ArgumentList ${args.map(psQuote).join(',')}` : '';
    const script = `Start-Process -FilePath ${psQuote(exe)}${argumentList} -WorkingDirectory ${psQuote(NL_PATH)} -Verb RunAs`;
    const result = await this.powershell(script);
    if (result.exitCode !== 0) {
      throw new Error(result.stdErr.trim() || 'Elevation was cancelled');
    }
    return 'relaunch';
  }

  private exec(command: string): Promise<ExecResult> {
    return os.execCommand(command);
  }

  /** Runs a script via -EncodedCommand (UTF-16LE base64) so no quoting or temp files are needed. */
  private powershell(script: string, args = ''): Promise<ExecResult> {
    const body = args ? `& {${script}} ${args}` : script;
    let binary = '';
    for (let i = 0; i < body.length; i++) {
      const code = body.charCodeAt(i);
      binary += String.fromCharCode(code & 0xff, code >> 8);
    }
    return this.exec(`powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${btoa(binary)}`);
  }
}
