import { Location } from '@angular/common';
import { Component, computed, inject, input, signal } from '@angular/core';
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
import { TailscalePeer } from '../../../core/daemon/models';
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
  private readonly daemon = inject(DaemonService);
  private readonly taildrop = inject(TaildropService);
  private readonly platform = inject(CorePlatform);
  private readonly dialogs = inject(Dialogs);
  private readonly location = inject(Location);

  /** Route parameter. */
  readonly tag = input.required<string>();

  readonly status = computed(() => this.daemon.tailscaleEndpoint(this.tag()));
  readonly running = computed(() => {
    const s = this.status();
    return !!s && isRunning(s);
  });
  /** Peers offering themselves as exit node, online first. */
  readonly exitNodeOptions = computed(() => {
    const s = this.status();
    if (!s) return [];
    return allPeers(s)
      .filter((p) => p.exitNodeOption && p.stableID !== s.self?.stableID)
      .sort((a, b) => Number(b.online) - Number(a.online) || peerTitle(a).localeCompare(peerTitle(b)));
  });
  readonly exitNodeBusy = signal(false);
  /** While a change is in flight the dropdown shows the requested node, then follows the live status. */
  private readonly pendingExitNode = signal<string | null>(null);
  readonly selectedExitNode = computed(() => this.pendingExitNode() ?? this.status()?.exitNode?.stableID ?? '');
  readonly selectedExitNodeLabel = computed(() => {
    const id = this.selectedExitNode();
    const peer = id ? this.exitNodeOptions().find((p) => p.stableID === id) : undefined;
    return peer ? peerTitle(peer) : id ? (this.status()?.exitNode ? peerTitle(this.status()!.exitNode!) : id) : 'None';
  });

  readonly receiving = computed(() => this.taildrop.receivingFor(this.tag()));
  readonly receivingPercent = computed(() => {
    const files = this.receiving();
    const total = files.reduce((sum, f) => sum + f.size, 0);
    return total ? Math.min(100, (files.reduce((sum, f) => sum + f.receivedBytes, 0) / total) * 100) : 0;
  });

  readonly title = peerTitle;
  readonly ip = ipv4;
  readonly stateLabel = stateLabel;

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
      await this.daemon.setExitNode(this.tag(), stableID);
      // Keep showing the new choice until the status stream reports it (or give up after 5 s).
      for (let i = 0; i < 25 && (this.status()?.exitNode?.stableID ?? '') !== stableID; i++) {
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
    const confirmed = await this.dialogs.confirm({
      title: 'Log out',
      message: 'Log this device out of the Tailscale network? You will need to log in again to reconnect.',
      confirm: 'Log out',
      destructive: true,
    });
    if (!confirmed) return;
    try {
      await this.daemon.logout(this.tag());
    } catch (e) {
      await this.dialogs.error('Failed to log out', e);
    }
  }

  keyBadge(peer: TailscalePeer): string | null {
    if (peer.expired) return 'Expired';
    if (!peer.keyExpiry) return 'Key expiry disabled';
    const days = (peer.keyExpiry * 1000 - Date.now()) / 86400_000;
    return days < 30 ? `Expires ${relativeTime(peer.keyExpiry)}` : null;
  }

  /** Online peers first, then by name, like the Tailscale clients. */
  sorted(peers: TailscalePeer[]): TailscalePeer[] {
    return [...peers].sort((a, b) => Number(b.online) - Number(a.online) || peerTitle(a).localeCompare(peerTitle(b)));
  }
}
