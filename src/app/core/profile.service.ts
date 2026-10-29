import { Service, Signal, WritableSignal, computed, effect, inject, signal } from '@angular/core';
import { Subject } from 'rxjs';
import { parseConfig } from './json';
import { NativeService } from './native.service';
import { CorePlatform } from './platform/core-platform';
import { SettingsService } from './settings.service';

export type ProfileType = 'local' | 'remote';

/** Outbound types the Groups screen lists. */
const GROUP_OUTBOUNDS: Set<string> = new Set(['selector', 'urltest']);

export interface Profile {
  id: number;
  name: string;
  type: ProfileType;
  order: number;
  remoteUrl?: string;
  autoUpdate?: boolean;
  /** Minutes, minimum 15 (same as SFA). */
  autoUpdateInterval?: number;
  /** Epoch milliseconds of the last successful remote fetch (or creation for local profiles). */
  lastUpdated?: number;
}

/** A remote profile from an sing-box://import-remote-profile link. */
export interface ImportLink {
  url: string;
  name: string;
}

/** The part of a sing-box config that tells whether it has outbound groups. */
interface OutboundsConfig {
  outbounds?: { type?: string }[];
}

export interface NewProfileRequest {
  name: string;
  type: ProfileType;
  /** Local only: copy this file instead of creating an empty configuration. */
  importPath?: string;
  remoteUrl?: string;
  autoUpdate?: boolean;
  autoUpdateInterval?: number;
}

export const MIN_AUTO_UPDATE_INTERVAL: number = 15;

const EMPTY_CONFIG: string = `{
  "log": {
    "level": "info"
  },
  "inbounds": [],
  "outbounds": [
    {
      "type": "direct",
      "tag": "direct"
    }
  ]
}
`;

