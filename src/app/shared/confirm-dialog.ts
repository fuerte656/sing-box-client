import { Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';

export interface ConfirmDialogData {
  title: string;
  message: string;
  confirm?: string;
  cancel?: string | null;
  destructive?: boolean;
}

@Component({
  selector: 'app-confirm-dialog',
  imports: [MatDialogModule, MatButtonModule],
  template: `
    <h2 mat-dialog-title>{{ data.title }}</h2>
    <mat-dialog-content><p class="message">{{ data.message }}</p></mat-dialog-content>
    <mat-dialog-actions align="end">
      @if (data.cancel !== null) {
        <button mat-button [mat-dialog-close]="false">{{ data.cancel ?? 'Cancel' }}</button>
      }
      <button mat-flat-button [class.destructive]="data.destructive" [mat-dialog-close]="true">
        {{ data.confirm ?? 'OK' }}
      </button>
    </mat-dialog-actions>
  `,
  styles: `
    .message { white-space: pre-wrap; word-break: break-word; margin: 0; }
    .destructive { --mat-button-filled-container-color: var(--mat-sys-error); --mat-button-filled-label-text-color: var(--mat-sys-on-error); }
  `,
})
export class ConfirmDialog {
  readonly data = inject<ConfirmDialogData>(MAT_DIALOG_DATA);
}
