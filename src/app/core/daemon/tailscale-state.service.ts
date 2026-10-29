import { Service, inject } from '@angular/core';
import { NativeService } from '../native.service';
import { ProfileService } from '../profile.service';
import { SettingsService } from '../settings.service';
import { parseConfig } from '../json';
import { TailscaleEndpointStatus, TailscalePeer } from './models';

/** What a Tailscale endpoint will use once sing-box starts, read while it is stopped. */
export interface SavedTailscaleEndpoint {
  endpointTag: string;
  /** Logged-in account (the Tailscale profile name), or null before the first login. */
  account: string | null;
  /** Saved exit node: its name when it was seen while running, else its stable ID; null for none. */
  exitNode: string | null;
  /** The profile's `exit_node`, which sing-box applies on every start over the saved one. */
  configExitNode: string | null;
}

/** The parts of a Tailscale endpoint in a sing-box config that are used here. */
interface TailscaleEndpointOptions {
  type?: string;
  tag?: string;
  state_directory?: string;
  exit_node?: string;
}

/** The parts of Tailscale's preferences (one per login profile) that are used here. */
interface TailscalePrefs {
  ExitNodeID?: string;
  ExitNodeIP?: string;
}

interface TailscaleLoginProfile {
  Name?: string;
}

/**
 * Tailscale keeps its preferences, including the selected exit node, in `tailscaled.state`
 * under the endpoint's state directory, so a selection survives restarts. This reads that
 * file while sing-box is stopped and remembers peer names while it runs, since the file
 * stores the exit node by stable ID only.
 */
@Service()
export class TailscaleStateService {
  private readonly nativeService: NativeService = inject(NativeService);
  private readonly profileService: ProfileService = inject(ProfileService);
  private readonly settingsService: SettingsService = inject(SettingsService);

  /** Saves the names of peers offering an exit node, from a running endpoint's status. */
  rememberPeerNames(endpoints: TailscaleEndpointStatus[]): void {
    const names: Record<string, string> = { ...this.settingsService.get('tailscalePeerNames') };
    let changed: boolean = false;
    for (const endpoint of endpoints) {
      const peers: TailscalePeer[] = endpoint.userGroups.flatMap((group) => group.peers);
      for (const peer of peers) {
        const name: string = peer.dnsName.split('.')[0] || peer.hostName;
        if (!peer.exitNodeOption || !peer.stableID || !name || names[peer.stableID] === name) continue;
        names[peer.stableID] = name;
        changed = true;
      }
    }
    if (changed) void this.settingsService.set('tailscalePeerNames', names);
  }

  /** Saved state of the selected profile's Tailscale endpoints; empty when it has none. */
  async load(): Promise<SavedTailscaleEndpoint[]> {
    const profileId: number = this.profileService.selectedId();
    if (profileId === -1) return [];
    let config: { endpoints?: TailscaleEndpointOptions[] };
    try {
      config = parseConfig<{ endpoints?: TailscaleEndpointOptions[] }>(await this.profileService.readContent(profileId));
    } catch {
      return [];
    }
    const endpoints: TailscaleEndpointOptions[] = (config.endpoints ?? []).filter((e) => e.type === 'tailscale');
    const workDir: string = await this.nativeService.path('work');
    const names: Record<string, string> = this.settingsService.get('tailscalePeerNames');
    const saved: SavedTailscaleEndpoint[] = [];
    for (const endpoint of endpoints) {
      const state: Record<string, string> | null = await this.readState(workDir, endpoint.state_directory);
      const prefs: TailscalePrefs | null = state ? currentPrefs(state) : null;
      const exitNodeID: string = prefs?.ExitNodeID ?? '';
      saved.push({
        endpointTag: endpoint.tag ?? 'tailscale',
        account: state ? currentAccount(state) : null,
        exitNode: exitNodeID ? (names[exitNodeID] ?? exitNodeID) : prefs?.ExitNodeIP || null,
        configExitNode: endpoint.exit_node || null,
      });
    }
    return saved;
  }

  /** The state file of a state directory, which sing-box resolves against its working directory. */
  private async readState(workDir: string, stateDirectory: string | undefined): Promise<Record<string, string> | null> {
    const dir: string = (stateDirectory || 'tailscale').replace(/\\/g, '/');
    // Environment variables ($HOME/...) are expanded by sing-box only; such a directory can't be read here.
    if (dir.includes('$')) return null;
    const absolute: boolean = dir.startsWith('/') || /^[a-z]:\//i.test(dir);
    return this.nativeService.readJson<Record<string, string>>(`${absolute ? dir : `${workDir}/${dir}`}/tailscaled.state`);
  }
}

/** Values in the state file are base64-encoded (JSON) bytes. */
function decodeValue<T>(value: string | undefined): T | null {
  if (!value) return null;
  try {
    const bytes: Uint8Array = Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    return null;
  }
}

/** The key of the current login profile's preferences, e.g. "profile-3c5e". */
function currentProfileKey(state: Record<string, string>): string | null {
  try {
    return atob(state['_current-profile'] ?? '') || null;
  } catch {
    return null;
  }
}

function currentPrefs(state: Record<string, string>): TailscalePrefs | null {
  const key: string | null = currentProfileKey(state);
  return key ? decodeValue<TailscalePrefs>(state[key]) : null;
}

function currentAccount(state: Record<string, string>): string | null {
  const key: string | null = currentProfileKey(state);
  const profiles: Record<string, TailscaleLoginProfile> | null = decodeValue(state['_profiles']);
  return (key && profiles?.[key.replace(/^profile-/, '')]?.Name) || null;
}
