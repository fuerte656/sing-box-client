import {
  Component,
  DestroyRef,
  ElementRef,
  OutputEmitterRef,
  InputSignal,
  afterNextRender,
  effect,
  inject,
  input,
  output,
  untracked,
} from '@angular/core';
import { json } from '@codemirror/lang-json';
import { Diagnostic, linter, lintGutter } from '@codemirror/lint';
import { Compartment, EditorState, Extension } from '@codemirror/state';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorView, keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { basicSetup } from 'codemirror';
import { jsonErrorOffset, parseConfig, toStrictJson } from '../core/json';
import { SettingsService, ThemeMode } from '../core/settings.service';

/** Lints JSON while tolerating comments and trailing commas, which sing-box accepts. */
const jsonWithCommentsLinter: Extension = linter((view): Diagnostic[] => {
  const text: string = view.state.doc.toString();
  if (!text.trim()) return [];
  try {
    JSON.parse(toStrictJson(text));
    return [];
  } catch (e) {
    const offset: number = Math.min(jsonErrorOffset(e, text) ?? 0, text.length);
    return [
      {
        from: offset,
        to: Math.min(offset + 1, text.length),
        severity: 'error',
        message: (e as Error).message,
      },
    ];
  }
});

/**
 * CodeMirror 6 based JSON editor (the desktop equivalent of SFA's sora-editor screen):
 * syntax highlighting, folding, bracket matching, search (Ctrl+F), undo history and live lint.
 */
@Component({
  selector: 'app-json-editor',
  template: '',
  styles: `
    :host {
      display: block;
      overflow: hidden;
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: 12px;
    }
    :host ::ng-deep .cm-editor {
      height: 100%;
      font-size: 13px;
    }
    :host ::ng-deep .cm-scroller {
      font-family: 'Cascadia Mono', Consolas, 'Courier New', monospace;
    }
    :host ::ng-deep .cm-editor.cm-focused {
      outline: none;
    }
  `,
})
export class JsonEditor {
  private readonly host: ElementRef<HTMLElement> = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly settingsService: SettingsService = inject(SettingsService);

  readonly value: InputSignal<string> = input('');
  readonly readOnly: InputSignal<boolean> = input(false);
  readonly valueChange: OutputEmitterRef<string> = output<string>();

  private view?: EditorView;
  private readonly themeCompartment: Compartment = new Compartment();
  private readonly readOnlyCompartment: Compartment = new Compartment();
  private readonly darkQuery: MediaQueryList = matchMedia('(prefers-color-scheme: dark)');

  constructor() {
    afterNextRender(() => {
      this.view = new EditorView({
        parent: this.host.nativeElement,
        state: EditorState.create({
          doc: untracked(this.value),
          extensions: [
            basicSetup,
            keymap.of([indentWithTab]),
            json(),
            lintGutter(),
            jsonWithCommentsLinter,
            this.themeCompartment.of(this.isDark() ? oneDark : []),
            this.readOnlyCompartment.of(this.readOnlyExtensions(untracked(this.readOnly))),
            EditorView.updateListener.of((update) => {
              if (update.docChanged) this.valueChange.emit(update.state.doc.toString());
            }),
          ],
        }),
      });
    });

    // External value changes (initial load, Format) replace the document.
    effect(() => {
      const value: string = this.value();
      const view: EditorView | undefined = this.view;
      if (view && value !== view.state.doc.toString()) {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
      }
    });
    effect(() => {
      const readOnly: boolean = this.readOnly();
      this.view?.dispatch({ effects: this.readOnlyCompartment.reconfigure(this.readOnlyExtensions(readOnly)) });
    });
    effect(() => {
      this.settingsService.values().theme;
      this.applyTheme();
    });

    const onSchemeChange: () => void = () => this.applyTheme();
    this.darkQuery.addEventListener('change', onSchemeChange);
    inject(DestroyRef).onDestroy(() => {
      this.darkQuery.removeEventListener('change', onSchemeChange);
      this.view?.destroy();
    });
  }

  /** Pretty-prints the document with 2-space indentation; throws on invalid JSON. */
  format(): void {
    const view: EditorView | undefined = this.view;
    if (!view) return;
    const formatted: string = JSON.stringify(parseConfig(view.state.doc.toString()), null, 2) + '\n';
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: formatted } });
  }

  focus(): void {
    this.view?.focus();
  }

  private readOnlyExtensions(readOnly: boolean) {
    return [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)];
  }

  private isDark(): boolean {
    const theme: ThemeMode = this.settingsService.values().theme;
    return theme === 'dark' || (theme === 'system' && this.darkQuery.matches);
  }

  private applyTheme(): void {
    this.view?.dispatch({ effects: this.themeCompartment.reconfigure(this.isDark() ? oneDark : []) });
  }
}
