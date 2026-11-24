# canberra-3d

Explore Canberra as a 3D miniature in the browser. Built with [three.js](https://threejs.org/) from open data, streamed in as you move.

- Buildings, with measured heights where a source has them and pitched roofs on houses.
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
| Terrain | [Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) on AWS | per source |
| Light rail timetable and arrival predictions | Canberra Metro GTFS and GTFS-realtime | CC BY 4.0 |
| Bus positions (optional) | Transport Canberra GTFS-realtime | CC BY 4.0, needs a key |

How the sources combine:

- **Buildings.** OpenStreetMap outlines win where they exist. Elsewhere an ACT footprint replaces the machine-traced one and keeps its height estimate. A building no source measured takes its storey count, then the median of measured neighbours, then a guess from its use and area.
- **Trees.** The LiDAR survey gives position, height and canopy area. A crown takes the genus of the nearest registered tree within its radius; registered trees with no crown are drawn young.
- **Trams.** The realtime feed carries arrival predictions, not vehicle positions. Each running trip's timetable is shifted to its predicted arrival at the terminus, and the tram is drawn where that puts it.

Known gaps: no open surface model of the ACT exists, so building heights are only as good as OpenStreetMap and Microsoft's estimates, which top out near 30 m. The terrain is not LiDAR-derived, and its source has stray pixels thousands of metres off; the server replaces any pixel far from the median of its neighbourhood.

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

## Develop

```sh
npm ci && npm test
DATA_DIR=$(mktemp -d) PORT=8080 npm run dev:server   # API
npm run dev                                           # client with hot reload, proxying /api
```

`npm run build` writes the client to `dist/web` and the server to `dist/server.mjs`.

Keys in the overhead view: arrows or WASD move, Q and E turn, R and F tilt, plus and minus zoom.

Keys at street level: WASD or arrows drive, Space brakes, V swaps chase and first-person view, a drag looks around, Esc returns to the overhead view. Flying: W and S fly where you look, A and D turn, Q and E slide sideways, Space and Shift climb and descend. Touch screens get a thumb stick.

Rendering resolution follows the frame rate. `?ratio=1` pins it, for benchmarks and screenshots.
