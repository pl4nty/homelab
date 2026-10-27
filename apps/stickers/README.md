# stickers

One web app for a sticker collection:

- **Browse** (`/`, public, read-only): justified rows that fill the width, as in Immich and Google Photos, in the colours and type of tplant.com.au. Search across title, tags, comment and name. Filter by tags; several tags must all match. Open a sticker to see its size in mm, its details, a PNG download and reverse image search. The search, the tags and the open sticker are kept in the URL, so you can share a link.
- **Submit** (`/submit#<SUBMIT_TOKEN>`): upload a scan of many stickers, with your name and how you got them. The server splits it into stickers, straightens them, and has Claude title and tag them. Submitters see only the progress of their own scans.
- **Admin** (`/admin#<ADMIN_TOKEN>`):
  - **To review:** each sticker from an uploaded scan. Rotate, zoom, level, fix the colour, and edit the title, tags and comment. Possible duplicates are shown alongside. Then publish or reject.
  - **Published:** edit the title, tags, comment, name, rotation or colour, unpublish, or delete. On a browser that has opened the admin link, the public viewer also has an **Edit** button.
  - **Add scans** and a one-off **Import** from PhotoPrism.

```sh
export SUBMIT_TOKEN=$(openssl rand -base64 18) ADMIN_TOKEN=$(openssl rand -base64 18)
export ANTHROPIC_API_KEY=...        # optional: without it, stickers arrive untitled and untagged
export PUBLIC_URL=https://stickers.tplant.com.au   # only used to print the two links at start-up
STICKERS_DATA=./data stickers       # listens on :8000 (PORT, HOST)
```

There are no accounts. The submit link is shared with anyone you want to submit stickers, and the admin link is yours. Each token is in the URL fragment, so it never reaches server logs or `Referer` headers. The page sends it as an `X-Token` header. To revoke a link, change its token and restart. If a token is not set, a random one is generated and printed at start-up.

## Storage

There is no database. Each sticker is one PNG, its folder is its state, and its metadata is XMP inside the file:

```
data/pending/<id>.png     split from a scan, waiting for review
data/approved/<id>.png    public
data/scans/               uploads waiting to be processed (with a .json sidecar), so a restart resumes them
data/cache/               WebP thumbnails at 256/512/1024/2048 px; safe to delete
```

| Field | XMP | Windows Explorer (PNG) |
|---|---|---|
| Title | `dc:title` | Title |
| Tags | `dc:subject` | Tags |
| Who added it | `dc:creator` | Authors |
| How it was acquired | `exif:UserComment` | Comments (not yet confirmed) |
| When it was added | `xmp:CreateDate` | |

Size is not stored. It is the bounding box of the sticker's alpha outline divided by the PNG's DPI, and every write keeps the DPI. At start-up the app reads every PNG into an in-memory index, so you can back up, restore or hand-edit the folder with any tool that keeps XMP, such as exiftool.

## Processing

One worker thread takes scans one at a time, so several people uploading at once cannot run the server out of memory. An A3 scan at 600 dpi takes 1 to 1.5 minutes and about 1.3 GB. Uploads over `MAX_MEGAPIXELS` (default 150) are refused. Each sticker appears for review as soon as it has been tagged. If tagging fails, the sticker is still queued, untitled.

The rotation and colour you set in the editor are applied once, on save, so the PNG is resampled at most once per edit. Quarter turns are lossless.

## Tagging

Claude gets the collection's 60 most used tags and is told that tags are only for what the title doesn't say. So most stickers get no tags, or one or two:
- the finish: `holo`, `glitter`, `clear`;
- an event and year, as a slug, when both are printed: `defcon-2025`;
- an existing tag that clearly applies.

It must never tag colours, shapes, objects, characters, the brand or words from the title. The prompt's own example is a holographic Intel badge, titled "Intel Core i7" and tagged only `holo`. This prompt has not yet been run against the live API.

## Holo colour

Holographic foil scans blue or cyan: the scanner lights it from one fixed angle, so the foil reflects one band of colour instead of a rainbow. Every sticker tagged `holo` is corrected automatically at ingest:
- **Estimate:** the cast is measured from the sticker's bright, non-white pixels. If they are not blue, the sticker is left alone.
- **Correct:** warmth and tint gains are faded in by brightness, so dark ink keeps its colour. The gains are adjusted repeatedly until those pixels average neutral; a single step under-corrected.

The editor has **Warmth** and **Tint** sliders, **Auto** and **Reset**, with a preview computed by the same code as the save.

**Reference test:** PentesterLab's "Read Code Receive Bug" exists in a plain white version and a holo version. Aligning the two (435 matched points) lines up the plain version's white paper with the holo version's foil.

| | Foil colour (CIELAB b*, chroma) | Ink |
|---|---|---|
| Plain version's white paper (the target) | b* −2.8, chroma 2.8 | unchanged reference |
| Holo, as scanned | b* −50.5, chroma 50.5 | |
| Holo, one-step correction (the first version) | b* −23, chroma 23 | |
| Holo, Auto now | b* −7.4, chroma 7.4 | lightness and colour unchanged |

