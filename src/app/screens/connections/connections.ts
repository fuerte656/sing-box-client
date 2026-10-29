import { ScrollingModule } from '@angular/cdk/scrolling';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';
import { RouterLink } from '@angular/router';
import { BoxService } from '../../core/box.service';
import { ClashApiService, Connection } from '../../core/clash-api.service';
import { Dialogs } from '../../shared/dialogs';
import { BytesPipe, SpeedPipe } from '../../shared/format';

export type ConnectionState = 'active' | 'closed' | 'all';
export type ConnectionSort = 'date' | 'traffic' | 'trafficTotal';

/** Filter state survives navigation to the details screen and back. */
const viewState = {
  state: signal<ConnectionState>('active'),
  sort: signal<ConnectionSort>('date'),
  query: signal(''),
};

export function connectionTarget(c: Connection): string {
  const host = c.metadata.host || c.metadata.destinationIP;
  return `${host.includes(':') ? `[${host}]` : host}:${c.metadata.destinationPort}`;
}

@Component({
  selector: 'app-connections',
  imports: [
    FormsModule,
    RouterLink,
    ScrollingModule,
    MatButtonModule,
    MatButtonToggleModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatMenuModule,
    MatTooltipModule,
    BytesPipe,
    SpeedPipe,
  ],
  templateUrl: './connections.html',
  styleUrl: './connections.scss',
})
export class Connections {
  private readonly dialogs = inject(Dialogs);
  readonly clash = inject(ClashApiService);
  readonly box = inject(BoxService);

  readonly state = viewState.state;
  readonly sort = viewState.sort;
  readonly query = viewState.query;
  readonly target = connectionTarget;
  /** Row height in px (connections.scss .row), for the virtual scroll viewport. */
  readonly rowHeight = 57;
  readonly trackById = (_: number, c: Connection) => c.id;

  readonly visible = computed(() => {
    const state = this.state();
    let list: Connection[] =
      state === 'active'
        ? this.clash.connections()
        : state === 'closed'
          ? this.clash.closedConnections()
          : [...this.clash.connections(), ...this.clash.closedConnections()];
    const query = this.query().trim().toLowerCase();
    if (query) {
      list = list.filter((c) =>
        [connectionTarget(c), c.metadata.sourceIP, c.metadata.processPath ?? '', c.rule, c.rulePayload, ...c.chains]
          .join(' ')
          .toLowerCase()
          .includes(query),
      );
    }
    const sorted = [...list];
    switch (this.sort()) {
      case 'traffic':
        sorted.sort((a, b) => b.uploadSpeed + b.downloadSpeed - (a.uploadSpeed + a.downloadSpeed));
        break;
      case 'trafficTotal':
        sorted.sort((a, b) => b.upload + b.download - (a.upload + a.download));
        break;
      default:
        sorted.sort((a, b) => b.start.localeCompare(a.start));
    }
    return sorted;
  });

  async close(connection: Connection, event: Event): Promise<void> {
    event.stopPropagation();
    event.preventDefault();
    try {
      await this.clash.closeConnection(connection.id);
    } catch (e) {
      await this.dialogs.error('Failed to close connection', e);
    }
  }

  async closeAll(): Promise<void> {
    const confirmed = await this.dialogs.confirm({
      title: 'Close all connections',
      message: `Close ${this.clash.activeCount()} active connections?`,
      confirm: 'Close all',
      destructive: true,
    });
    if (!confirmed) return;
    try {
      await this.clash.closeAllConnections();
    } catch (e) {
      await this.dialogs.error('Failed to close connections', e);
    }
  }

  processName(c: Connection): string {
    return c.metadata.processPath?.replace(/\\/g, '/').split('/').pop() ?? '';
  }
}
