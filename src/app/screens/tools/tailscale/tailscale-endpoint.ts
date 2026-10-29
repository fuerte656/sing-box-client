import { Location } from '@angular/common';
import { Component, computed, inject, input, Signal, InputSignal, signal, WritableSignal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSelectModule } from '@angular/material/select';
import { MatTooltipModule } from '@angular/material/tooltip';
import { RouterLink } from '@angular/router';
import { DaemonService } from '../../../core/daemon/daemon.service';
import { TaildropService } from '../../../core/daemon/taildrop.service';
import { TailscaleEndpointStatus, TaildropReceivingFile, TailscalePeer } from '../../../core/daemon/models';
import { CorePlatform } from '../../../core/platform/core-platform';
import { Dialogs } from '../../../shared/dialogs';
import { allPeers, ipv4, isRunning, peerTitle, relativeTime, stateLabel } from './tailscale-utils';

@Component({
  selector: 'app-tailscale-endpoint',
  imports: [
    RouterLink,
    MatButtonModule,
    MatFormFieldModule,
    MatIconModule,
    MatMenuModule,
    MatProgressBarModule,
    MatProgressSpinnerModule,
    MatSelectModule,
    MatTooltipModule,
  ],
  templateUrl: './tailscale-endpoint.html',
  styleUrl: './tailscale.scss',
})
export class TailscaleEndpoint {
  private readonly daemonService: DaemonService = inject(DaemonService);
  private readonly taildropService: TaildropService = inject(TaildropService);
  private readonly platform: CorePlatform = inject(CorePlatform);
  private readonly dialogs: Dialogs = inject(Dialogs);
  private readonly location: Location = inject(Location);

  /** Route parameter. */
  readonly tag: InputSignal<string> = input.required<string>();

  readonly status: Signal<TailscaleEndpointStatus | undefined> = computed(() => this.daemonService.tailscaleEndpoint(this.tag()));
  readonly running: Signal<boolean> = computed(() => {
    const s: TailscaleEndpointStatus | undefined = this.status();
    return !!s && isRunning(s);
  });
  /** Peers offering themselves as exit node, online first. */
  readonly exitNodeOptions: Signal<TailscalePeer[]> = computed(() => {
    const s: TailscaleEndpointStatus | undefined = this.status();
    if (!s) return [];
    return allPeers(s)
      .filter((p) => p.exitNodeOption && p.stableID !== s.self?.stableID)
      .sort((a, b) => Number(b.online) - Number(a.online) || peerTitle(a).localeCompare(peerTitle(b)));
  });
  readonly exitNodeBusy: WritableSignal<boolean> = signal(false);
  /** While a change is in flight the dropdown shows the requested node, then follows the live status. */
  private readonly pendingExitNode: WritableSignal<string | null> = signal<string | null>(null);
  readonly selectedExitNode: Signal<string> = computed(() => this.pendingExitNode() ?? this.status()?.exitNode?.stableID ?? '');
  readonly selectedExitNodeLabel: Signal<string> = computed(() => {
    const id: string = this.selectedExitNode();
    const peer: TailscalePeer | undefined = id ? this.exitNodeOptions().find((p) => p.stableID === id) : undefined;
    return peer ? peerTitle(peer) : id ? (this.status()?.exitNode ? peerTitle(this.status()!.exitNode!) : id) : 'None';
  });

  readonly receiving: Signal<TaildropReceivingFile[]> = computed(() => this.taildropService.receivingFor(this.tag()));
  readonly receivingPercent: Signal<number> = computed(() => {
    const files: TaildropReceivingFile[] = this.receiving();
    const total: number = files.reduce((sum, f) => sum + f.size, 0);
    return total ? Math.min(100, (files.reduce((sum, f) => sum + f.receivedBytes, 0) / total) * 100) : 0;
  });

  readonly title: (peer: TailscalePeer) => string = peerTitle;
  readonly ip: (peer: TailscalePeer) => string | undefined = ipv4;
  readonly stateLabel: (status: TailscaleEndpointStatus) => string = stateLabel;

  back(): void {
    this.location.back();
  }

  async openAuthUrl(url: string): Promise<void> {
    await this.platform.openUrl(url);
  }

  async setExitNode(stableID: string): Promise<void> {
    if (stableID === (this.status()?.exitNode?.stableID ?? '')) return;
    this.pendingExitNode.set(stableID);
    this.exitNodeBusy.set(true);
    try {
      await this.daemonService.setExitNode(this.tag(), stableID);
      // Keep showing the new choice until the status stream reports it (or give up after 5 s).
      for (let i: number = 0; i < 25 && (this.status()?.exitNode?.stableID ?? '') !== stableID; i++) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    } catch (e) {
      await this.dialogs.error('Failed to set exit node', e);
    } finally {
      // Back to the live status (reverts the dropdown if the change failed).
      this.pendingExitNode.set(null);
      this.exitNodeBusy.set(false);
    }
  }

  async logout(): Promise<void> {
    const confirmed: boolean = await this.dialogs.confirm({
      title: 'Log out',
      message: 'Log this device out of the Tailscale network? You will need to log in again to reconnect.',
      confirm: 'Log out',
      destructive: true,
    });
    if (!confirmed) return;
    try {
      await this.daemonService.logout(this.tag());
    } catch (e) {
      await this.dialogs.error('Failed to log out', e);
    }
  }

  keyBadge(peer: TailscalePeer): string | null {
    if (peer.expired) return 'Expired';
    if (!peer.keyExpiry) return 'Key expiry disabled';
    const days: number = (peer.keyExpiry * 1000 - Date.now()) / 86400_000;
    return days < 30 ? `Expires ${relativeTime(peer.keyExpiry)}` : null;
  }

  /** Online peers first, then by name, like the Tailscale clients. */
  sorted(peers: TailscalePeer[]): TailscalePeer[] {
    return [...peers].sort((a, b) => Number(b.online) - Number(a.online) || peerTitle(a).localeCompare(peerTitle(b)));
  }
}
