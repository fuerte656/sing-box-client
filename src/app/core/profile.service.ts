import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { Subject } from 'rxjs';
import { parseConfig } from './json';
import { NativeService } from './native.service';
import { CorePlatform } from './platform/core-platform';
import { SettingsService } from './settings.service';

export type ProfileType = 'local' | 'remote';

/** Outbound types the Groups screen lists. */
const GROUP_OUTBOUNDS = new Set(['selector', 'urltest']);

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

export interface NewProfileRequest {
  name: string;
  type: ProfileType;
  /** Local only: copy this file instead of creating an empty configuration. */
  importPath?: string;
  remoteUrl?: string;
  autoUpdate?: boolean;
  autoUpdateInterval?: number;
}

export const MIN_AUTO_UPDATE_INTERVAL = 15;

const EMPTY_CONFIG = `{
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
export function parseImportLink(link: string): { url: string; name: string } | null {
  try {
    const parsed = new URL(link.trim());
    if (parsed.protocol !== 'sing-box:' || parsed.hostname !== 'import-remote-profile') return null;
    const url = parsed.searchParams.get('url');
    if (!url) return null;
    const name = decodeURIComponent(parsed.hash.replace(/^#/, '')) || new URL(url).hostname;
    return { url, name };
  } catch {
    return null;
  }
}

@Injectable({ providedIn: 'root' })
export class ProfileService {
  private readonly native = inject(NativeService);
  private readonly settings = inject(SettingsService);
  private readonly platform = inject(CorePlatform);

  readonly profiles = signal<Profile[]>([]);
  readonly selectedId = computed(() => this.settings.values().selectedProfile);
  readonly selected = computed(() => this.profiles().find((p) => p.id === this.selectedId()) ?? null);
  /** Emits the id of a profile whose configuration content changed. */
  readonly contentChanged = new Subject<number>();
  /** Whether the selected profile declares selector/urltest outbounds; null until checked. */
  readonly selectedHasGroups = signal<boolean | null>(null);

  private groupsCheck = 0;

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
      if (!this.native.available) return;
      await this.native.ensureDir(await this.native.path('profiles'));
      const list = (await this.native.readJson<Profile[]>(await this.native.path('profiles.json'))) ?? [];
      this.profiles.set(list.sort((a, b) => a.order - b.order));
      this.updateTimer ??= setInterval(() => void this.runAutoUpdate(), 60_000);
    })();
    return this.loaded;
  }

  get(id: number): Profile | undefined {
    return this.profiles().find((p) => p.id === id);
  }

  contentPath(id: number): Promise<string> {
    return this.native.path('profiles', `${id}.json`);
  }

  async readContent(id: number): Promise<string> {
    return (await this.native.readText(await this.contentPath(id))) ?? '';
  }

  async writeContent(id: number, content: string): Promise<void> {
    await this.native.writeText(await this.contentPath(id), content);
    this.contentChanged.next(id);
  }

  async create(request: NewProfileRequest): Promise<Profile> {
    const list = this.profiles();
    const id = list.reduce((max, p) => Math.max(max, p.id), 0) + 1;
    const profile: Profile = {
      id,
      name: request.name.trim(),
      type: request.type,
      order: list.reduce((max, p) => Math.max(max, p.order), 0) + 1,
      lastUpdated: Date.now(),
    };
    const path = await this.contentPath(id);
    if (request.type === 'remote') {
      profile.remoteUrl = request.remoteUrl!.trim();
      profile.autoUpdate = request.autoUpdate ?? true;
      profile.autoUpdateInterval = Math.max(request.autoUpdateInterval ?? 60, MIN_AUTO_UPDATE_INTERVAL);
      await this.fetchRemote(profile.remoteUrl, path);
    } else if (request.importPath) {
      const content = await this.native.readText(request.importPath.replace(/\\/g, '/'));
      if (content == null) throw new Error(`Cannot read ${request.importPath}`);
      validateJson(content);
      await this.native.writeText(path, content);
    } else {
      await this.native.writeText(path, EMPTY_CONFIG);
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
    await this.native.remove(await this.contentPath(id));
    const remaining = this.profiles().filter((p) => p.id !== id);
    await this.save(remaining);
    if (this.selectedId() === id) {
      await this.settings.update({ selectedProfile: remaining[0]?.id ?? -1 });
    }
  }

  async move(id: number, direction: -1 | 1): Promise<void> {
    const list = [...this.profiles()];
    const index = list.findIndex((p) => p.id === id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= list.length) return;
    [list[index], list[target]] = [list[target], list[index]];
    await this.save(list.map((p, i) => ({ ...p, order: i + 1 })));
  }

  async select(id: number): Promise<void> {
    await this.settings.update({ selectedProfile: id });
  }

  /** Re-downloads a remote profile; emits contentChanged only when the content actually differs. */
  async updateRemote(id: number): Promise<boolean> {
    const profile = this.get(id);
    if (!profile?.remoteUrl) return false;
    const path = await this.contentPath(id);
    const before = await this.native.readText(path);
    await this.fetchRemote(profile.remoteUrl, path);
    await this.edit(id, { lastUpdated: Date.now() });
    const changed = before !== (await this.native.readText(path));
    if (changed) this.contentChanged.next(id);
    return changed;
  }

  async exportTo(id: number, target: string): Promise<void> {
    await this.native.writeText(target.replace(/\\/g, '/'), await this.readContent(id));
  }

  private async checkGroups(id: number | undefined): Promise<void> {
    if (!this.native.available) return;
    const check = ++this.groupsCheck;
    let hasGroups = false;
    if (id !== undefined) {
      try {
        const config = parseConfig<{ outbounds?: { type?: string }[] }>(await this.readContent(id));
        hasGroups = (config.outbounds ?? []).some((o) => GROUP_OUTBOUNDS.has(o.type ?? ''));
      } catch {
        // An unreadable or invalid profile has no groups to show.
      }
    }
    if (check === this.groupsCheck) this.selectedHasGroups.set(hasGroups);
  }

  private async fetchRemote(url: string, target: string): Promise<void> {
    const temp = `${target}.download`;
    try {
      await this.platform.download(url, temp, `sing-box-client/${NL_APPVERSION} (sing-box)`);
      const content = (await this.native.readText(temp)) ?? '';
      validateJson(content);
      await this.native.writeText(target, content);
    } finally {
      await this.native.remove(temp);
    }
  }

  private async runAutoUpdate(): Promise<void> {
    const now = Date.now();
    for (const profile of this.profiles()) {
      if (profile.type !== 'remote' || !profile.autoUpdate) continue;
      const interval = Math.max(profile.autoUpdateInterval ?? 60, MIN_AUTO_UPDATE_INTERVAL) * 60_000;
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
    await this.native.writeJson(await this.native.path('profiles.json'), this.profiles());
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
