# canberra-3d

Explore Canberra as a 3D miniature in the browser. Built with [three.js](https://threejs.org/) from open data, streamed in as you move.

- Buildings, with measured heights where a source has them and pitched roofs on houses. Brickwork, windows, roof tiles and solar panels are drawn by the shader; they are texture, not data.
- Every tree the ACT's 2020 LiDAR survey picked out, at its surveyed height and crown width, with species from the tree register.
- Terrain, lakes, roads, bridges, car parks with parked cars, street lights. The moving cars are set dressing, not data.
- Hand-built landmarks: Black Mountain Tower, the Parliament House flag mast, the National Carillon, the Captain Cook Memorial Jet, the Australian-American Memorial.
- Live light rail.
- Street level: drive a car in chase or first-person view, or fly a free camera. The car rides the ground, the water and bridge decks, and stops at buildings.
- Time of day from dawn balloons to lit windows at night, and an autumn switch for the deciduous streets.

The view is in the URL (`#lat,lon,distance,bearing,tilt,hour`), so a link reopens the same shot.

## Data

| What | Source | Licence |
| --- | --- | --- |
| Building footprints and use, tree crowns (2020 LiDAR), tree register, street lights, car parks, sports fields, bus stops | [ACT Government open data](https://actmapi-actgov.opendata.arcgis.com/), ArcGIS feature services | CC BY 4.0 |
| Building outlines and heights, roads, rail, bridges, land use, water | [Overture Maps](https://overturemaps.org/) PMTiles: OpenStreetMap, Microsoft ML Buildings | ODbL |
| Roof and ground photography | [ACT aerial imagery](https://actmapi-actgov.opendata.arcgis.com/), map tiles, loaded by the browser | CC BY, © Australian Capital Territory and Aerometrex |
| Terrain | [Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) on AWS | per source |
| Light rail timetable and arrival predictions | Canberra Metro GTFS and GTFS-realtime | CC BY 4.0 |
| Bus positions (optional) | Transport Canberra GTFS-realtime | CC BY 4.0, needs a key |

How the sources combine:

- **Buildings.** OpenStreetMap outlines win where they exist. Elsewhere an ACT footprint replaces the machine-traced one and keeps its height estimate. A building no source measured takes its storey count, then the median of measured neighbours, then a guess from its use and area.
- **Trees.** The LiDAR survey gives position, height and canopy area. A crown takes the genus of the nearest registered tree within its radius; registered trees with no crown are drawn young.
- **Surfaces.** Roofs take the aerial photograph at their plan position, and the ground blends it in under the drawn roads and paths. The photograph is not a true orthophoto, so the roof of a tall building is displaced by its lean, and tree canopy over a roof is photographed onto it. Walls, where no open data exists, are drawn by rule: brickwork, windows and floor lines. The `Aerial photo` switch turns the photograph off.
- **Trams.** The realtime feed carries arrival predictions, not vehicle positions. Each running trip's timetable is shifted to its predicted arrival at the terminus, and the tram is drawn where that puts it.

Known gaps: no open surface model of the ACT exists, so building heights are only as good as OpenStreetMap and Microsoft's estimates, which top out near 30 m. The terrain is not LiDAR-derived, and its source has stray pixels thousands of metres off: a sweep of the 1,568 zoom-14 tiles over the ACT found 2,715 of them in 28 tiles, as clusters and as one-pixel seams along 149°E. The server fills implausible heights from their valid neighbours and replaces any pixel far from the median of its neighbourhood; after that the sweep finds none.

## Server

`server/` bakes one tile of about 1 km at a time from the sources and keeps the result on disk. The browser only ever talks to it.

- `GET /api/tile/15/{x}/{y}` returns a baked tile, cacheable for a day. The client adds `?v=<tile format version>` so a new build is not handed tiles a CDN or browser cached from an old one. A tile missing a source is served with an `X-Missing` header and is not kept.
- `GET /api/far` returns coarse terrain for the horizon.
- `GET /api/transit` returns the light rail tracks and stations.
- `GET /api/live` returns vehicles. `?at=<unix seconds>` replays the day's predictions at another time.

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `8080` | |
| `DATA_DIR` | `/data` | Cache of baked tiles and source blocks. Safe to delete. |
| `WEB_DIR` | `/web` | Built client. |
| `OVERTURE_RELEASE` | newest | Overture keeps about two months of releases, so the newest is looked up daily. |
| `BUS_RT_AUTH` | | `user:password` for Transport Canberra's bus feed, from the [ACT Government API portal](https://anypoint.mulesoft.com/exchange/portals/act-government-9/). Without it only trams are live. |

## Facade photographs (experimental)

`facades/build.py` is an offline research pipeline that textures walls from [Mapillary](https://www.mapillary.com/) street photos (CC BY-SA 4.0). It is not part of the image and nothing runs it automatically. For each wall of a tile it:

1. finds recent photos that look at the wall;
2. keeps only pixels Mapillary's own segmentation labels as building, which drops trees, cars and sky;
3. registers Mapillary's 3D mesh of each photo onto the model's footprints (the published pose is GPS-grade), and drops photos that will not fit;
4. drops parts of a wall another building hides, and any texel whose distance in the mesh is not the wall's;
5. blends the photos texel by texel, keeping a texel only where two photos agree or one well-registered photo saw it;
6. packs the walls that are covered enough into an atlas and an index.

```sh
MAPILLARY_TOKEN=... uv run facades/build.py --server http://localhost:8080 --out "$DATA_DIR/facades" 29958/19819
```

The server serves what it finds in `DATA_DIR/facades` at `/api/facades/15/{x}/{y}.json` and `.webp`, and the client lays the photographs on the matching walls when `Street photos (experimental)` is switched on, and names the photographers. Walls are matched by their end points in the tile, so a new Overture release that moves a footprint drops that wall back to drawn windows until the tile is rebuilt.

State of it, on the best-covered tile (central Civic, 999 walls, 5,083 photos since 2023):

| Stage added | Walls textured | Share of wall length | What the textures look like |
| --- | --- | --- | --- |
| Segmentation and silhouette alignment | 54 | 6% | Many slanted, some showing the building behind |
| Mesh registration and depth check, 45% cover | 7 | 1% | Upright and on the right wall |
| The same, 15% cover (`--min-cover 0.15`) | 35 | 4% | Upright and on the right wall, but in patches |

Mapillary's mesh disagrees with the model about how far away the walls are for most photos: only 473 of 1,043 photos register with 40% of their building points on a wall. So precision is now acceptable and yield is not. It is off by default because it does not beat the drawn windows. Usable Mapillary coverage in Canberra is the city centre and a few main roads; an 800 m square in Curtin has two photos. Most photos are dashcam frames along the street, so facades are seen at a slant. Remaining gaps: the ground is assumed flat, and panoramas skip registration and the depth check.

## Develop

```sh
npm ci && npm test
DATA_DIR=$(mktemp -d) PORT=8080 npm run dev:server   # API
npm run dev                                           # client with hot reload, proxying /api
```

`npm run build` writes the client to `dist/web` and the server to `dist/server.mjs`.

Keys in the overhead view: arrows or WASD move, Q and E turn, R and F tilt, plus and minus zoom.

Keys at street level: WASD or arrows drive, Space brakes, V swaps chase and first-person view, a drag looks around, Esc returns to the overhead view. Flying: W and S fly where you look, A and D turn, Q and E slide sideways, Space and C climb and descend, Shift is a fourfold boost, and the wheel sets the pace. Touch screens get a thumb stick.

Rendering resolution follows the frame rate. `?ratio=1` pins it, for benchmarks and screenshots.
