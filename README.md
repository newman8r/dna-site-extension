# GedMapper GEDmatch Import (Side Panel)

This version uses Chrome’s Side Panel for a persistent UI while you browse and open GED trees. It avoids popup auto-close behavior during file selection.

## Load Unpacked

1. Chrome/Chromium → `chrome://extensions/`
2. Enable Developer mode
3. Load unpacked → select `gedmatch-extension`

## Open Side Panel

- Click the extension icon (or use the Side Panel button) to open the panel. The default panel path is `sidepanel.html`.

## Use

- Select the GEDmatch CSV in the side panel
- Click "Parse CSV" to load rows with GED links
- Use "Open" or "Open Next" to navigate to tree pages
- Use "Export JSON" to download the session bundle

## Notes

- Popups cannot be forced to stay open during file chooser; Side Panel is the recommended Chrome pattern.
