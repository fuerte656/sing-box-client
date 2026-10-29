import { Service, WritableSignal, inject, signal } from '@angular/core';
import { computer, Display, window as nlWindow, WindowSizeOptions, WindowPosOptions } from '@neutralinojs/lib';
import { SettingsService, WindowBounds } from './settings.service';

/** Windows parks minimized/hidden windows near ±32000; such coordinates must never be restored. */
const PARKED_COORDINATE: number = 30000;

/**
 * Main window visibility and geometry. Neutralino's own useSavedState is disabled because it
 * records the parked off-screen position when the app quits from the tray, which then hides the
 * window on every launch; bounds are kept in settings.json instead, and only while on screen.
 */
@Service()
export class WindowService {
  private readonly settingsService: SettingsService = inject(SettingsService);

  readonly visible: WritableSignal<boolean> = signal(false);

  /** First show at start-up: restores the saved bounds when they are still on a display. */
  async restore(): Promise<void> {
    const bounds: WindowBounds | null = this.settingsService.get('windowBounds');
    if (bounds && (await this.onScreen(bounds.x, bounds.y, bounds.width, bounds.height))) {
      await nlWindow.setSize({ width: bounds.width, height: bounds.height });
      await nlWindow.move(bounds.x, bounds.y);
    } else {
      await nlWindow.center();
    }
    await this.show();
    if (bounds?.maximized) await nlWindow.maximize();
  }

  async show(): Promise<void> {
    await nlWindow.show();
    if (await nlWindow.isMinimized()) await nlWindow.unminimize();
    await this.ensureOnScreen();
    await nlWindow.focus();
    this.visible.set(true);
  }

  async hide(): Promise<void> {
    await this.saveBounds();
    await nlWindow.hide();
    this.visible.set(false);
  }

  toggle(): Promise<void> {
    return this.visible() ? this.hide() : this.show();
  }

  /** Records the current geometry, but only while the window is really on screen. */
  async saveBounds(): Promise<void> {
    if (!this.visible() || (await nlWindow.isMinimized())) return;
    const maximized: boolean = await nlWindow.isMaximized();
    const previous: WindowBounds | null = this.settingsService.get('windowBounds');
    let bounds: WindowBounds;
    if (maximized && previous) {
      // Keep the restored size so un-maximizing after a restart goes back to it.
      bounds = { ...previous, maximized: true };
    } else {
      const { x = 0, y = 0 }: WindowPosOptions = await nlWindow.getPosition();
      const { width = 0, height = 0 }: WindowSizeOptions = await nlWindow.getSize();
      if (!(await this.onScreen(x, y, width, height))) return;
      bounds = { x, y, width, height, maximized };
    }
    await this.settingsService.set('windowBounds', bounds);
  }

  private async ensureOnScreen(): Promise<void> {
    const { x = 0, y = 0 }: WindowPosOptions = await nlWindow.getPosition();
    const { width = 0, height = 0 }: WindowSizeOptions = await nlWindow.getSize();
    if (!(await this.onScreen(x, y, width, height))) {
      await nlWindow.center();
    }
  }

  /**
   * Neutralino reports display sizes but not their arrangement, so the check allows the window
   * anywhere within the combined size of all displays around the origin, and requires a visible
   * strip of the window to fall inside that area.
   */
  private async onScreen(x: number, y: number, width: number, height: number): Promise<boolean> {
    if (Math.abs(x) >= PARKED_COORDINATE || Math.abs(y) >= PARKED_COORDINATE || width < 100 || height < 100) {
      return false;
    }
    const displays: Display[] = await computer.getDisplays().catch((): Display[] => []);
    const totalWidth: number = displays.reduce((sum, d) => sum + d.resolution.width, 0) || 1920;
    const totalHeight: number = displays.reduce((sum, d) => sum + d.resolution.height, 0) || 1080;
    const margin: number = 80;
    return x + width > -totalWidth + margin && x < totalWidth - margin && y > -totalHeight && y < totalHeight - margin;
  }
}
