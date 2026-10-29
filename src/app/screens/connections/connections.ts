import { ScrollingModule } from '@angular/cdk/scrolling';
import { Component, computed, inject, Signal, signal, WritableSignal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';
import { RouterLink } from '@angular/router';
import { SingBoxService } from '../../core/sing-box.service';
import { ClashApiService, Connection } from '../../core/clash-api.service';
import { Dialogs } from '../../shared/dialogs';
import { BytesPipe, SpeedPipe } from '../../shared/format';

export type ConnectionState = 'active' | 'closed' | 'all';
export type ConnectionSort = 'date' | 'traffic' | 'trafficTotal';

/** Filter state survives navigation to the details screen and back. */
interface ConnectionsViewState {
  state: WritableSignal<ConnectionState>;
  sort: WritableSignal<ConnectionSort>;
  query: WritableSignal<string>;
}

const viewState: ConnectionsViewState = {
  state: signal<ConnectionState>('active'),
  sort: signal<ConnectionSort>('date'),
  query: signal<string>(''),
};

export function connectionTarget(c: Connection): string {
  const host: string = c.metadata.host || c.metadata.destinationIP;
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
  private readonly dialogs: Dialogs = inject(Dialogs);
  readonly clashApiService: ClashApiService = inject(ClashApiService);
  readonly singBoxService: SingBoxService = inject(SingBoxService);

  readonly state: WritableSignal<ConnectionState> = viewState.state;
  readonly sort: WritableSignal<ConnectionSort> = viewState.sort;
  readonly query: WritableSignal<string> = viewState.query;
  readonly target: (c: Connection) => string = connectionTarget;
  /** Row height in px (connections.scss .row), for the virtual scroll viewport. */
  readonly rowHeight: number = 57;
  readonly trackById: (_: number, c: Connection) => string = (_: number, c: Connection) => c.id;

  readonly visible: Signal<Connection[]> = computed(() => {
    const state: ConnectionState = this.state();
    let list: Connection[] =
      state === 'active'
        ? this.clashApiService.connections()
        : state === 'closed'
          ? this.clashApiService.closedConnections()
          : [...this.clashApiService.connections(), ...this.clashApiService.closedConnections()];
    const query: string = this.query().trim().toLowerCase();
    if (query) {
      list = list.filter((c) =>
        [connectionTarget(c), c.metadata.sourceIP, c.metadata.processPath ?? '', c.rule, c.rulePayload, ...c.chains]
          .join(' ')
          .toLowerCase()
          .includes(query),
      );
    }
    const sorted: Connection[] = [...list];
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
      await this.clashApiService.closeConnection(connection.id);
    } catch (e) {
      await this.dialogs.error('Failed to close connection', e);
    }
  }

  async closeAll(): Promise<void> {
    const confirmed: boolean = await this.dialogs.confirm({
      title: 'Close all connections',
      message: `Close ${this.clashApiService.activeCount()} active connections?`,
      confirm: 'Close all',
      destructive: true,
    });
    if (!confirmed) return;
    try {
      await this.clashApiService.closeAllConnections();
    } catch (e) {
      await this.dialogs.error('Failed to close connections', e);
    }
  }

  processName(c: Connection): string {
    return c.metadata.processPath?.replace(/\\/g, '/').split('/').pop() ?? '';
  }
}
