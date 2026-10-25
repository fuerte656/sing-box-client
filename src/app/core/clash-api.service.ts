import { Injectable, computed, signal } from '@angular/core';

export interface ClashEndpoint {
  baseUrl: string;
  secret: string;
}

export interface ConnectionMetadata {
  network: string;
  type: string;
  sourceIP: string;
  sourcePort: string;
  destinationIP: string;
  destinationPort: string;
  host: string;
  dnsMode?: string;
  processPath?: string;
}

export interface Connection {
  id: string;
  metadata: ConnectionMetadata;
  upload: number;
  download: number;
  start: string;
  chains: string[];
  rule: string;
  rulePayload: string;
  /** Bytes per second, derived from consecutive snapshots. */
  uploadSpeed: number;
  downloadSpeed: number;
  closedAt?: number;
}

export interface OutboundItem {
  name: string;
  type: string;
  delay: number | null;
}

export interface OutboundGroup {
  name: string;
  type: string;
  selected: string;
  selectable: boolean;
  items: OutboundItem[];
}

const HISTORY_LENGTH = 60;
const MAX_CLOSED_CONNECTIONS = 500;
const GROUP_TYPES = new Set(['Selector', 'URLTest', 'Fallback', 'LoadBalance']);
export const DEFAULT_TEST_URL = 'https://www.gstatic.com/generate_204';

/** Client for sing-box's Clash-compatible API (experimental.clash_api). */
@Injectable({ providedIn: 'root' })
export class ClashApiService {
  private endpoint: ClashEndpoint | null = null;
  private sockets: WebSocket[] = [];
  private reconnectTimers: ReturnType<typeof setTimeout>[] = [];
  private previous = new Map<string, Connection>();

  readonly connected = signal(false);
  readonly uploadSpeed = signal(0);
  readonly downloadSpeed = signal(0);
  readonly uploadHistory = signal<number[]>([]);
  readonly downloadHistory = signal<number[]>([]);
  readonly uploadTotal = signal(0);
  readonly downloadTotal = signal(0);
  readonly memory = signal(0);
  readonly connections = signal<Connection[]>([]);
  readonly closedConnections = signal<Connection[]>([]);
  readonly mode = signal('');
  readonly modeList = signal<string[]>([]);
  readonly activeCount = computed(() => this.connections().length);

  connect(endpoint: ClashEndpoint): void {
    this.disconnect();
    this.endpoint = endpoint;
    this.connected.set(true);
    this.openStream('/traffic', (data: { up: number; down: number }) => {
      this.uploadSpeed.set(data.up);
      this.downloadSpeed.set(data.down);
      this.uploadHistory.update((h) => [...h, data.up].slice(-HISTORY_LENGTH));
      this.downloadHistory.update((h) => [...h, data.down].slice(-HISTORY_LENGTH));
    });
    this.openStream('/memory', (data: { inuse: number }) => this.memory.set(data.inuse));
    this.openStream('/connections?interval=1000', (data) => this.applySnapshot(data));
    void this.refreshMode();
  }

  disconnect(): void {
    this.endpoint = null;
    this.connected.set(false);
    this.reconnectTimers.forEach(clearTimeout);
    this.reconnectTimers = [];
    for (const socket of this.sockets) {
      socket.onclose = null;
      socket.close();
    }
    this.sockets = [];
    // Move remaining connections to closed so they stay inspectable after stop.
    const now = Date.now();
    const remaining = this.connections().map((c) => ({ ...c, closedAt: now, uploadSpeed: 0, downloadSpeed: 0 }));
    this.closedConnections.update((closed) => [...remaining, ...closed].slice(0, MAX_CLOSED_CONNECTIONS));
    this.previous.clear();
    this.connections.set([]);
    this.uploadSpeed.set(0);
    this.downloadSpeed.set(0);
    this.memory.set(0);
  }

  resetHistory(): void {
    this.uploadHistory.set([]);
    this.downloadHistory.set([]);
    this.uploadTotal.set(0);
    this.downloadTotal.set(0);
    this.closedConnections.set([]);
  }

  /** Resolves once the API answers, used to detect that sing-box finished starting. */
  async ping(endpoint: ClashEndpoint): Promise<boolean> {
    try {
      const response = await fetch(`${endpoint.baseUrl}/version`, { headers: this.headers(endpoint) });
      return response.ok;
    } catch {
      return false;
    }
  }

  async refreshMode(): Promise<void> {
    const configs = await this.request<{ mode: string; 'mode-list'?: string[] }>('GET', '/configs');
    this.mode.set(configs.mode);
    this.modeList.set(configs['mode-list'] ?? []);
  }

