import { TailscaleEndpointStatus, TailscalePeer } from '../../../core/daemon/models';

/** Display name like SFA: the first label of the MagicDNS name, falling back to the host name. */
export function peerTitle(peer: TailscalePeer): string {
  return peer.dnsName.split('.')[0] || peer.hostName;
}

export function magicDnsName(peer: TailscalePeer): string {
  return peer.dnsName.replace(/\.$/, '');
}

export function ipv4(peer: TailscalePeer): string | undefined {
  return peer.tailscaleIPs.find((ip) => !ip.includes(':'));
}

export function ipv6(peer: TailscalePeer): string | undefined {
  return peer.tailscaleIPs.find((ip) => ip.includes(':'));
}

/** Every peer of an endpoint, including this device. */
export function allPeers(status: TailscaleEndpointStatus): TailscalePeer[] {
  const peers = status.userGroups.flatMap((g) => g.peers);
  return status.self ? [status.self, ...peers] : peers;
}

export function findPeer(status: TailscaleEndpointStatus | undefined, stableID: string): TailscalePeer | undefined {
  return status ? allPeers(status).find((p) => p.stableID === stableID) : undefined;
}

export function isRunning(status: TailscaleEndpointStatus): boolean {
  return status.backendState === 'Running';
}

export function stateLabel(status: TailscaleEndpointStatus): string {
  if (status.stateText) return status.stateText;
  switch (status.backendState) {
    case 'Running':
      return 'Running';
    case 'NeedsLogin':
      return 'Needs login';
    case 'NeedsMachineAuth':
      return 'Needs machine approval';
    case 'Starting':
      return 'Starting';
    case 'Stopped':
      return 'Stopped';
    default:
      return status.backendState || 'Unknown';
  }
}

/** Relative time like "in 3 days" / "5 minutes ago" for Unix-second timestamps. */
export function relativeTime(unixSeconds: number): string {
  const diff = unixSeconds * 1000 - Date.now();
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 365 * 86400_000],
    ['month', 30 * 86400_000],
    ['day', 86400_000],
    ['hour', 3600_000],
    ['minute', 60_000],
  ];
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  for (const [unit, ms] of units) {
    if (Math.abs(diff) >= ms) return format.format(Math.round(diff / ms), unit);
  }
  return format.format(Math.round(diff / 1000), 'second');
}
