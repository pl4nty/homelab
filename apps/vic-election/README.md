# vic-election

A live map of the 2026 Victorian state election that shows the leading and second-placed party on two-candidate-preferred (2CP) count in all 88 Legislative Assembly districts.

The server relays the ABC's results feed, the same one its [results page](https://www.abc.net.au/news/elections/vic/2026/results) polls, because that feed doesn't allow cross-origin requests. Results are cached for 30 seconds, and the page refreshes every minute.

## Server

`main.go` serves the embedded `web/` page and:

- `GET /api/results` returns every district's top two candidates plus the statewide count, with `stale: true` if the ABC feed fails after a successful fetch.
- `GET /districts.geojson` returns the district boundaries.

| Variable | Default |
| --- | --- |
| `ADDR` | `:8080` |
| `TTL` | `30s` |
| `ABC_URL` | `https://www.abc.net.au/news-web/api/loader/channelrefetch` |

## Boundaries

`web/districts.geojson` is Vicmap Admin `state_assembly_2022` (the 2021 redivision, first used in 2022), CC BY 4.0, simplified to about 600 KB:

1. `curl -o sa2022.json 'https://opendata.maps.vic.gov.au/geoserver/wfs?service=WFS&version=2.0.0&request=GetFeature&typeNames=open-data-platform:state_assembly_2022&outputFormat=application/json&srsName=EPSG:4326'`
2. `python3 districts.py sa2022.json web/districts.geojson 0.0006`

## Limits

- The ABC feed is undocumented and may change without notice.
- 2CP counts are the ABC's choice of the two candidates and are partial on election night.
