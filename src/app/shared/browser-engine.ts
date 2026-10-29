import type { CorePlatform } from '../core/platform/core-platform';

/** A name/version pair of User-Agent Client Hints (not in lib.dom yet). */
interface BrandVersion {
  brand: string;
  version: string;
}

interface NavigatorUAData {
  getHighEntropyValues(hints: string[]): Promise<{ fullVersionList?: BrandVersion[] }>;
}

/** Engine name and version as the user agent tells them; version is empty when it isn't reliable. */
export interface BrowserInfo {
  name: string;
  version: string;
}

/**
 * Name and version of the webview engine the app runs in, from the most truthful source available:
 * - Windows: WebView2's client hints, e.g. "Microsoft Edge WebView2 156.0.4314.50 (Chromium 156.0.8078.49)",
 *   the same runtime version EdgeUpdate records as `pv`;
 * - Linux / macOS: the platform asks the system (WebKitGTK package, WebKit framework), as WebKit's
 *   user agent carries frozen numbers;
 * - otherwise the user agent.
 */
export async function browserEngine(platform: CorePlatform): Promise<string> {
  const native: string | null = await platform.webviewEngine().catch((): null => null);
  if (native) return native;

  const brands: BrandVersion[] = await fullVersionList();
  const chromium: BrandVersion | undefined = brands.find((b) => b.brand === 'Chromium');
  const brand: BrandVersion | undefined =
    brands.find((b) => b.brand === 'Microsoft Edge WebView2') ?? brands.find((b) => b.brand === 'Microsoft Edge');
  if (brand && chromium) return `${brand.brand} ${brand.version} (Chromium ${chromium.version})`;
  if (chromium) return `Chromium ${chromium.version}`;

  const browser: BrowserInfo = browserFromUserAgent(navigator.userAgent);
  return browser.version ? `${browser.name} ${browser.version}` : browser.name;
}

/** Detects the engine from the user agent; the order matters, as most of them also say Safari or Chrome. */
export function browserFromUserAgent(userAgent: string): BrowserInfo {
  const test: (regexp: RegExp) => boolean = (regexp: RegExp) => regexp.test(userAgent);
  const version: (regexp: RegExp) => string = (regexp: RegExp) => regexp.exec(userAgent)?.[1] ?? '';
  switch (true) {
    // Chromium-based user agents report only the major version (156.0.0.0) since the UA reduction.
    case test(/edg/i):
      return { name: 'Microsoft Edge', version: version(/edg\w*\/(\d+)/i) };
    case test(/opr\//i):
      return { name: 'Opera', version: version(/opr\/(\d+)/i) };
    case test(/chrome|chromium|crios/i):
      return { name: 'Chromium', version: version(/(?:chrome|chromium|crios)\/(\d+)/i) };
    case test(/firefox|fxios/i):
      return { name: 'Gecko (Firefox)', version: version(/(?:firefox|fxios)\/(\S+)/i) };
    // WebKit's numbers are frozen (AppleWebKit/605.1.15) and WebKitGTK's "Version/60.5" is no Safari
    // release, so neither says which engine this is.
    case test(/applewebkit|safari/i):
      return { name: 'WebKit', version: '' };
    default:
      return { name: 'Unknown engine', version: '' };
  }
}

/** Full brand versions from client hints, empty where the browser has none (WebKit, Gecko). */
async function fullVersionList(): Promise<BrandVersion[]> {
  const uaData: NavigatorUAData | undefined = (navigator as Navigator & { userAgentData?: NavigatorUAData })
    .userAgentData;
  if (!uaData) return [];
  return uaData
    .getHighEntropyValues(['fullVersionList'])
    .then((values) => values.fullVersionList ?? [])
    .catch((): BrandVersion[] => []);
}
