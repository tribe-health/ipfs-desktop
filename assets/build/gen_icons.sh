#!/usr/bin/env bash
# Regenerates the Promethity icon set at the paths electron-builder and
# src/tray.js already read (desktop-display-branding 1.1). Sources are the
# Promethity "p" icon masters in the brand repo:
#   branding/logo/p-icon/svg/promethity-p-icon-dark.svg   (rounded tile)
#   branding/logo/wordmark/promethity-wordmark-on-dark-transparent.svg
# The "p" letter and flame paths are copied below so the monochrome tray
# glyphs can be drawn without the tile. Colour values are the Promethity v1
# tokens (ground #0C0B0A, text #F5F2EE, text-muted #A09890).
#
# Needs: rsvg-convert, magick (ImageMagick 7), and on macOS sips and iconutil.
# Run from anywhere:  BRAND_DIR=/path/to/promethity/branding assets/build/gen_icons.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ASSETS="$(cd "$HERE/.." && pwd)"
BRAND_DIR="${BRAND_DIR:-$HOME/Projects/promethity/branding}"
TILE="$BRAND_DIR/logo/p-icon/svg/promethity-p-icon-dark.svg"
WORDMARK="$BRAND_DIR/logo/wordmark/promethity-wordmark-on-dark-transparent.svg"
for f in "$TILE" "$WORDMARK"; do [ -f "$f" ] || { echo "missing brand source: $f" >&2; exit 1; }; done

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

LETTER='M422 12Q356 12 309.5 -11.5Q263 -35 234 -73.5Q205 -112 191 -158Q177 -204 177 -248Q177 -303 190.5 -350Q204 -397 233 -432.5Q262 -468 308.5 -488Q355 -508 422 -508Q497 -508 557 -475Q617 -442 652.5 -383.5Q688 -325 688 -248Q688 -169 652 -110.5Q616 -52 556 -20Q496 12 422 12Z M380 -89Q433 -89 472.5 -109Q512 -129 533.5 -164.5Q555 -200 555 -248Q555 -320 509.5 -364Q464 -408 380 -408Q327 -408 283.5 -389Q240 -370 215 -334.5Q190 -299 190 -248Q190 -200 213 -164.5Q236 -129 279 -109Q322 -89 380 -89Z M60 -497H184L190 -365V200H60Z'
FLAME='M 385.94 -370.50 C 392.23 -318.58 455.17 -271.38 455.17 -210.02 C 455.17 -167.54 420.55 -134.50 376.50 -134.50 C 332.45 -134.50 297.83 -167.54 297.83 -214.74 C 297.83 -252.50 319.86 -271.38 335.59 -306.78 C 345.03 -283.18 360.77 -276.10 368.63 -290.26 C 382.79 -313.86 376.50 -346.90 385.94 -370.50 Z'
# Glyph box in path units: x 60..688, y -508..200 (height 708, centre 374,-154).

# glyph W H GLYPH_HEIGHT COLOUR WITH_FLAME OPACITY OUT.png
# The mark centred in a W x H canvas. With_flame=0 draws the letter alone: the
# stopped state ("fire out"), dimmed by OPACITY.
glyph () {
  local w=$1 h=$2 gh=$3 colour=$4 flame=$5 opacity=$6 out=$7
  local s tx ty
  s=$(awk -v gh="$gh" 'BEGIN { printf "%.6f", gh / 708 }')
  tx=$(awk -v w="$w" -v s="$s" 'BEGIN { printf "%.4f", w / 2 - s * 374 }')
  ty=$(awk -v h="$h" -v s="$s" 'BEGIN { printf "%.4f", h / 2 + s * 154 }')
  {
    printf '<svg xmlns="http://www.w3.org/2000/svg" width="%s" height="%s" viewBox="0 0 %s %s">' "$w" "$h" "$w" "$h"
    printf '<g opacity="%s" transform="translate(%s %s) scale(%s)" fill="%s"><path d="%s"/>' "$opacity" "$tx" "$ty" "$s" "$colour" "$LETTER"
    [ "$flame" = 1 ] && printf '<path d="%s"/>' "$FLAME"
    printf '</g></svg>'
  } > "$WORK/glyph.svg"
  rsvg-convert "$WORK/glyph.svg" -o "$out"
}

# --- tray: macOS template images (alpha only; the system tints them) ---
TRAY="$ASSETS/icons/tray"
for scale in 1 2 3; do
  suffix=""; [ "$scale" -gt 1 ] && suffix="@${scale}x"
  w=$((18 * scale)); h=$((22 * scale)); gh=$((18 * scale))
  glyph "$w" "$h" "$gh" '#000000' 1 1 "$TRAY/macos/on-22Template$suffix.png"
  glyph "$w" "$h" "$gh" '#000000' 0 0.5 "$TRAY/macos/off-22Template$suffix.png"
