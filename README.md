# Comic Translator Extension

A minimal Manifest V3 extension shell. It has no build step and no dependencies.

## Load it

1. Open `chrome://extensions`.
2. Turn on Developer mode.
3. Choose Load unpacked and select this directory.
4. Click the extension icon. The popup shows a Hello World message.

## Files

- `manifest.json` declares the extension, its name, and the popup.
- `popup.html` is the panel that opens from the toolbar icon.
- `popup.js` writes the Hello World message into that panel.
