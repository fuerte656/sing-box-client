import { os } from '@neutralinojs/lib';
import { CorePlatform, ExecResult } from './core-platform';

/** Behaviour shared by Linux and macOS: POSIX shell, signals, ps/pgrep, tar.gz releases. */
export abstract class PosixCorePlatform extends CorePlatform {
  readonly binaryName = 'sing-box';
  /** `os` part of the release asset name (linux, darwin). */
  protected abstract readonly releaseOs: string;

  releaseAssetName(version: string, arch: string): string {
    return `sing-box-${version}-${this.releaseOs}-${this.goArch(arch)}.tar.gz`;
  }

  nativePath(path: string): string {
    return path;
  }

  quote(arg: string): string {
    return `'${arg.replace(/'/g, `'\\''`)}'`;
  }

  async download(url: string, target: string, userAgent: string): Promise<void> {
    const q = (s: string) => this.quote(s);
    const command =
      `if command -v curl >/dev/null 2>&1; then ` +
      `curl -fsSL --connect-timeout 15 --max-time 300 -A ${q(userAgent)} -o ${q(target)} ${q(url)}; ` +
      `else wget -q --timeout=60 -U ${q(userAgent)} -O ${q(target)} ${q(url)}; fi`;
    const result = await this.exec(command);
    if (result.exitCode !== 0) {
      throw new Error(result.stdErr.trim() || `download failed with code ${result.exitCode}`);
    }
  }

  async extract(archive: string, targetDir: string): Promise<void> {
    const result = await this.exec(`tar -xzf ${this.quote(archive)} -C ${this.quote(targetDir)}`);
    if (result.exitCode !== 0) {
      throw new Error(result.stdErr.trim() || 'Failed to extract archive');
    }
  }

  async makeExecutable(path: string): Promise<void> {
    const result = await this.exec(`chmod 755 ${this.quote(path)}`);
    if (result.exitCode !== 0) throw new Error(result.stdErr.trim() || `chmod failed for ${path}`);
  }

  async resolveCorePid(spawnedPid: number): Promise<number> {
    // `sh -c` usually execs a single command (same PID); otherwise sing-box is its child.
    const result = await this.exec(`pgrep -P ${spawnedPid} -x ${this.binaryName}`);
    const pid = parseInt(result.stdOut.trim().split('\n')[0], 10);
    return Number.isFinite(pid) ? pid : spawnedPid;
  }

  /** SIGINT, as Ctrl+C would; sing-box then closes inbounds and restores the system proxy. */
  async stopGracefully(pid: number, timeoutMs: number): Promise<boolean> {
    const steps = Math.ceil(timeoutMs / 200);
    const result = await this.exec(
      `kill -INT ${pid} 2>/dev/null || exit 0; ` +
        `i=0; while [ $i -lt ${steps} ]; do kill -0 ${pid} 2>/dev/null || exit 0; sleep 0.2; i=$((i+1)); done; exit 3`,
    );
    return result.exitCode === 0;
  }

  async forceKill(pid: number): Promise<void> {
    await this.exec(`pkill -KILL -P ${pid} 2>/dev/null; kill -KILL ${pid} 2>/dev/null; true`);
  }

  async watchApp(appPid: number, _appPort: number | undefined, lockPath: string): Promise<void> {
    // Polls the app, keeping sing-box's PID from the lock while the lock is this app's; once the
    // app is gone: SIGINT, up to 5 s to exit, then SIGKILL. (No UI check: the lost-UI case is Windows-only.)
    const field = (name: string) => `sed -n 's/.*"${name}": *\\([0-9]*\\).*/\\1/p' ${this.quote(lockPath)} 2>/dev/null`;
    await os.execCommand(
      `core=; while kill -0 ${appPid} 2>/dev/null; do ` +
        `[ "$(${field('pid')})" = ${appPid} ] && core=$(${field('corePid')}); sleep 2; done; ` +
        `[ -n "$core" ] && ps -p "$core" -o args= 2>/dev/null | grep -q ${this.quote(this.binaryName)} || exit 0; ` +
        `kill -INT "$core" 2>/dev/null || exit 0; ` +
        `i=0; while [ $i -lt 25 ]; do kill -0 "$core" 2>/dev/null || exit 0; sleep 0.2; i=$((i+1)); done; ` +
        `kill -KILL "$core" 2>/dev/null; true`,
      { background: true },
    );
  }

  async processImageName(pid: number): Promise<string | null> {
    // `comm` is truncated to 15 characters on Linux, so use the executable from argv[0].
    const result = await this.exec(`ps -p ${pid} -o args=`);
    const argv0 = result.stdOut.trim().split(/\s+/)[0];
    return result.exitCode === 0 && argv0 ? argv0.split('/').pop()! : null;
  }

  async findProcesses(imageName: string): Promise<number[]> {
    const result = await this.exec('ps -A -o pid=,args=');
    const pids: number[] = [];
    for (const line of result.stdOut.split('\n')) {
      const match = /^\s*(\d+)\s+(\S+)/.exec(line);
      if (match && match[2].split('/').pop() === imageName) pids.push(Number(match[1]));
    }
    return pids;
  }

  protected exec(command: string): Promise<ExecResult> {
    return os.execCommand(command);
  }

  /** Command line of this app, for relaunching it (NL_ARGS[0] is the executable). */
  protected selfCommand(): string {
    return NL_ARGS.map((arg) => this.quote(arg)).join(' ');
  }
}
