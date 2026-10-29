# Prints the system WebKit framework version that WKWebView uses, and the Safari release it
# shipped with, e.g. "20621.1.15.11.10 (Safari 18.5)". The user agent can't tell: WKWebView's
# says only "AppleWebKit/605.1.15", a number frozen for years.
#   sh webkit-version.sh
webkit=$(defaults read /System/Library/Frameworks/WebKit.framework/Resources/Info CFBundleVersion 2>/dev/null)
[ -n "$webkit" ] || exit 1
safari=$(defaults read /Applications/Safari.app/Contents/Info CFBundleShortVersionString 2>/dev/null)
if [ -n "$safari" ]; then echo "$webkit (Safari $safari)"; else echo "$webkit"; fi
