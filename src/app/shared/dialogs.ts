import { Injectable, inject } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { window as nlWindow } from '@neutralinojs/lib';
import { firstValueFrom } from 'rxjs';
import { NativeService } from '../core/native.service';
import { CorePlatform } from '../core/platform/core-platform';
import { WindowService } from '../core/window.service';
import { ConfirmDialog, ConfirmDialogData } from './confirm-dialog';
import { errorMessage } from './errors';

export interface NotifyOptions {
  /** Also show a desktop notification (near the tray) while the window is minimized or hidden. Default true. */
  notify?: boolean;
}

@Injectable({ providedIn: 'root' })
export class Dialogs {
  private readonly dialog = inject(MatDialog);
  private readonly snackBar = inject(MatSnackBar);
  private readonly native = inject(NativeService);
  private readonly platform = inject(CorePlatform);
  private readonly window = inject(WindowService);

  async confirm(data: ConfirmDialogData): Promise<boolean> {
    const ref = this.dialog.open(ConfirmDialog, { data, width: '440px', maxWidth: 'calc(100vw - 32px)' });
    return (await firstValueFrom(ref.afterClosed())) === true;
  }

  /** Error dialog; while the app is in the background the error also appears as a notification. */
  async error(title: string, error: unknown, options: NotifyOptions = {}): Promise<boolean> {
    const message = errorMessage(error);
    if (options.notify !== false) void this.notifyInBackground(title, message);
    return this.confirm({ title, message, cancel: null });
  }

  toast(message: string, options: NotifyOptions = {}): void {
    if (options.notify !== false) void this.notifyInBackground('sing-box client', message);
    this.snackBar.open(message, undefined, { duration: 2500 });
  }

  /** Toast with one action button; resolves true when the action is clicked. */
  async toastAction(message: string, action: string, duration = 6000, options: NotifyOptions = {}): Promise<boolean> {
    if (options.notify !== false) void this.notifyInBackground('sing-box client', message);
    const ref = this.snackBar.open(message, action, { duration });
    const result = await firstValueFrom(ref.afterDismissed());
    return result.dismissedByAction;
  }

  /** Desktop notification when the window is hidden in the tray or minimized. */
  async notifyInBackground(title: string, message: string): Promise<void> {
    if (!this.native.available) return;
    const minimized = await nlWindow.isMinimized().catch(() => false);
    if (this.window.visible() && !minimized) return;
    await this.platform.showNotification(title, message).catch(() => undefined);
  }
}