  async setMode(mode: string): Promise<void> {
    await this.request('PATCH', '/configs', { mode });
    this.mode.set(mode);
  }

  /** Outbound groups, ordered as in `order` (the profile's outbound order). */
  async groups(order: string[] = []): Promise<OutboundGroup[]> {
    const { proxies } = await this.request<{ proxies: Record<string, any> }>('GET', '/proxies');
    const delayOf = (name: string): number | null => {
      const history = proxies[name]?.history as { delay: number }[] | undefined;
      const last = history?.[history.length - 1]?.delay;
      return last ? last : null;
    };
    const groups = Object.values(proxies)
      .filter((p) => GROUP_TYPES.has(p.type) && (p.name !== 'GLOBAL' || this.mode().toLowerCase() === 'global'))
      .map(
        (p): OutboundGroup => ({
          name: p.name,
          type: p.type,
          selected: p.now ?? '',
          selectable: p.type === 'Selector' || p.name === 'GLOBAL',
          items: (p.all as string[]).map((name) => ({ name, type: proxies[name]?.type ?? '', delay: delayOf(name) })),
        }),
      );
    const rank = (name: string) => {
      const index = order.indexOf(name);
      return index < 0 ? Number.MAX_SAFE_INTEGER : index;
    };
    return groups.sort((a, b) => rank(a.name) - rank(b.name));
  }

  async selectOutbound(group: string, outbound: string): Promise<void> {
    await this.request('PUT', `/proxies/${encodeURIComponent(group)}`, { name: outbound });
  }

  /** Tests every member of a group; returns outbound name → delay in ms (0 = failed). */
  async testGroup(group: string, url = DEFAULT_TEST_URL, timeout = 5000): Promise<Record<string, number>> {
    const query = `url=${encodeURIComponent(url)}&timeout=${timeout}`;
    return this.request('GET', `/group/${encodeURIComponent(group)}/delay?${query}`);
  }

  async closeConnection(id: string): Promise<void> {
    await this.request('DELETE', `/connections/${encodeURIComponent(id)}`);
  }

  async closeAllConnections(): Promise<void> {
    await this.request('DELETE', '/connections');
  }

  private async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const endpoint = this.endpoint;
    if (!endpoint) throw new Error('Service is not running');
    const response = await fetch(`${endpoint.baseUrl}${path}`, {
      method,
      headers: { ...this.headers(endpoint), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
      const text = await response.text();
      let message = text;
      try {
        message = JSON.parse(text).message ?? text;
      } catch {
        // plain-text error body
      }
      throw new Error(message || `${response.status} ${response.statusText}`);
    }
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  private headers(endpoint: ClashEndpoint): Record<string, string> {
    return endpoint.secret ? { Authorization: `Bearer ${endpoint.secret}` } : {};
  }

  private openStream(path: string, onMessage: (data: any) => void): void {
    const endpoint = this.endpoint;
    if (!endpoint) return;
    const url = new URL(endpoint.baseUrl.replace(/^http/, 'ws') + path);
    if (endpoint.secret) url.searchParams.set('token', endpoint.secret);
    const socket = new WebSocket(url);
    socket.onmessage = (event) => {
      try {
        onMessage(JSON.parse(event.data));
      } catch {
        // ignore malformed frames
      }
    };
    socket.onclose = () => {
      this.sockets = this.sockets.filter((s) => s !== socket);
      if (this.endpoint === endpoint) {
        this.reconnectTimers.push(setTimeout(() => this.endpoint === endpoint && this.openStream(path, onMessage), 1000));
      }
    };
    this.sockets.push(socket);
  }

  private applySnapshot(data: {
    connections: Omit<Connection, 'uploadSpeed' | 'downloadSpeed'>[] | null;
    uploadTotal: number;
    downloadTotal: number;
  }): void {
    this.uploadTotal.set(data.uploadTotal);
    this.downloadTotal.set(data.downloadTotal);
    const current = new Map<string, Connection>();
    for (const raw of data.connections ?? []) {
      const prev = this.previous.get(raw.id);
      current.set(raw.id, {
        ...raw,
        uploadSpeed: prev ? Math.max(0, raw.upload - prev.upload) : 0,
        downloadSpeed: prev ? Math.max(0, raw.download - prev.download) : 0,
      });
    }
    const now = Date.now();
    const closed: Connection[] = [];
    for (const [id, prev] of this.previous) {
      if (!current.has(id)) closed.push({ ...prev, closedAt: now, uploadSpeed: 0, downloadSpeed: 0 });
    }
    if (closed.length) {
      this.closedConnections.update((list) => [...closed, ...list].slice(0, MAX_CLOSED_CONNECTIONS));
    }
    this.previous = current;
    this.connections.set([...current.values()]);
  }
}
