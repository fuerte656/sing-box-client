/** A name/version pair of User-Agent Client Hints (not in lib.dom yet). */
interface BrandVersion {
  brand: string;
  version: string;
}

interface NavigatorUAData {
  getHighEntropyValues(hints: string[]): Promise<{ fullVersionList?: BrandVersion[] }>;
}

/** Browser name and version as the user agent tells them. */
export interface BrowserInfo {
  name: string;
  version: string;
}

/**
 * Name and version of the webview the app runs in: WebView2 on Windows (Microsoft Edge),
 * WKWebView on macOS and WebKitGTK on Linux (Apple Safari).
 */
export async function browserEngine(): Promise<string> {
  const browser: BrowserInfo = browserFromUserAgent(navigator.userAgent);
  // Chromium reduces the version in the user agent to "156.0.0.0"; client hints give the full one,
  // and WebView2 lists itself as a brand there, with the runtime version (EdgeUpdate's `pv`).
  const brands: BrandVersion[] = await fullVersionList();
  const brand: BrandVersion | undefined =
    brands.find((b) => b.brand === `${browser.name} WebView2`) ?? brands.find((b) => b.brand === browser.name);
  if (brand) return `${brand.brand} ${brand.version}`;
  return browser.version ? `${browser.name} ${browser.version}` : browser.name;
}

/** Detects the browser from the user agent; the order matters, as most of them also say Safari or Chrome. */
export function browserFromUserAgent(userAgent: string): BrowserInfo {
  const test: (regexp: RegExp) => boolean = (regexp: RegExp) => regexp.test(userAgent);
  const version: (regexp: RegExp) => string = (regexp: RegExp) => regexp.exec(userAgent)?.[1] ?? '';
  switch (true) {
    case test(/edg/i):
      return { name: 'Microsoft Edge', version: version(/edg\w*\/(\S+)/i) };
    case test(/trident/i):
      return { name: 'Microsoft Internet Explorer', version: version(/rv:([\d.]+)/i) };
    case test(/firefox|fxios/i):
      return { name: 'Mozilla Firefox', version: version(/(?:firefox|fxios)\/(\S+)/i) };
    case test(/opr\//i):
      return { name: 'Opera', version: version(/opr\/(\S+)/i) };
    case test(/ucbrowser/i):
      return { name: 'UC Browser', version: version(/ucbrowser\/(\S+)/i) };
    case test(/samsungbrowser/i):
      return { name: 'Samsung Browser', version: version(/samsungbrowser\/(\S+)/i) };
    case test(/chrome|chromium|crios/i):
      return { name: 'Google Chrome', version: version(/(?:chrome|chromium|crios)\/(\S+)/i) };
    case test(/safari|applewebkit/i):
      // WebKitGTK adds the matching Safari version; WKWebView only has the (frozen) WebKit one.
      return { name: 'Apple Safari', version: version(/version\/(\S+)/i) || version(/applewebkit\/(\S+)/i) };
    default:
      return { name: 'Other', version: '' };
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