**Limits:**
- Neutral on average is not how foil looks: a scanner can't capture the rainbow, so corrected foil looks silver-grey with streaks.
- A design that really is blue, such as US Cyber Team's Bluey, gets greyed too. Use Reset for those.

## Duplicates

The editor lists stickers that may be the same sticker scanned again. Candidates have the same physical size either way round. ORB keypoints align the two (any rotation), then the outlines must overlap and the colours must agree. On the first 114 stickers:

| Pair | Matched points | Colour difference (ΔE90) | Shown as |
|---|---|---|---|
| CrikeyCon rescan | 691 | 6.7 | Same sticker? |
| Keycult pair | 115 | 6.3 | Same sticker? |
| Rescans of BSides Perth stickers, at other rotations | 421–585 | 9 | Same sticker? |
| Unprompted octopus, other background colour | 246 | 61 | Similar design |
| Trading cards with the same frame | 55–107 | 69–83 | Similar design |
| CrikeyCon 11 next to CrikeyCon | 15 | 89 | not shown |

A holo rescanned at another angle may differ more in colour, and then shows as "Similar design". Stickers with almost no texture (a flat single-colour circle) have too few keypoints to match.

## Reviewing

| Action | How |
|---|---|
| Rotate | Drag around the centre, or twist with two fingers. Shift while dragging snaps to 15°. `←` `→` turn 1°, or 15° with Shift. `Q` `E` turn 90°. Double-click resets. |
| Zoom and move | Scroll or pinch to zoom. Use **Move**, or two fingers, to pan. `+` `−` `0` |
| Level | Choose **Level** and drag along an edge that should be horizontal or vertical. |
| Symmetry | Finds the angle at which the outline best matches its mirror image. |
| Find online | Google Lens, Bing, TinEye or Yandex. They fetch the image by URL, so this only works on a publicly reachable server. |
| Colour | **Warmth** and **Tint** sliders, **Auto**, **Reset** |
| Publish, save | `Enter` |

Reject and delete each need a second click.

## Deploying

```sh
docker build -t stickers .        # runs the tests; the image runs as uid 1000
```

- Mount one persistent volume at `/data`.
- Put `SUBMIT_TOKEN`, `ADMIN_TOKEN` and `ANTHROPIC_API_KEY` in a Secret.
- Serve the app through the Cloudflare tunnel / HTTPRoute that PhotoPrism uses now. The app enforces read-only access itself, so it needs no method allow-list in front of it.

## Moving off PhotoPrism

Open **Admin → Import** and enter the PhotoPrism address. The import copies every photo straight into Published:
- the original PNG, with its alpha and DPI;
- the title;
- the manual labels, lowercased, as tags (PhotoPrism's own `keyword` labels, such as "Blue", are skipped).

Running it again skips stickers already imported: each id is `pp<PhotoPrism UID>`. Against stickers.tplant.com.au, all 114 photos imported, and the sizes matched the old captions. Afterwards, delete `migrate.py`, its `include_router` line in `server.py`, and `importPanel` and the Import tab in `static/app.js`.

Cloudflare answers 403 to Python's default `User-Agent`, so the import sends its own.

## Scanning

- Turn off auto-enhance, auto-levels and auto-contrast.
- Use a matte black mat. Black stickers are found by their cut edge.
- Leave about 3 mm between stickers and keep them off the scan edge. Stickers that touch merge into one, and stickers that touch the scan edge are skipped.
- Scan at 600 dpi. In a side-by-side test, 1200 dpi gave no more legible detail.

## Accuracy and cost of tagging

Measured on 32 real stickers with Sonnet 5.5, effort `low`:
- **Orientation:** Claude picks one of four quarter turns, then a 10° fine pass for die-cuts with a clear up direction. About 1 in 10 still need a manual turn, mostly text-free logos.
- **Cost:** about $0.013 per sticker, or $3.75 for 300.

## Development

```sh
uv run --extra dev pytest                                   # 38 tests: splitter, tagger, store, API
pip install -e '.[dev]' playwright && playwright install chromium
pytest tests/test_ui.py                                     # 10 browser tests, desktop and phone
```

- `test_server.py` covers:
  - XMP round trip, including a check with exiftool if it is installed;
  - the permission matrix;
  - the scan queue with a fake Claude, including one failure and a resume after a restart;
  - uploading the same scan twice flags each rescanned sticker as a duplicate;
  - the colour correction fixes blue foil but leaves green designs and dark ink alone;
  - the PhotoPrism import against a mock that rejects urllib's User-Agent the way Cloudflare does.
- `test_ui.py` runs Chromium at 1440×900 and at 390×844 (touch). It checks:
  - that rows fill the width;
  - search, tag AND-filtering and URL state;
  - the viewer and deep links;
  - the whole flow: a submitter uploads a scan; the admin opens a sticker by link, sees its duplicate, rotates it, changes the colour, publishes it and rejects the next one; then the admin edits and deletes it from the public viewer's Edit button;
  - pinch, twist, drag-rotate and level gestures;
  - that there is no sideways scrolling and no console errors.

## Licence

MIT
