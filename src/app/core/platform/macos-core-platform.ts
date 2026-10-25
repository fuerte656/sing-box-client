import { PlatformId, TunPrivilegeResult } from './core-platform';
import { PosixCorePlatform } from './posix-core-platform';

export class MacosCorePlatform extends PosixCorePlatform {
  readonly id: PlatformId = 'macos';
  protected readonly releaseOs = 'darwin';
  readonly tunPrivilegeAction = 'Restart as administrator';
  readonly tunPrivilegeHint =
    'This profile uses a TUN inbound, which requires running the client as root. ' +
    'macOS will ask for an administrator password.';

  async hasTunPrivileges(): Promise<boolean> {
    return (await this.exec('id -u')).stdOut.trim() === '0';
  }

  /** Relaunches the app as root through the standard administrator prompt. */
  async acquireTunPrivileges(): Promise<TunPrivilegeResult> {
    const script = `do shell script ${appleScriptString(`${this.selfCommand()} >/dev/null 2>&1 &`)} with administrator privileges`;
    const result = await this.exec(`osascript -e ${this.quote(script)}`);
    if (result.exitCode !== 0) {
      throw new Error(result.stdErr.trim() || 'Elevation was cancelled');
    }
    return 'relaunch';
  }

  async openTerminal(command: string, title: string): Promise<void> {
    const shellCommand = `printf '\\033]0;%s\\007' ${this.quote(title)}; ${command}`;
    const script = `tell application "Terminal"
  activate
  do script ${appleScriptString(shellCommand)}
end tell`;
    const result = await this.exec(`osascript -e ${this.quote(script)}`);
    if (result.exitCode !== 0) {
      throw new Error(result.stdErr.trim() || 'Failed to open Terminal');
    }
  }
}

/** AppleScript string literal. */
function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