/** Parses `sing-box://import-remote-profile?url=...#name` links produced by sing-box clients. */
export function parseImportLink(link: string): ImportLink | null {
  try {
    const parsed: URL = new URL(link.trim());
    if (parsed.protocol !== 'sing-box:' || parsed.hostname !== 'import-remote-profile') return null;
    const url: string | null = parsed.searchParams.get('url');
    if (!url) return null;
    const name: string = decodeURIComponent(parsed.hash.replace(/^#/, '')) || new URL(url).hostname;
    return { url, name };
  } catch {
    return null;
  }
}

@Service()
export class ProfileService {
  private readonly nativeService: NativeService = inject(NativeService);
  private readonly settingsService: SettingsService = inject(SettingsService);
  private readonly platform: CorePlatform = inject(CorePlatform);

  readonly profiles: WritableSignal<Profile[]> = signal<Profile[]>([]);
  readonly selectedId: Signal<number> = computed(() => this.settingsService.values().selectedProfile);
  readonly selected: Signal<Profile | null> = computed(() => this.profiles().find((p) => p.id === this.selectedId()) ?? null);
  /** Emits the id of a profile whose configuration content changed. */
  readonly contentChanged: Subject<number> = new Subject<number>();
  /** Whether the selected profile declares selector/urltest outbounds; null until checked. */
  readonly selectedHasGroups: WritableSignal<boolean | null> = signal<boolean | null>(null);

  private groupsCheck: number = 0;

  private loaded?: Promise<void>;
  private updateTimer?: ReturnType<typeof setInterval>;

  constructor() {
    effect(() => void this.checkGroups(this.selected()?.id));
    this.contentChanged.subscribe((id) => {
      if (id === this.selectedId()) void this.checkGroups(id);
    });
  }

  load(): Promise<void> {
    this.loaded ??= (async () => {
      if (!this.nativeService.available) return;
      await this.nativeService.ensureDir(await this.nativeService.path('profiles'));
      const list: Profile[] = (await this.nativeService.readJson<Profile[]>(await this.nativeService.path('profiles.json'))) ?? [];
      this.profiles.set(list.sort((a, b) => a.order - b.order));
      this.updateTimer ??= setInterval(() => void this.runAutoUpdate(), 60_000);
    })();
    return this.loaded;
  }

  get(id: number): Profile | undefined {
    return this.profiles().find((p) => p.id === id);
  }

  contentPath(id: number): Promise<string> {
    return this.nativeService.path('profiles', `${id}.json`);
  }

  async readContent(id: number): Promise<string> {
    return (await this.nativeService.readText(await this.contentPath(id))) ?? '';
  }

  async writeContent(id: number, content: string): Promise<void> {
    await this.nativeService.writeText(await this.contentPath(id), content);
    this.contentChanged.next(id);
  }

  async create(request: NewProfileRequest): Promise<Profile> {
    const list: Profile[] = this.profiles();
    const id: number = list.reduce((max, p) => Math.max(max, p.id), 0) + 1;
    const profile: Profile = {
      id,
      name: request.name.trim(),
      type: request.type,
      order: list.reduce((max, p) => Math.max(max, p.order), 0) + 1,
      lastUpdated: Date.now(),
    };
    const path: string = await this.contentPath(id);
    if (request.type === 'remote') {
      profile.remoteUrl = request.remoteUrl!.trim();
      profile.autoUpdate = request.autoUpdate ?? true;
      profile.autoUpdateInterval = Math.max(request.autoUpdateInterval ?? 60, MIN_AUTO_UPDATE_INTERVAL);
      await this.fetchRemote(profile.remoteUrl, path);
    } else if (request.importPath) {
      const content: string | null = await this.nativeService.readText(request.importPath.replace(/\\/g, '/'));
      if (content == null) throw new Error(`Cannot read ${request.importPath}`);
      validateJson(content);
      await this.nativeService.writeText(path, content);
    } else {
      await this.nativeService.writeText(path, EMPTY_CONFIG);
    }
    await this.save([...list, profile]);
    if (this.selectedId() === -1 || !this.selected()) {
      await this.select(id);
    }
    return profile;
  }

  async edit(id: number, patch: Partial<Omit<Profile, 'id'>>): Promise<void> {
    await this.save(this.profiles().map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }

  async delete(id: number): Promise<void> {
    await this.nativeService.remove(await this.contentPath(id));
    const remaining: Profile[] = this.profiles().filter((p) => p.id !== id);
    await this.save(remaining);
    if (this.selectedId() === id) {
      await this.settingsService.update({ selectedProfile: remaining[0]?.id ?? -1 });
    }
  }

  async move(id: number, direction: -1 | 1): Promise<void> {
    const list: Profile[] = [...this.profiles()];
    const index: number = list.findIndex((p) => p.id === id);
    const target: number = index + direction;
    if (index < 0 || target < 0 || target >= list.length) return;
    [list[index], list[target]] = [list[target], list[index]];
    await this.save(list.map((p, i) => ({ ...p, order: i + 1 })));
  }

  async select(id: number): Promise<void> {
    await this.settingsService.update({ selectedProfile: id });
  }

  /** Re-downloads a remote profile; emits contentChanged only when the content actually differs. */
  async updateRemote(id: number): Promise<boolean> {
    const profile: Profile | undefined = this.get(id);
    if (!profile?.remoteUrl) return false;
    const path: string = await this.contentPath(id);
    const before: string | null = await this.nativeService.readText(path);
    await this.fetchRemote(profile.remoteUrl, path);
    await this.edit(id, { lastUpdated: Date.now() });
    const changed: boolean = before !== (await this.nativeService.readText(path));
    if (changed) this.contentChanged.next(id);
    return changed;
  }

  async exportTo(id: number, target: string): Promise<void> {
    await this.nativeService.writeText(target.replace(/\\/g, '/'), await this.readContent(id));
  }

  private async checkGroups(id: number | undefined): Promise<void> {
    if (!this.nativeService.available) return;
    const check: number = ++this.groupsCheck;
    let hasGroups: boolean = false;
    if (id !== undefined) {
      try {
        const config: OutboundsConfig = parseConfig<OutboundsConfig>(await this.readContent(id));
        hasGroups = (config.outbounds ?? []).some((o) => GROUP_OUTBOUNDS.has(o.type ?? ''));
      } catch {
        // An unreadable or invalid profile has no groups to show.
      }
    }
    if (check === this.groupsCheck) this.selectedHasGroups.set(hasGroups);
  }

  private async fetchRemote(url: string, target: string): Promise<void> {
    const temp: string = `${target}.download`;
    try {
      await this.platform.download(url, temp, `sing-box-client/${NL_APPVERSION} (sing-box)`);
      const content: string = (await this.nativeService.readText(temp)) ?? '';
      validateJson(content);
      await this.nativeService.writeText(target, content);
    } finally {
      await this.nativeService.remove(temp);
    }
  }

  private async runAutoUpdate(): Promise<void> {
    const now: number = Date.now();
    for (const profile of this.profiles()) {
      if (profile.type !== 'remote' || !profile.autoUpdate) continue;
      const interval: number = Math.max(profile.autoUpdateInterval ?? 60, MIN_AUTO_UPDATE_INTERVAL) * 60_000;
      if (now - (profile.lastUpdated ?? 0) < interval) continue;
      try {
        await this.updateRemote(profile.id);
      } catch (e) {
        console.warn(`auto update of profile ${profile.name} failed`, e);
      }
    }
  }

  private async save(list: Profile[]): Promise<void> {
    this.profiles.set([...list].sort((a, b) => a.order - b.order));
    await this.nativeService.writeJson(await this.nativeService.path('profiles.json'), this.profiles());
  }
}

export function validateJson(content: string): void {
  if (!content.trim()) throw new Error('Configuration is empty');
  try {
    parseConfig(content);
  } catch (e) {
    throw new Error(`Invalid configuration: ${(e as Error).message}`);
  }
}