done

# --- tray: monochrome 32px for other platforms (-dark = light glyph on a dark panel) ---
glyph 32 32 28 '#FFFFFF' 1 1 "$TRAY/others/on-32-dark.png"
glyph 32 32 28 '#FFFFFF' 0 0.5 "$TRAY/others/off-32-dark.png"
glyph 32 32 28 '#000000' 1 1 "$TRAY/others/on-32-light.png"
glyph 32 32 28 '#000000' 0 0.5 "$TRAY/others/off-32-light.png"

# --- tray: colour icon for other platforms. on = the brand tile with its flame;
# off = the tile with the flame out and the letter in text-muted, dimmed.
rsvg-convert -w 1024 -h 1024 "$TILE" -o "$TRAY/others/on-large.png"
sed -e 's/fill="#F5F2EE"/fill="#A09890"/' -e 's|<path fill="#E96A12"[^>]*/>||' "$TILE" > "$WORK/tile-off.svg"
rsvg-convert -w 1024 -h 1024 "$WORK/tile-off.svg" -o "$WORK/tile-off.png"
magick "$WORK/tile-off.png" -channel A -evaluate multiply 0.6 +channel "$TRAY/others/off-large.png"

# --- app icon: Linux (png), Windows (ico), macOS (icns) ---
rsvg-convert -w 512 -h 512 "$TILE" -o "$HERE/icon.png"
for size in 256 128 64 48 32 16; do rsvg-convert -w "$size" -h "$size" "$TILE" -o "$WORK/ico-$size.png"; done
magick "$WORK"/ico-256.png "$WORK"/ico-128.png "$WORK"/ico-64.png "$WORK"/ico-48.png "$WORK"/ico-32.png "$WORK"/ico-16.png "$HERE/icon.ico"

# macOS app icons sit on a 1024 canvas with the tile at 824px; the margin is what
# keeps the Dock icon the same size as its neighbours.
ICONSET="$WORK/icon.iconset"
mkdir -p "$ICONSET"
rsvg-convert -w 824 -h 824 "$TILE" -o "$WORK/tile-824.png"
magick -size 1024x1024 xc:none "$WORK/tile-824.png" -gravity center -composite "$WORK/icon-1024.png"
for spec in 16:icon_16x16 32:icon_16x16@2x 32:icon_32x32 64:icon_32x32@2x 128:icon_128x128 256:icon_128x128@2x 256:icon_256x256 512:icon_256x256@2x 512:icon_512x512 1024:icon_512x512@2x; do
  size=${spec%%:*}; name=${spec#*:}
  magick "$WORK/icon-1024.png" -filter Lanczos -resize "${size}x${size}" "$ICONSET/$name.png"
done
iconutil -c icns "$ICONSET" -o "$HERE/icon.icns"

# --- installer art: flat ground, no photograph, no blue cast ---
# DMG background (660x400 at 1x and 2x). The chevron sits between the app and
# Applications drop targets (electron-builder.yml dmg.contents) and is the one
# ember mark on the page.
dmg_bg () {
  local scale=$1 out=$2
  cat > "$WORK/dmg.svg" <<SVG
<svg xmlns="http://www.w3.org/2000/svg" width="$((660 * scale))" height="$((400 * scale))" viewBox="0 0 660 400">
  <rect width="660" height="400" fill="#0C0B0A"/>
  <path d="M322 154 L338 172 L322 190" fill="none" stroke="#E96A12" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
SVG
  rsvg-convert "$WORK/dmg.svg" -o "$out"
}
dmg_bg 1 "$HERE/background.png"
dmg_bg 2 "$HERE/background@2x.png"

# NSIS sidebar (164x314 shown, drawn at 328x628): the tile above the wordmark.
rsvg-convert -w 128 -h 128 "$TILE" -o "$WORK/side-tile.png"
rsvg-convert -w 220 "$WORDMARK" -o "$WORK/side-word.png"
magick -size 328x628 xc:'#0C0B0A' \
  "$WORK/side-tile.png" -gravity north -geometry +0+190 -composite \
  "$WORK/side-word.png" -gravity north -geometry +0+345 -composite \
  -type TrueColor -alpha off "bmp3:$HERE/installerSidebar.bmp"

echo "Promethity icons regenerated under $ASSETS"
