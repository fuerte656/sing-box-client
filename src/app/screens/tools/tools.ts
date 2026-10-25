import { Component, computed, inject } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { RouterLink } from '@angular/router';
import { BoxService } from '../../core/box.service';
import { CoreBinaryService } from '../../core/core-binary.service';
import { DaemonService } from '../../core/daemon/daemon.service';
import { stateLabel } from './tailscale/tailscale-utils';

@Component({
  selector: 'app-tools',
  imports: [RouterLink, MatIconModule, MatListModule],
  template: `
    <div class="page">
      <header class="page-header"><h1>Tools</h1></header>

      @if (box.status() !== 'started') {
        <div class="empty-state">
          <mat-icon>construction</mat-icon>
          <span>Start the service to use tools.</span>
        </div>
      } @else if (!daemon.connected()) {
        <div class="empty-state">
          <mat-icon>update</mat-icon>
          <span>Tools need sing-box 1.14 or newer (installed: {{ core.version() }}). Update it in Settings → Core.</span>
        </div>
      } @else {
        <h2 class="section-title">Endpoints</h2>
        @if (daemon.tailscale().length) {
          <mat-nav-list class="group">
            @for (endpoint of daemon.tailscale(); track endpoint.endpointTag) {
              <a mat-list-item [routerLink]="['/tools/tailscale', endpoint.endpointTag]">
                <mat-icon matListItemIcon>hub</mat-icon>
                <span matListItemTitle>Tailscale</span>
                <span matListItemLine class="muted">
                  {{ multiple() ? endpoint.endpointTag + ' · ' : '' }}{{ label(endpoint) }}
                </span>
              </a>
            }
          </mat-nav-list>
        } @else {
          <p class="muted">This profile has no Tailscale endpoints.</p>
        }
      }
    </div>
  `,
  styles: `
    :host { display: contents; }
    .page { overflow-y: auto; }
    .group {
      max-width: 720px;
      border-radius: 16px;
      background: var(--mat-sys-surface-container);
      padding: 4px 0;
    }
  `,
})
export class Tools {
  readonly box = inject(BoxService);
  readonly daemon = inject(DaemonService);
  readonly core = inject(CoreBinaryService);
  readonly multiple = computed(() => this.daemon.tailscale().length > 1);
  readonly label = stateLabel;
}
