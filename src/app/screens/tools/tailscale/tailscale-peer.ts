import { Location } from '@angular/common';
import { Component, DestroyRef, WritableSignal, Signal, InputSignal, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { clipboard, os } from '@neutralinojs/lib';
import { DaemonService } from '../../../core/daemon/daemon.service';
import {
  OutgoingFile,
  OutgoingTransfer,
  SendSource,
  TaildropSendService,
  sourceFromFile,
  sourceFromPath,
} from '../../../core/daemon/taildrop-send.service';
import { Dialogs } from '../../../shared/dialogs';
import { BytesPipe } from '../../../shared/format';
import { PING_HISTORY, PingChart, PingSample } from './ping-chart';
import { findPeer, ipv4, ipv6, magicDnsName, peerTitle, relativeTime } from './tailscale-utils';
import { TailscaleEndpointStatus, TailscalePeer } from '../../../core/daemon/models';

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
  private readonly daemonService: DaemonService = inject(DaemonService);
  readonly taildropSendService: TaildropSendService = inject(TaildropSendService);
  private readonly dialogs: Dialogs = inject(Dialogs);
  private readonly location: Location = inject(Location);

  /** Route parameters. */
  readonly tag: InputSignal<string> = input.required<string>();
  readonly peerId: InputSignal<string> = input.required<string>();

  readonly endpoint: Signal<TailscaleEndpointStatus | undefined> = computed(() => this.daemonService.tailscaleEndpoint(this.tag()));
  readonly peer: Signal<TailscalePeer | undefined> = computed(() => findPeer(this.endpoint(), this.peerId()));
  readonly isSelf: Signal<boolean> = computed(() => this.endpoint()?.self?.stableID === this.peerId());
  readonly title: Signal<string> = computed(() => {
    const p: TailscalePeer | undefined = this.peer();
    return p ? peerTitle(p) : 'Peer';
  });

  readonly addresses: Signal<AddressRow[]> = computed<AddressRow[]>(() => {
    const p: TailscalePeer | undefined = this.peer();
    if (!p) return [];
    const rows: AddressRow[] = [];
    if (p.dnsName) rows.push({ value: magicDnsName(p), label: 'MagicDNS' });
    if (p.hostName) rows.push({ value: p.hostName, label: 'Hostname' });
    const v4: string | undefined = ipv4(p);
    const v6: string | undefined = ipv6(p);
    if (v4) rows.push({ value: v4, label: 'IPv4' });
    if (v6) rows.push({ value: v6, label: 'IPv6' });
    return rows;
  });

  readonly canSendFiles: Signal<boolean> = computed(() => {
    const p: TailscalePeer | undefined = this.peer();
    return !!p && !this.isSelf() && !!this.endpoint()?.canShareFiles && p.canReceiveFiles;
  });

  readonly keyExpiry: Signal<string> = computed(() => {
    const p: TailscalePeer | undefined = this.peer();
    if (!p) return '';
    if (p.expired) return 'Expired';
    if (!p.keyExpiry) return 'Disabled';
    return relativeTime(p.keyExpiry);
  });

  // Ping
  readonly pinging: WritableSignal<boolean> = signal(false);
  readonly pingResults: WritableSignal<PingSample[]> = signal<PingSample[]>([]);
  private pingAbort: AbortController | null = null;

  // Taildrop send
  readonly dragging: WritableSignal<boolean> = signal(false);
  /** This peer's transfers (session), newest first. */
  readonly transfers: Signal<OutgoingTransfer[]> = computed(() => this.taildropSendService.forPeer(this.peerId()));
  readonly hasFinished: Signal<boolean> = computed(() => this.transfers().some((t) => t.state !== 'sending'));

  // SSH
  readonly sshUser: WritableSignal<string> = signal('');

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
    const p: TailscalePeer | undefined = this.peer();
    const ip: string | undefined = p && (ipv4(p) ?? p.tailscaleIPs[0]);
    if (!ip) return;
    this.pingResults.set([]);
    this.pinging.set(true);
    this.pingAbort = new AbortController();
    this.daemonService
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
    const paths: string[] = await os.showOpenDialog('Send files with Taildrop', { multiSelections: true });
    if (!paths.length) return;
    try {
      this.send(await Promise.all(paths.map((path) => sourceFromPath(path))));
    } catch (e) {
      await this.dialogs.error('Cannot read the selected files', e);
    }
  }

  onDragOver(event: DragEvent): void {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    this.dragging.set(true);
  }

  /** Dropped files are streamed straight from the browser's File objects. */
  onDrop(event: DragEvent): void {
    event.preventDefault();
    this.dragging.set(false);
    const files: File[] = Array.from(event.dataTransfer?.files ?? []);
    if (files.length) this.send(files.map(sourceFromFile));
  }

  filePercent(file: OutgoingFile): number {
    return file.size ? Math.min(100, (file.sent / file.size) * 100) : file.done ? 100 : 0;
  }

  transferPercent(transfer: OutgoingTransfer): number {
    const total: number = transfer.files.reduce((sum, f) => sum + f.size, 0);
    const sent: number = transfer.files.reduce((sum, f) => sum + f.sent, 0);
    return total ? Math.min(100, (sent / total) * 100) : 0;
  }

  async openSsh(): Promise<void> {
    const p: TailscalePeer | undefined = this.peer();
    if (!p) return;
    const host: string = magicDnsName(p) || ipv4(p) || p.tailscaleIPs[0];
    const user: string = this.sshUser().trim();
    try {
      await this.daemonService.openSsh(this.tag(), user ? `${user}@${host}` : host);
    } catch (e) {
      await this.dialogs.error('Failed to open SSH', e);
    }
  }

  lastSeen(seconds: number): string {
    return relativeTime(seconds);
  }

  private send(sources: SendSource[]): void {
    const p: TailscalePeer | undefined = this.peer();
    if (!p) return;
    this.taildropSendService.send(this.tag(), p.stableID, peerTitle(p), sources);
  }

}
