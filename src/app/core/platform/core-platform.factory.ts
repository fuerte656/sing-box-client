import { Provider } from '@angular/core';
import { CorePlatform } from './core-platform';
import { LinuxCorePlatform } from './linux/linux-core-platform';
import { MacosCorePlatform } from './macos/macos-core-platform';
import { WindowsCorePlatform } from './windows/windows-core-platform';

/** Picks the {@link CorePlatform} implementation for a Neutralino NL_OS value. */
export function createCorePlatform(nlOs: string): CorePlatform {
  switch (nlOs) {
    case 'Windows':
      return new WindowsCorePlatform();
    case 'Linux':
      return new LinuxCorePlatform();
    case 'Darwin':
      return new MacosCorePlatform();
    default:
      throw new Error(`Unknown operating system: ${nlOs}`);
  }
}

export function provideCorePlatform(): Provider {
  return {
    provide: CorePlatform,
    // Outside Neutralino (plain `ng serve` in a browser) NL_OS is undefined; any implementation
    // lets the UI render, since native calls are skipped through NativeService.available.
    useFactory: () => createCorePlatform(typeof NL_OS === 'undefined' ? 'Windows' : NL_OS),
  };
}
