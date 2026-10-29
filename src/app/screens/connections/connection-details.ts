import { DatePipe, Location } from '@angular/common';
import { Component, DestroyRef, WritableSignal, Signal, InputSignal, computed, inject, input, signal } from '@angular/core';
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
  private readonly clashApiService: ClashApiService = inject(ClashApiService);
  private readonly dialogs: Dialogs = inject(Dialogs);
  private readonly location: Location = inject(Location);

  /** Route parameter (component input binding). */
  readonly id: InputSignal<string> = input.required<string>();
  /** Last seen copy, so the screen keeps working after the connection is pruned. */
  private readonly lastSeen: WritableSignal<Connection | null> = signal<Connection | null>(null);
  private readonly now: WritableSignal<number> = signal(Date.now());

  readonly connection: Signal<Connection | null> = computed(() => {
    const id: string = this.id();
    const found: Connection | undefined = this.clashApiService.connections().find((c) => c.id === id) ?? this.clashApiService.closedConnections().find((c) => c.id === id);
    if (found) queueMicrotask(() => this.lastSeen.set(found));
    return found ?? this.lastSeen();
  });

  readonly target: Signal<string> = computed(() => {
    const c: Connection | null = this.connection();
    return c ? connectionTarget(c) : '';
  });

  readonly duration: Signal<string> = computed(() => {
    const c: Connection | null = this.connection();
    if (!c) return '';
    return formatDuration((c.closedAt ?? this.now()) - new Date(c.start).getTime());
  });

  constructor() {
    const timer: number = setInterval(() => this.now.set(Date.now()), 1000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  back(): void {
    this.location.back();
  }

  async close(): Promise<void> {
    const c: Connection | null = this.connection();
    if (!c) return;
    try {
      await this.clashApiService.closeConnection(c.id);
    } catch (e) {
      await this.dialogs.error('Failed to close connection', e);
    }
  }
}
