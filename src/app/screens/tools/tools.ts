import { Component, computed, inject, Signal } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { RouterLink } from '@angular/router';
import { SingBoxService } from '../../core/sing-box.service';
import { CoreBinaryService } from '../../core/core-binary.service';
import { DaemonService } from '../../core/daemon/daemon.service';
import { stateLabel } from './tailscale/tailscale-utils';
import { TailscaleEndpointStatus } from '../../core/daemon/models';

@Component({
  selector: 'app-tools',
  imports: [RouterLink, MatIconModule, MatListModule],
  template: `
    <div class="page">
      <header class="page-header"><h1>Tools</h1></header>

      @if (singBoxService.status() !== 'started') {
        <div class="empty-state">
          <mat-icon>construction</mat-icon>
          <span>Start the service to use tools.</span>
        </div>
      } @else if (!daemonService.connected()) {
        <div class="empty-state">
          <mat-icon>update</mat-icon>
          <span>Tools need sing-box 1.14 or newer (installed: {{ coreBinaryService.version() }}). Update it in Settings → Core.</span>
        </div>
      } @else {
        <div class="content">
          <h2 class="section-title">Endpoints</h2>
          @if (daemonService.tailscale().length) {
            <mat-nav-list class="group">
              @for (endpoint of daemonService.tailscale(); track endpoint.endpointTag) {
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
        </div>
      }
    </div>
  `,
  styles: `
    :host { display: contents; }
    .page { overflow-y: auto; }
    /* Centered column; the section title stays aligned with the list. */
    .content {
      width: 100%;
      max-width: 720px;
      margin: 0 auto;
    }
    .group {
      border-radius: 16px;
      background: var(--mat-sys-surface-container);
      padding: 4px 0;
    }
  `,
})
export class Tools {
  readonly singBoxService: SingBoxService = inject(SingBoxService);
  readonly daemonService: DaemonService = inject(DaemonService);
  readonly coreBinaryService: CoreBinaryService = inject(CoreBinaryService);
  readonly multiple: Signal<boolean> = computed(() => this.daemonService.tailscale().length > 1);
  readonly label: (status: TailscaleEndpointStatus) => string = stateLabel;
}
