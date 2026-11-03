"""Google Maps tools — Routes API."""

import os
from datetime import datetime, timezone

from google.api_core.client_options import ClientOptions
from google.maps import routing_v2
from google.protobuf.json_format import MessageToDict
from google.protobuf.timestamp_pb2 import Timestamp

from tools.runtime import mcp

GOOGLE_MAPS_API_KEY = os.environ.get("GOOGLE_MAPS_API_KEY", "")


def _waypoint_from_text(value: str) -> routing_v2.Waypoint:
    text = value.strip()
    if text.lower().startswith("place_id:"):
        return routing_v2.Waypoint(place_id=text.split(":", 1)[1].strip())
    return routing_v2.Waypoint(address=text)


def _parse_timestamp(value: str) -> Timestamp:
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    ts = Timestamp()
    ts.FromDatetime(dt)
    return ts


@mcp.tool()
async def compute_route(
    origin: str,
    destination: str,
    travel_mode: str = "DRIVE",
    departure_time: str | None = None,
    arrival_time: str | None = None,
) -> dict:
    """Compute a route between two locations using Google Maps Routes API.

    Args:
        origin: Natural-language origin, e.g. "1600 Amphitheatre Pkwy, Mountain View".
                You can also pass a place id as "place_id:ChIJ...".
        destination: Natural-language destination or "place_id:...".
        travel_mode: DRIVE, BICYCLE, WALK, TWO_WHEELER, or TRANSIT.
        departure_time: Optional ISO 8601 date-time (e.g. "2026-03-17T15:30:00Z").
        arrival_time: Optional ISO 8601 date-time (e.g. "2026-03-17T16:00:00Z").
    """
    if departure_time and arrival_time:
        raise ValueError("Provide only one of departure_time or arrival_time")

    request = routing_v2.ComputeRoutesRequest(
        origin=_waypoint_from_text(origin),
        destination=_waypoint_from_text(destination),
        travel_mode=routing_v2.RouteTravelMode[travel_mode],
    )
    if departure_time:
        request.departure_time = _parse_timestamp(departure_time)
    if arrival_time:
        request.arrival_time = _parse_timestamp(arrival_time)

    client = routing_v2.RoutesAsyncClient(
        client_options=ClientOptions(
            api_key=GOOGLE_MAPS_API_KEY) if GOOGLE_MAPS_API_KEY else None,
    )
    response = await client.compute_routes(
        request=request,
        metadata=[(
            "x-goog-fieldmask",
            "routes.duration,routes.distanceMeters,routes.legs,routes.polyline.encodedPolyline",
        )],
    )
    return MessageToDict(type(response).pb(response))
