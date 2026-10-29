import { Component, effect, inject, signal, WritableSignal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { SingBoxService } from '../../core/sing-box.service';
import { ClashApiService, OutboundGroup, OutboundItem } from '../../core/clash-api.service';
import { Dialogs } from '../../shared/dialogs';

/** Expanded state survives navigation, like SFA's group list. */
const expandedGroups: Set<string> = new Set<string>();

@Component({
  selector: 'app-groups',
  imports: [MatButtonModule, MatExpansionModule, MatIconModule, MatProgressSpinnerModule, MatTooltipModule],
  templateUrl: './groups.html',
  styleUrl: './groups.scss',
})
export class Groups {
  private readonly clashApiService: ClashApiService = inject(ClashApiService);
  private readonly dialogs: Dialogs = inject(Dialogs);
  readonly singBoxService: SingBoxService = inject(SingBoxService);

  readonly groups: WritableSignal<OutboundGroup[]> = signal<OutboundGroup[]>([]);
  readonly loading: WritableSignal<boolean> = signal(false);
  readonly testing: WritableSignal<Set<string>> = signal(new Set<string>());
  readonly expanded: Set<string> = expandedGroups;

  constructor() {
    effect(() => {
      // Reload whenever the service (re)starts or the Clash mode changes (GLOBAL visibility).
      if (this.singBoxService.status() === 'started') {
        this.clashApiService.mode();
        void this.reload();
      } else {
        this.groups.set([]);
      }
    });
  }

  async reload(): Promise<void> {
    this.loading.set(true);
    try {
      this.groups.set(await this.clashApiService.groups(this.singBoxService.outboundOrder()));
    } catch (e) {
      await this.dialogs.error('Failed to load groups', e);
    } finally {
      this.loading.set(false);
    }
  }

  async select(group: OutboundGroup, item: OutboundItem): Promise<void> {
    if (!group.selectable || group.selected === item.name) return;
    const previous: string = group.selected;
    this.patchGroup(group.name, { selected: item.name });
    try {
      await this.clashApiService.selectOutbound(group.name, item.name);
    } catch (e) {
      this.patchGroup(group.name, { selected: previous });
      await this.dialogs.error('Failed to select outbound', e);
    }
  }

  async test(group: OutboundGroup, event?: Event): Promise<void> {
    event?.stopPropagation();
    this.testing.update((s) => new Set(s).add(group.name));
    try {
      const delays: Record<string, number> = await this.clashApiService.testGroup(group.name);
      this.groups.update((groups) =>
        groups.map((g) => ({
          ...g,
          items: g.items.map((i) => (i.name in delays ? { ...i, delay: delays[i.name] || 0 } : i)),
        })),
      );
    } catch (e) {
      await this.dialogs.error('URL test failed', e);
    } finally {
      this.testing.update((s) => {
        const next: Set<string> = new Set(s);
        next.delete(group.name);
        return next;
      });
    }
  }

  toggle(name: string, open: boolean): void {
    if (open) expandedGroups.add(name);
    else expandedGroups.delete(name);
  }

  delayClass(delay: number | null): string {
    if (delay === null) return '';
    if (delay === 0) return 'failed';
    if (delay < 300) return 'good';
    if (delay < 800) return 'medium';
    return 'bad';
  }

  private patchGroup(name: string, patch: Partial<OutboundGroup>): void {
    this.groups.update((groups) => groups.map((g) => (g.name === name ? { ...g, ...patch } : g)));
  }
}
