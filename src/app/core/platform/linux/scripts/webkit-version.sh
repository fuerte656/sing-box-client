# Prints the version of the WebKitGTK library the app's webview has loaded, e.g. "2.48.3".
# The user agent can't tell: its WebKit (605.1.15) and Safari ("Version/60.5") numbers are fixed.
# The library comes from the process's memory maps; its version from the package that owns it.
#   sh webkit-version.sh <app pid>
lib=$(grep -o '/[^ ]*libwebkit[^ ]*gtk[^ ]*\.so[^ ]*' "/proc/$1/maps" 2>/dev/null | head -n 1)
[ -n "$lib" ] || exit 1
real=$(readlink -f "$lib")

if command -v dpkg-query >/dev/null 2>&1; then
  pkg=$(dpkg-query -S "$real" 2>/dev/null | head -n 1 | cut -d ' ' -f 1 | sed 's/:$//')
  [ -n "$pkg" ] && version=$(dpkg-query -W -f='${Version}' "$pkg" 2>/dev/null)
elif command -v rpm >/dev/null 2>&1; then
  version=$(rpm -qf --qf '%{VERSION}' "$real" 2>/dev/null)
elif command -v pacman >/dev/null 2>&1; then
  version=$(pacman -Qqo "$real" 2>/dev/null | head -n 1 | xargs -r pacman -Q 2>/dev/null | cut -d ' ' -f 2)
fi

# Distribution revision (2.48.3-0ubuntu0.22.04.1, 2.48.3-1) and epoch (1:2.48.3) are dropped.
version=${version#*:}
version=${version%%-*}
[ -n "$version" ] || exit 1
echo "$version"
