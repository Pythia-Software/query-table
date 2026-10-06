# query-table icon

The final mark is the Solid Predicate Chip in the Blueprint palette. Its
light-blue rounded tile is part of every asset, not a surrounding page style.
Only the corners outside the rounded tile are transparent.

## Files

- `query-table-icon.svg`: vector master, with a 128 × 128 view box.
- `query-table-icon-{16,24,32,48,64,128,256,512,1024}.png`: raster exports at
  the indicated square pixel size.
- `favicon.ico`: embedded 16, 32, and 48 pixel icons.

Use the SVG for documentation and scalable UI. Use the 512 or 1024 pixel PNG
for repository avatars and other upload-based destinations. Use `favicon.ico`
or the SVG for browser icons. All exports use the same mark and palette.

## Blueprint palette

| Element | Color |
| --- | --- |
| Light-blue tile | `#e5ecfa` |
| Predicate chip | `#325bd6` |
| Selected value | `#aacaf5` |
| Result rows | `#23344e` |
| Chip symbols and value outline | `#fbfcff` |

Keep the background and internal spacing intact. Do not recolor the mark
automatically in dark mode; the light-blue tile maintains its appearance.
