# Installs floti in this user's own folder, ~/.local/bin, with no admin rights.
#
#   floti_install <version> <file name> <sha256> <release folder URL | ->
#
# With a URL it downloads <URL>/<file name>; with `-` it reads the file from
# standard input, which is how the desktop sends its own build over the same
# ssh login. Either way the file is written beside floti under a temporary
# name, checked against <sha256>, and only then moved into place, so a floti
# that was there keeps working when anything fails. It prints the full path
# of the installed floti as its one line on standard output; a failure is one
# line on standard error starting `floti install: `, and status 1.
#
# The desktop runs `floti setup` itself afterwards, as a step of its own.
#
# The whole script is one function called on its last line, so a script cut
# off halfway runs nothing.

floti_install() {
  version=$1
  file=$2
  sha256=$3
  from=$4
  say() { echo "floti install: $1" >&2; }
  if [ -z "$version" ] || [ -z "$file" ] || [ -z "$sha256" ] || [ -z "$from" ]; then
    say "usage: floti_install <version> <file name> <sha256> <release folder URL | ->"
    return 2
  fi
  if [ -z "$HOME" ]; then
    say "HOME is not set, so there is no folder of yours to put floti in."
    return 1
  fi
  dir="$HOME/.local/bin"
  if ! mkdir -p "$dir"; then
    say "could not make $dir."
    return 1
  fi
  tmp="$dir/.floti-$version.$$"
  rm -f "$tmp"
  if [ "$from" = "-" ]; then
    if ! cat >"$tmp"; then
      rm -f "$tmp"
      say "could not write $tmp."
      return 1
    fi
  elif command -v curl >/dev/null 2>&1; then
    if ! curl -fsSL -o "$tmp" "$from/$file"; then
      rm -f "$tmp"
      say "could not download $from/$file."
      return 1
    fi
  elif command -v wget >/dev/null 2>&1; then
    if ! wget -q -O "$tmp" "$from/$file"; then
      rm -f "$tmp"
      say "could not download $from/$file."
      return 1
    fi
  else
    say "neither curl nor wget is installed, so $file cannot be downloaded."
    return 1
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    got=$(sha256sum "$tmp" | cut -d " " -f 1)
  elif command -v shasum >/dev/null 2>&1; then
    got=$(shasum -a 256 "$tmp" | cut -d " " -f 1)
  elif command -v openssl >/dev/null 2>&1; then
    got=$(openssl dgst -sha256 -r "$tmp" | cut -d " " -f 1)
  else
    rm -f "$tmp"
    say "there is no sha256sum, shasum or openssl to check $file with."
    return 1
  fi
  if [ "$got" != "$sha256" ]; then
    rm -f "$tmp"
    say "$file did not match its SHA-256, so it was not installed."
    return 1
  fi
  if ! chmod 755 "$tmp" || ! mv -f "$tmp" "$dir/floti"; then
    rm -f "$tmp"
    say "could not put floti in $dir."
    return 1
  fi
  echo "$dir/floti"
}

floti_install "$@"
