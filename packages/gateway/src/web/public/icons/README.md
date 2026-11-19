# Web app icons

The gateway serves these at `/icons/*`. They are all the same image, the Anima mark, resized: the browser tab and
home-screen icon, the PWA icons in `../../manifest.json`, and the icon on web push notifications.

| File                                  | Used by                                                   |
| ------------------------------------- | --------------------------------------------------------- |
| `icon-72x72.png` … `icon-152x152.png` | `manifest.json` (72, 96, 128, 144, 152)                   |
| `icon-180x180.png`                    | the `apple-touch-icon` link set in `../../index.tsx`      |
| `icon-192x192.png`                    | `manifest.json`, and notifications in `service-worker.js` |
| `icon-384x384.png`                    | `manifest.json`                                           |
| `icon-512x512.png`                    | `manifest.json` (`purpose: "any maskable"`)               |

## Regenerating

The source is `assets/anima-mark.png` at the repo root, a 1024px square. Resize it to each size above, for example
with `sips` on macOS (run from the repo root):

```sh
for size in 72 96 128 144 152 180 192 384 512; do
  sips -z $size $size assets/anima-mark.png --out packages/gateway/src/web/public/icons/icon-${size}x${size}.png
done
```

ImageMagick works too (`magick assets/anima-mark.png -resize 192x192 icon-192x192.png`).

The desktop app (`clients/desktop`) uses the same mark. Its full icon set (macOS `.icns`, Windows `.ico`, iOS and
Android sizes) comes from Tauri's generator: copy the mark to `clients/desktop/src-tauri/icons/app-icon.png`, then run
`bunx tauri icon src-tauri/icons/app-icon.png` (or `bun run icons`) in `clients/desktop`.

`new-chat.png` (96px, a white "+" on the same purple) is the icon of the "New chat" shortcut in `manifest.json`.

The mark itself is a white Arial Bold "A" on `#8b5cf6`, rendered with ImageMagick:

```sh
magick -size 1024x1024 xc:'#8b5cf6' -font 'Arial-Bold' -pointsize 600 -fill white \
  -gravity center -annotate +0+6 'A' -strip assets/anima-mark.png
```
