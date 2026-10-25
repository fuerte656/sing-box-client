import { bootstrapApplication } from '@angular/platform-browser';
import * as Neutralino from '@neutralinojs/lib';
import { appConfig } from './app/app.config';
import { App } from './app/app';

if (typeof NL_PORT !== 'undefined') {
  Neutralino.init();
  // The standard global of Neutralino apps; handy from DevTools.
  (window as unknown as { Neutralino: typeof Neutralino }).Neutralino = Neutralino;
}

bootstrapApplication(App, appConfig).catch((err) => console.error(err));
