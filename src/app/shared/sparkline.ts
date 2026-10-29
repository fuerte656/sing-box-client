import { Component, computed, input, Signal, InputSignal } from '@angular/core';

/** Minimal SVG area chart for the traffic cards. */
@Component({
  selector: 'app-sparkline',
  template: `
    <svg viewBox="0 0 100 32" preserveAspectRatio="none">
      <path class="area" [attr.d]="area()" />
      <path class="line" [attr.d]="line()" />
    </svg>
  `,
  styles: `
    :host { display: block; height: 40px; }
    svg { width: 100%; height: 100%; display: block; }
    .line { fill: none; stroke: var(--mat-sys-primary); stroke-width: 1.5; vector-effect: non-scaling-stroke; }
    .area { fill: color-mix(in srgb, var(--mat-sys-primary) 15%, transparent); stroke: none; }
  `,
})
export class Sparkline {
  readonly values: InputSignal<number[]> = input.required<number[]>();
  readonly capacity: InputSignal<number> = input(60);

  private readonly points: Signal<(readonly [number, number])[]> = computed(() => {
    const values: number[] = this.values();
    const max: number = Math.max(1, ...values);
    const step: number = 100 / (this.capacity() - 1);
    const offset: number = this.capacity() - values.length;
    return values.map((v, i) => [(offset + i) * step, 32 - (v / max) * 30] as const);
  });

  readonly line: Signal<string> = computed(() =>
    this.points()
      .map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`)
      .join(' '),
  );

  readonly area: Signal<string> = computed(() => {
    const points: (readonly [number, number])[] = this.points();
    if (!points.length) return '';
    return `${this.line()} L${points[points.length - 1][0].toFixed(2)},32 L${points[0][0].toFixed(2)},32 Z`;
  });
}
