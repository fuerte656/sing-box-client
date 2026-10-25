import { DatePipe, Location } from '@angular/common';
import { Component, DestroyRef, computed, inject, input, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { ClashApiService, Connection } from '../../core/clash-api.service';
import { Dialogs } from '../../shared/dialogs';
import { BytesPipe, SpeedPipe, formatDuration } from '../../shared/format';
import { connectionTarget } from './connections';

@Component({
  selector: 'app-connection-details',
  imports: [DatePipe, MatButtonModule, MatCardModule, MatIconModule, BytesPipe, SpeedPipe],
  templateUrl: './connection-details.html',
  styleUrl: './connection-details.scss',
})
export class ConnectionDetails {
  private readonly clash = inject(ClashApiService);
  private readonly dialogs = inject(Dialogs);
  private readonly location = inject(Location);

  /** Route parameter (component input binding). */
  readonly id = input.required<string>();
  /** Last seen copy, so the screen keeps working after the connection is pruned. */
  private readonly lastSeen = signal<Connection | null>(null);
  private readonly now = signal(Date.now());

  readonly connection = computed(() => {
    const id = this.id();
    const found = this.clash.connections().find((c) => c.id === id) ?? this.clash.closedConnections().find((c) => c.id === id);
    if (found) queueMicrotask(() => this.lastSeen.set(found));
    return found ?? this.lastSeen();
  });

  readonly target = computed(() => {
    const c = this.connection();
    return c ? connectionTarget(c) : '';
  });

  readonly duration = computed(() => {
    const c = this.connection();
    if (!c) return '';
    return formatDuration((c.closedAt ?? this.now()) - new Date(c.start).getTime());
  });

  constructor() {
    const timer = setInterval(() => this.now.set(Date.now()), 1000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  back(): void {
    this.location.back();
  }

  async close(): Promise<void> {
    const c = this.connection();
    if (!c) return;
    try {
      await this.clash.closeConnection(c.id);
    } catch (e) {
      await this.dialogs.error('Failed to close connection', e);
    }
  }
}
