import { PlatformId, TunPrivilegeResult } from '../core-platform';
import { PosixCorePlatform } from '../posix/posix-core-platform';
import { launchTerminal } from './linux-terminals';

/** Capabilities sing-box needs for a TUN inbound with auto_route (see sing-box docs, Linux). */
const TUN_CAPABILITIES = 'cap_net_admin,cap_net_raw,cap_net_bind_service+ep';

export class LinuxCorePlatform extends PosixCorePlatform {
  readonly id: PlatformId = 'linux';
  protected readonly releaseOs = 'linux';
  readonly tunPrivilegeAction = 'Grant TUN permission';
  readonly tunPrivilegeHint =
    'This profile uses a TUN inbound. Grant the sing-box binary the network capabilities it needs ' +
    '(setcap, asks for your password once; repeat after updating the core).';

  async hasTunPrivileges(binary: string): Promise<boolean> {
    const uid = (await this.exec('id -u')).stdOut.trim();
    if (uid === '0') return true;
    const caps = await this.exec(`getcap ${this.quote(binary)} 2>/dev/null`);
    return /cap_net_admin/.test(caps.stdOut);
  }

  /** Gives only the sing-box binary the capabilities, so the GUI keeps running as the user. */
  async acquireTunPrivileges(binary: string): Promise<TunPrivilegeResult> {
    const setcap = `setcap ${TUN_CAPABILITIES} ${this.quote(binary)}`;
    const result = await this.exec(`pkexec ${setcap}`);
    if (result.exitCode === 0 && (await this.hasTunPrivileges(binary))) return 'granted';
    // pkexec needs a polkit agent (missing in WSL and minimal desktops) and fails with 126/127 when cancelled.
    throw new Error(
      (result.stdErr.trim() ? `${result.stdErr.trim()}\n\n` : '') + `Run this in a terminal, then start again:\nsudo ${setcap}`,
    );
  }

  /** Asks the desktop's file manager to select the file (freedesktop FileManager1), else opens its folder. */
  async revealFile(path: string): Promise<void> {
    const uri = 'file://' + path.split('/').map(encodeURIComponent).join('/');
    const select = await this.exec(
      `dbus-send --session --print-reply --dest=org.freedesktop.FileManager1 /org/freedesktop/FileManager1 ` +
        `org.freedesktop.FileManager1.ShowItems array:string:${this.quote(uri)} string:''`,
    );
    if (select.exitCode === 0) return;
    await this.openFolder(path.slice(0, path.lastIndexOf('/')) || '/');
  }

  async openFolder(path: string): Promise<void> {
    const result = await this.exec(`xdg-open ${this.quote(path)}`);
    if (result.exitCode !== 0) throw new Error(result.stdErr.trim() || 'No file manager found');
  }

  protected async launchUrl(url: string): Promise<void> {
    const result = await this.exec(`xdg-open ${this.quote(url)}`);
    if (result.exitCode !== 0) throw new Error(result.stdErr.trim() || 'No browser found');
  }

  async openTerminal(command: string, title: string): Promise<void> {
    const shellCommand = this.quote(`printf '\\033]0;%s\\007' ${this.quote(title)}; ${command}; echo; printf 'Press Enter to close'; read _`);
    await launchTerminal((cmd) => this.exec(cmd), shellCommand);
  }
}
