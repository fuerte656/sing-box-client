import { Service, WritableSignal, inject, signal } from '@angular/core';
import { computer, ExecCommandResult, DirectoryEntry, filesystem } from '@neutralinojs/lib';
import { NativeService } from './native.service';
import { CorePlatform } from './platform/core-platform';

export interface LatestRelease {
  version: string;
  publishedAt: string;
  htmlUrl: string;
  assetName: string;
  downloadUrl: string;
}

/** The fields of a GitHub release (REST API) that are used here. */
interface GithubRelease {
  tag_name: string;
  published_at: string;
  html_url: string;
  assets: GithubAsset[];
}

interface GithubAsset {
  name: string;
  browser_download_url: string;
}

/** A version split into its numeric parts and prerelease suffix. */
interface ParsedVersion {
  parts: number[];
  pre: string;
}

export type CoreUpdateStage = 'idle' | 'checking' | 'downloading' | 'extracting' | 'installing';

const RELEASES_API: string = 'https://api.github.com/repos/SagerNet/sing-box/releases/latest';

/** Manages the sing-box binary that lives in the app data folder (data/core). */
@Service()
export class CoreBinaryService {
  private readonly nativeService: NativeService = inject(NativeService);
  private readonly platform: CorePlatform = inject(CorePlatform);

  /** Installed core version, e.g. "1.14.4"; null when the binary is missing. */
  readonly version: WritableSignal<string | null> = signal<string | null>(null);
  /** Native path of the binary, shown in Settings. */
  readonly binaryPath: WritableSignal<string> = signal('');
  readonly stage: WritableSignal<CoreUpdateStage> = signal<CoreUpdateStage>('idle');

  async coreDir(): Promise<string> {
    const dir: string = await this.nativeService.path('core');
    await this.nativeService.ensureDir(dir);
    return dir;
  }

  async binary(): Promise<string> {
    return `${await this.coreDir()}/${this.platform.binaryName}`;
  }

  async refresh(): Promise<string | null> {
    if (!this.nativeService.available) return null;
    const binary: string = await this.binary();
    this.binaryPath.set(this.platform.nativePath(binary));
    let version: string | null = null;
    if (await this.nativeService.exists(binary)) {
      const result: ExecCommandResult = await this.nativeService.exec(`${this.platform.quote(this.platform.nativePath(binary))} version`);
      version = /sing-box version (\S+)/.exec(result.stdOut)?.[1] ?? null;
    }
    this.version.set(version);
    return version;
  }

  /** Runs `sing-box check` on a configuration; resolves to null when valid, else the error output. */
  async check(content: string): Promise<string | null> {
    const binary: string = await this.binary();
    if (!(await this.nativeService.exists(binary))) throw new Error('sing-box is not installed');
    const dir: string = await this.nativeService.path('work');
    await this.nativeService.ensureDir(dir);
    const file: string = `${dir}/check.json`;
    await this.nativeService.writeText(file, content);
    try {
      const p: CorePlatform = this.platform;
      const result: ExecCommandResult = await this.nativeService.exec(
        `${p.quote(p.nativePath(binary))} check -c ${p.quote(p.nativePath(file))} -D ${p.quote(p.nativePath(dir))} --disable-color`,
      );
      return result.exitCode === 0 ? null : (result.stdErr || result.stdOut).trim() || `exit code ${result.exitCode}`;
    } finally {
      await this.nativeService.remove(file);
    }
  }

  /** Latest production release; GitHub's /releases/latest never returns prereleases. */
  async latestRelease(): Promise<LatestRelease> {
    this.stage.set('checking');
    try {
      const response: Response = await fetch(RELEASES_API, { headers: { Accept: 'application/vnd.github+json' } });
      if (!response.ok) {
        throw new Error(`GitHub API returned ${response.status} ${response.statusText}`);
      }
      const release: GithubRelease = await response.json();
      const version: string = String(release.tag_name).replace(/^v/, '');
      const assetName: string = this.platform.releaseAssetName(version, await computer.getArch());
      const asset: GithubAsset | undefined = release.assets.find((a) => a.name === assetName);
      if (!asset) throw new Error(`Release ${version} has no ${assetName}`);
      return {
        version,
        publishedAt: release.published_at,
        htmlUrl: release.html_url,
        assetName,
        downloadUrl: asset.browser_download_url,
      };
    } finally {
      this.stage.set('idle');
    }
  }

  /**
   * Downloads and installs a release into data/core. The caller must stop a running
   * service first, since Windows keeps the binary locked while it runs.
   */
  async install(release: LatestRelease): Promise<void> {
    const coreDir: string = await this.coreDir();
    const workDir: string = await this.nativeService.path('core-update');
    await this.nativeService.remove(workDir);
    await this.nativeService.ensureDir(workDir);
    try {
      const archive: string = `${workDir}/${release.assetName}`;
      this.stage.set('downloading');
      await this.platform.download(release.downloadUrl, archive, 'sing-box-client');

      this.stage.set('extracting');
      const extractDir: string = `${workDir}/extract`;
      await this.nativeService.ensureDir(extractDir);
      await this.platform.extract(archive, extractDir);

      this.stage.set('installing');
      const baseName: (path: string) => string = (path: string) => path.replace(/\\/g, '/').split('/').pop()!;
      const files: DirectoryEntry[] = (await filesystem.readDirectory(extractDir, { recursive: true })).filter(
        (e) => e.type === 'FILE',
      );
      if (!files.some((f) => baseName(f.path) === this.platform.binaryName)) {
        throw new Error(`Archive does not contain ${this.platform.binaryName}`);
      }
      for (const file of files) {
        const target: string = `${coreDir}/${baseName(file.path)}`;
        await this.nativeService.remove(target);
        await filesystem.move(file.path, target);
      }
      await this.platform.makeExecutable(await this.binary());
    } finally {
      this.stage.set('idle');
      await this.nativeService.remove(workDir).catch(() => undefined);
    }
    await this.refresh();
  }
}

/** Compares dotted versions with an optional prerelease suffix; returns >0 when a is newer. */
export function compareVersions(a: string, b: string): number {
  const parse: (v: string) => ParsedVersion = (v: string): ParsedVersion => {
    const [main, pre]: string[] = v.replace(/^v/, '').split('-', 2);
    return { parts: main.split('.').map((n) => parseInt(n, 10) || 0), pre };
  };
  const va: ParsedVersion = parse(a);
  const vb: ParsedVersion = parse(b);
  for (let i: number = 0; i < Math.max(va.parts.length, vb.parts.length); i++) {
    const diff: number = (va.parts[i] ?? 0) - (vb.parts[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (va.pre && !vb.pre) return -1;
  if (!va.pre && vb.pre) return 1;
  return (va.pre ?? '').localeCompare(vb.pre ?? '');
}
