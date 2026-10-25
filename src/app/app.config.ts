import { ApplicationConfig, inject, provideAppInitializer, provideBrowserGlobalErrorListeners } from '@angular/core';
import { MAT_ICON_DEFAULT_OPTIONS } from '@angular/material/icon';
import { provideRouter, withComponentInputBinding, withHashLocation } from '@angular/router';
import { routes } from './app.routes';
import { AppLifecycleService } from './core/app-lifecycle.service';
import { provideCorePlatform } from './core/platform/core-platform.factory';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // Neutralino's static server cannot resolve deep links, so routes live in the hash.
    provideRouter(routes, withHashLocation(), withComponentInputBinding()),
    provideCorePlatform(),
    { provide: MAT_ICON_DEFAULT_OPTIONS, useValue: { fontSet: 'material-symbols-outlined' } },
    provideAppInitializer(() => inject(AppLifecycleService).initialize()),
  ],
};
