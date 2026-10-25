import { DatePipe } from '@angular/common';
import { Component, DestroyRef, ElementRef, afterNextRender, computed, inject, input, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TailscalePingResponse } from '../../../core/daemon/models';

export interface PingSample extends TailscalePingResponse {
  /** Epoch milliseconds when the response arrived. */
  at: number;
}

export const PING_HISTORY = 60;

const HEIGHT = 180;
const PAD = { top: 12, right: 16, bottom: 22, left: 52 };

/** How a ping travelled, as SFA shows it. */
export function pingPath(r: TailscalePingResponse): string {
  if (r.error) return r.error;
  if (r.isDirect) return r.endpoint ? `Direct · ${r.endpoint}` : 'Direct';
  if (r.peerRelay) return `Peer relay · ${r.peerRelay}`;
  return r.derpRegionCode ? `DERP · ${r.derpRegionCode}` : 'DERP relay';
}

/** Rounds up to a 1/2/5 × 10ⁿ step so axis ticks are clean numbers. */
function niceStep(raw: number): number {
  const power = 10 ** Math.floor(Math.log10(raw));
  const unit = raw / power;
  return (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10) * power;
}

/**
 * Live latency chart for Tailscale ping: one series (latency over the last 60 pings),
 * failures marked on the baseline, crosshair + tooltip on hover, and a table view.
 */
@Component({
  selector: 'app-ping-chart',
  imports: [DatePipe, MatButtonModule, MatIconModule, MatTooltipModule],
  templateUrl: './ping-chart.html',
  styleUrl: './ping-chart.scss',
})
export class PingChart {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly samples = input.required<PingSample[]>();
  readonly active = input(false);

  readonly width = signal(600);
  readonly height = HEIGHT;
  readonly pad = PAD;
  readonly hover = signal<number | null>(null);
  readonly showTable = signal(false);
  readonly path = pingPath;

  readonly stats = computed(() => {
    const all = this.samples();
    const ok = all.filter((s) => !s.error).map((s) => s.latencyMs);
    const last = all.at(-1);
    return {
      last,
      min: ok.length ? Math.min(...ok) : null,
      avg: ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : null,
      max: ok.length ? Math.max(...ok) : null,
      loss: all.length ? ((all.length - ok.length) / all.length) * 100 : null,
    };
  });

  /** y-axis: 0 → a clean maximum just above the highest latency, 4 intervals. */
  readonly yTicks = computed(() => {
    const max = Math.max(10, ...this.samples().filter((s) => !s.error).map((s) => s.latencyMs));
    const step = niceStep(max / 4);
    const top = Math.ceil(max / step) * step;
    const ticks: number[] = [];
    for (let v = 0; v <= top + step / 2; v += step) ticks.push(v);
    return ticks;
  });

  private readonly yMax = computed(() => this.yTicks().at(-1)!);
  private readonly plotWidth = computed(() => this.width() - PAD.left - PAD.right);
  private readonly plotHeight = HEIGHT - PAD.top - PAD.bottom;

  /** Fixed slots for the last PING_HISTORY pings; new data enters on the right. */
  x(index: number): number {
    const offset = PING_HISTORY - this.samples().length;
    return PAD.left + ((offset + index) / (PING_HISTORY - 1)) * this.plotWidth();
  }

  y(ms: number): number {
    return PAD.top + this.plotHeight - (ms / this.yMax()) * this.plotHeight;
  }

  readonly baseline = PAD.top + (HEIGHT - PAD.top - PAD.bottom);

  /** The line breaks at failed pings instead of drawing through them. */
  readonly linePath = computed(() => {
    this.width();
    this.yMax();
    let d = '';
    let pen = false;
    this.samples().forEach((s, i) => {
      if (s.error) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${this.x(i).toFixed(1)},${this.y(s.latencyMs).toFixed(1)}`;
      pen = true;
    });
    return d;
  });

  readonly failures = computed(() => {
    this.width();
    return this.samples()
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => s.error)
      .map(({ i }) => this.x(i));
  });

  readonly lastPoint = computed(() => {
    const samples = this.samples();
    const i = samples.length - 1;
    const s = samples[i];
    if (!s || s.error) return null;
    this.width();
    return { x: this.x(i), y: this.y(s.latencyMs) };
  });

  readonly hovered = computed(() => {
    const i = this.hover();
    const s = i === null ? undefined : this.samples()[i];
    if (!s) return null;
    const x = this.x(i!);
    const y = s.error ? this.baseline : this.y(s.latencyMs);
    // Keep the tooltip inside the chart: flip to the left half past the middle.
    const flip = x > this.width() / 2;
    return { s, x, y, flip };
  });

  readonly summary = computed(() => {
    const st = this.stats();
    if (!this.samples().length) return 'No ping data yet';
    const fmt = (v: number | null) => (v === null ? 'n/a' : `${v.toFixed(1)} ms`);
    return `Latency over the last ${this.samples().length} pings: min ${fmt(st.min)}, average ${fmt(st.avg)}, max ${fmt(st.max)}, loss ${st.loss?.toFixed(0)}%.`;
  });

  constructor() {
    const destroyRef = inject(DestroyRef);
    // Measure the real width so text and strokes are drawn at 1:1, not stretched.
    afterNextRender(() => {
      const observer = new ResizeObserver(([entry]) => this.width.set(Math.max(240, Math.floor(entry.contentRect.width))));
      observer.observe(this.host.nativeElement.querySelector('.plot')!);
      destroyRef.onDestroy(() => observer.disconnect());
    });
  }

  /** Crosshair snaps to the nearest ping slot. */
  onPointerMove(event: PointerEvent): void {
    const samples = this.samples();
    if (!samples.length) return;
    const rect = (event.currentTarget as SVGElement).getBoundingClientRect();
    const px = event.clientX - rect.left;
    const offset = PING_HISTORY - samples.length;
    const slot = Math.round(((px - PAD.left) / this.plotWidth()) * (PING_HISTORY - 1));
    const index = Math.min(samples.length - 1, Math.max(0, slot - offset));
    this.hover.set(index);
  }

  ms(value: number | null): string {
    return value === null ? '–' : value < 10 ? value.toFixed(1) : value.toFixed(0);
  }
}
