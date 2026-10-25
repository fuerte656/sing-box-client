import { Component, computed, input } from '@angular/core';

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
  readonly values = input.required<number[]>();
  readonly capacity = input(60);

  private readonly points = computed(() => {
    const values = this.values();
    const max = Math.max(1, ...values);
    const step = 100 / (this.capacity() - 1);
    const offset = this.capacity() - values.length;
    return values.map((v, i) => [(offset + i) * step, 32 - (v / max) * 30] as const);
  });

  readonly line = computed(() =>
    this.points()
      .map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`)
      .join(' '),
  );

  readonly area = computed(() => {
    const points = this.points();
    if (!points.length) return '';
    return `${this.line()} L${points[points.length - 1][0].toFixed(2)},32 L${points[0][0].toFixed(2)},32 Z`;
  });
}
