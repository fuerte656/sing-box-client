import { Injectable, inject } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { firstValueFrom } from 'rxjs';
import { ConfirmDialog, ConfirmDialogData } from './confirm-dialog';

@Injectable({ providedIn: 'root' })
export class Dialogs {
  private readonly dialog = inject(MatDialog);
  private readonly snackBar = inject(MatSnackBar);

  async confirm(data: ConfirmDialogData): Promise<boolean> {
    const ref = this.dialog.open(ConfirmDialog, { data, width: '440px' });
    return (await firstValueFrom(ref.afterClosed())) === true;
  }

  error(title: string, error: unknown): Promise<boolean> {
    const message = error instanceof Error ? error.message : String(error);
    return this.confirm({ title, message, cancel: null });
  }

  toast(message: string): void {
    this.snackBar.open(message, undefined, { duration: 2500 });
  }
}
