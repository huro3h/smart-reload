#!/bin/sh
# icon.svg から ON/OFF 各4サイズの PNG を書き出す。PNG は手で作らずこれで再生成する。
# OFF 状態はグレー版。色違いのSVGはここで一時生成するので、ソースは icon.svg 1枚だけ。
set -eu
cd "$(dirname "$0")"
off=$(mktemp -t smart-reload-icon-off.XXXXXX)
trap 'rm -f "$off"' EXIT
sed 's/#1A73E8/#9AA0A6/g' icon.svg > "$off"
for s in 16 32 48 128; do
  rsvg-convert -w "$s" -h "$s" icon.svg -o "icon$s.png"
  rsvg-convert -w "$s" -h "$s" "$off" -o "icon-off$s.png"
done
echo "wrote icon{16,32,48,128}.png / icon-off{16,32,48,128}.png"
