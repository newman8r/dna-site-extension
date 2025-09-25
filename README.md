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
- Optionally select a CSV from the 1-to-1 segment dats, and click "parse csv"
- Click 'get all' (auto) to download all available trees
- Check the 'floating individuals' box to export individuals who did not have a tree, and filter them by cM match values
- Click 'Download all Gedcoms (zip)' which will save all trees into a zip file 
