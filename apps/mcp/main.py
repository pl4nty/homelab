"""MCP Resource Server for Outlook via Microsoft Graph with Entra delegated auth."""

import logging
import os
import urllib.parse
from contextvars import ContextVar

import httpx
import jwt
import uvicorn
# from azure.identity.aio import OnBehalfOfCredential
from dotenv import load_dotenv
# from msgraph_beta import GraphServiceClient
from pydantic import AnyHttpUrl
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import RedirectResponse, Response
from starlette.routing import Mount, Route

from mcp.server.auth.provider import AccessToken, TokenVerifier
from mcp.server.auth.settings import AuthSettings
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings

load_dotenv()
log = logging.getLogger(__name__)

AZURE_TENANT_ID = os.environ.get("AZURE_TENANT_ID", "common")
AZURE_CLIENT_ID = os.environ.get("AZURE_CLIENT_ID", "")
AZURE_CLIENT_SECRET = os.environ.get("AZURE_CLIENT_SECRET", "")

if not AZURE_CLIENT_ID or not AZURE_CLIENT_SECRET:
    raise RuntimeError("AZURE_CLIENT_ID and AZURE_CLIENT_SECRET must be set.")

ENTRA_URL = f"https://login.microsoftonline.com/{AZURE_TENANT_ID}/oauth2/v2.0"
JWKS_URL = f"https://login.microsoftonline.com/{AZURE_TENANT_ID}/discovery/v2.0/keys"
AUDIENCES = {AZURE_CLIENT_ID, f"api://{AZURE_CLIENT_ID}"}

_user_assertion: ContextVar[str] = ContextVar("user_assertion", default="")
_user_tenant: ContextVar[str] = ContextVar("user_tenant", default="")


class EntraTokenVerifier(TokenVerifier):
    def __init__(self) -> None:
        self._jwks = jwt.PyJWKClient(JWKS_URL)

    async def verify_token(self, token: str) -> AccessToken | None:
        try:
            key = self._jwks.get_signing_key_from_jwt(token)
            claims = jwt.decode(
                token, key.key,
                algorithms=["RS256"],
                audience=list(AUDIENCES),
                options={"verify_iss": False},
            )
        except Exception as exc:
            log.warning("Token validation failed: %s", exc)
            return None

        _user_assertion.set(token)
        _user_tenant.set(claims.get("tid", ""))

        return AccessToken(
            token=token,
            client_id=claims.get("azp") or claims.get(
                "appid") or AZURE_CLIENT_ID,
            scopes=claims.get("scp", "").lower().split(),
            expires_at=claims.get("exp"),
        )


mcp = FastMCP(
    name="Outlook MCP",
    instructions="Tools for reading Outlook emails and calendar events via Microsoft Graph.",
    # token_verifier=EntraTokenVerifier(),
    # auth=AuthSettings(
    #     issuer_url=AnyHttpUrl(ENTRA_URL),
    #     resource_server_url=None,
    #     required_scopes=None,
    # ),
    transport_security=TransportSecuritySettings(
        enable_dns_rebinding_protection=False,
    )
)


# def _graph_client() -> GraphServiceClient:
#     assertion = _user_assertion.get()
#     if not assertion:
#         raise RuntimeError("No authenticated user token available")
#     return GraphServiceClient(
#         credentials=OnBehalfOfCredential(
#             tenant_id=_user_tenant.get() or AZURE_TENANT_ID,
#             client_id=AZURE_CLIENT_ID,
#             client_secret=AZURE_CLIENT_SECRET,
#             user_assertion=assertion,
#         ),
#         scopes=["https://graph.microsoft.com/.default"],
#     )


# Using third-party servers for these
# import tools.graph  # noqa: E402, F401 — registers @mcp.tool() on import
# import tools.google_maps  # noqa: E402, F401
import tools.flowsavvy  # noqa: E402, F401


_PROXY_SCOPE = f"api://{AZURE_CLIENT_ID}/claudeai"


async def _authorize(request: Request) -> RedirectResponse:
    params = {**request.query_params, "scope": _PROXY_SCOPE}
    return RedirectResponse(
        f"{ENTRA_URL}/authorize?{urllib.parse.urlencode(params)}",
        status_code=302,
    )


async def _token(request: Request) -> Response:
    headers = {k: v for k, v in request.headers.items() if k.lower()
               in ("content-type", "accept")}
    async with httpx.AsyncClient() as client:
        resp = await client.post(f"{ENTRA_URL}/token", content=await request.body(), headers=headers)
    return Response(content=resp.content, status_code=resp.status_code, media_type=resp.headers.get("content-type"))


def main() -> None:
    mcp_app = mcp.streamable_http_app()
    # FastMCP resource_server_url is used as both MCP base and OAuth scope, but Entra only allows api:// or http with a verified domain
    # So for local development with non-entra-verified domains, we become the Auth Server (resource_server_url=None) and forward to Entra, rewriting the scope
    app = Starlette(
        lifespan=mcp_app.router.lifespan_context,
        routes=[
            Route("/authorize", endpoint=_authorize, methods=["GET"]),
            Route("/token", endpoint=_token, methods=["POST"]),
            Mount("/", app=mcp_app),
        ],
    )
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "8000"))
    uvicorn.run(app, host=host, port=port)


if __name__ == "__main__":
    main()
