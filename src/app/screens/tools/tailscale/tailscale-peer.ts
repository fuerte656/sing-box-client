import { Location } from '@angular/common';
import { Component, DestroyRef, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { clipboard, filesystem, os } from '@neutralinojs/lib';
import { DaemonService } from '../../../core/daemon/daemon.service';
import { NativeService } from '../../../core/native.service';
import { Dialogs } from '../../../shared/dialogs';
import { BytesPipe } from '../../../shared/format';
import { PING_HISTORY, PingChart, PingSample } from './ping-chart';
import { findPeer, ipv4, ipv6, magicDnsName, peerTitle, relativeTime } from './tailscale-utils';

interface AddressRow {
  value: string;
  label: string;
}

@Component({
  selector: 'app-tailscale-peer',
  imports: [
    FormsModule,
    MatButtonModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatProgressBarModule,
    MatTooltipModule,
    BytesPipe,
    PingChart,
  ],
  templateUrl: './tailscale-peer.html',
  styleUrl: './tailscale.scss',
})
export class TailscalePeerScreen {
  private readonly daemon = inject(DaemonService);
  private readonly native = inject(NativeService);
  private readonly dialogs = inject(Dialogs);
  private readonly location = inject(Location);

  /** Route parameters. */
  readonly tag = input.required<string>();
  readonly peerId = input.required<string>();

  readonly endpoint = computed(() => this.daemon.tailscaleEndpoint(this.tag()));
  readonly peer = computed(() => findPeer(this.endpoint(), this.peerId()));
  readonly isSelf = computed(() => this.endpoint()?.self?.stableID === this.peerId());
  readonly title = computed(() => {
    const p = this.peer();
    return p ? peerTitle(p) : 'Peer';
  });

  readonly addresses = computed<AddressRow[]>(() => {
    const p = this.peer();
    if (!p) return [];
    const rows: AddressRow[] = [];
    if (p.dnsName) rows.push({ value: magicDnsName(p), label: 'MagicDNS' });
    if (p.hostName) rows.push({ value: p.hostName, label: 'Hostname' });
    const v4 = ipv4(p);
    const v6 = ipv6(p);
    if (v4) rows.push({ value: v4, label: 'IPv4' });
    if (v6) rows.push({ value: v6, label: 'IPv6' });
    return rows;
  });

  readonly canSendFiles = computed(() => {
    const p = this.peer();
    return !!p && !this.isSelf() && !!this.endpoint()?.canShareFiles && p.canReceiveFiles;
  });

  readonly keyExpiry = computed(() => {
    const p = this.peer();
    if (!p) return '';
    if (p.expired) return 'Expired';
    if (!p.keyExpiry) return 'Disabled';
    return relativeTime(p.keyExpiry);
  });

  // Ping
  readonly pinging = signal(false);
  readonly pingResults = signal<PingSample[]>([]);
  private pingAbort: AbortController | null = null;

  // Taildrop send
  readonly sending = signal(false);
  readonly dragging = signal(false);

  // SSH
  readonly sshUser = signal('');

  constructor() {
    inject(DestroyRef).onDestroy(() => this.pingAbort?.abort());
  }

  back(): void {
    this.location.back();
  }

  async copy(value: string): Promise<void> {
    await clipboard.writeText(value);
    this.dialogs.toast(`Copied ${value}`);
  }

  togglePing(): void {
    if (this.pinging()) {
      this.pingAbort?.abort();
      return;
    }
    const p = this.peer();
    const ip = p && (ipv4(p) ?? p.tailscaleIPs[0]);
    if (!ip) return;
    this.pingResults.set([]);
    this.pinging.set(true);
    this.pingAbort = new AbortController();
    this.daemon
      .ping(
        this.tag(),
        ip,
        (r) => this.pingResults.update((list) => [...list, { ...r, at: Date.now() }].slice(-PING_HISTORY)),
        this.pingAbort.signal,
      )
      .catch((e) => {
        if (!this.pingAbort?.signal.aborted) void this.dialogs.error('Ping failed', e);
      })
      .finally(() => {
        this.pinging.set(false);
        this.pingAbort = null;
      });
  }

  async chooseFiles(): Promise<void> {
    if (this.sending()) return;
    const files = await os.showOpenDialog('Send files with Taildrop', { multiSelections: true });
    if (files.length) await this.send(files);
  }

  onDragOver(event: DragEvent): void {
    event.preventDefault();
    this.dragging.set(true);
  }

  /** Dropped files have no filesystem path in a webview: stage them in the data folder first. */
  async onDrop(event: DragEvent): Promise<void> {
    event.preventDefault();
    this.dragging.set(false);
    const dropped = Array.from(event.dataTransfer?.files ?? []);
    if (!dropped.length || this.sending()) return;
    const staging = await this.native.path('taildrop-outgoing', String(Date.now()));
    await this.native.ensureDir(await this.native.path('taildrop-outgoing'));
    await this.native.ensureDir(staging);
    try {
      const paths: string[] = [];
      for (const file of dropped) {
        const target = `${staging}/${file.name}`;
        await filesystem.writeBinaryFile(target, await file.arrayBuffer());
        paths.push(target);
      }
      await this.send(paths);
    } finally {
      await this.native.remove(staging);
    }
  }

  async openSsh(): Promise<void> {
    const p = this.peer();
    if (!p) return;
    const host = magicDnsName(p) || ipv4(p) || p.tailscaleIPs[0];
    const user = this.sshUser().trim();
    try {
      await this.daemon.openSsh(this.tag(), user ? `${user}@${host}` : host);
    } catch (e) {
      await this.dialogs.error('Failed to open SSH', e);
    }
  }

  lastSeen(seconds: number): string {
    return relativeTime(seconds);
  }

  private async send(files: string[]): Promise<void> {
    const p = this.peer();
    if (!p) return;
    this.sending.set(true);
    try {
      await this.daemon.sendTaildropFiles(this.tag(), ipv4(p) ?? p.tailscaleIPs[0], files);
      this.dialogs.toast(files.length === 1 ? 'File sent' : `${files.length} files sent`);
    } catch (e) {
      await this.dialogs.error('Taildrop failed', e);
    } finally {
      this.sending.set(false);
    }
  }
}
