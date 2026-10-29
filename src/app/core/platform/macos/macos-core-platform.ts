import { ExecResult, PlatformId, TunPrivilegeResult } from '../core-platform';
import { PosixCorePlatform } from '../posix/posix-core-platform';
import WEBKIT_VERSION_SCRIPT from './scripts/webkit-version.sh';

export class MacosCorePlatform extends PosixCorePlatform {
  readonly id: PlatformId = 'macos';
  protected readonly releaseOs: string = 'darwin';
  readonly tunPrivilegeAction: string = 'Restart as administrator';
  readonly tunPrivilegeHint: string =
    'This profile uses a TUN inbound, which requires running the client as root. ' +
    'macOS will ask for an administrator password.';

  async hasTunPrivileges(): Promise<boolean> {
    return (await this.exec('id -u')).stdOut.trim() === '0';
  }

  /** Relaunches the app as root through the standard administrator prompt. */
  async acquireTunPrivileges(): Promise<TunPrivilegeResult> {
    const script: string = `do shell script ${appleScriptString(`${this.selfCommand()} >/dev/null 2>&1 &`)} with administrator privileges`;
    const result: ExecResult = await this.exec(`osascript -e ${this.quote(script)}`);
    if (result.exitCode !== 0) {
      throw new Error(result.stdErr.trim() || 'Elevation was cancelled');
    }
    return 'relaunch';
  }

  async revealFile(path: string): Promise<void> {
    const result: ExecResult = await this.exec(`open -R ${this.quote(path)}`);
    if (result.exitCode !== 0) throw new Error(result.stdErr.trim() || 'Failed to reveal file in Finder');
  }

  override async webviewEngine(): Promise<string | null> {
    const result: ExecResult = await this.exec(`sh -c ${this.quote(WEBKIT_VERSION_SCRIPT)} webkit-version`);
    const version: string = result.stdOut.trim();
    return result.exitCode === 0 && version ? `WebKit ${version}` : null;
  }

  async openFolder(path: string): Promise<void> {
    const result: ExecResult = await this.exec(`open ${this.quote(path)}`);
    if (result.exitCode !== 0) throw new Error(result.stdErr.trim() || 'Failed to open folder in Finder');
  }

  protected async launchUrl(url: string): Promise<void> {
    const result: ExecResult = await this.exec(`open ${this.quote(url)}`);
    if (result.exitCode !== 0) throw new Error(result.stdErr.trim() || 'Failed to open the browser');
  }

  async openTerminal(command: string, title: string): Promise<void> {
    const shellCommand: string = `printf '\\033]0;%s\\007' ${this.quote(title)}; ${command}`;
    const script: string = `tell application "Terminal"
  activate
  do script ${appleScriptString(shellCommand)}
end tell`;
    const result: ExecResult = await this.exec(`osascript -e ${this.quote(script)}`);
    if (result.exitCode !== 0) {
      throw new Error(result.stdErr.trim() || 'Failed to open Terminal');
    }
  }
}

/** AppleScript string literal. */
function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
