"""Microsoft Graph tools — Outlook email and calendar."""

import json

from kiota_abstractions.base_request_configuration import RequestConfiguration
from kiota_abstractions.serialization.parsable import Parsable
from kiota_serialization_json.json_serialization_writer_factory import (
    JsonSerializationWriterFactory,
)
from msgraph_beta.generated.users.item.events.events_request_builder import (
    EventsRequestBuilder,
)
from msgraph_beta.generated.users.item.mail_folders.item.messages.messages_request_builder import (
    MessagesRequestBuilder as FolderMessagesBuilder,
)
from msgraph_beta.generated.users.item.messages.messages_request_builder import (
    MessagesRequestBuilder,
)

from tools.runtime import graph_client, mcp

_json_factory = JsonSerializationWriterFactory()
MessagesQuery = MessagesRequestBuilder.MessagesRequestBuilderGetQueryParameters
FolderMessagesQuery = FolderMessagesBuilder.MessagesRequestBuilderGetQueryParameters
EventsQuery = EventsRequestBuilder.EventsRequestBuilderGetQueryParameters


def _to_dict(obj: Parsable) -> dict:
    writer = _json_factory.get_serialization_writer("application/json")
    obj.serialize(writer)
    return json.loads(writer.get_serialized_content())


@mcp.tool()
async def search_emails(query: str, max_results: int = 10) -> list[dict]:
    """Search emails in the user's Outlook mailbox.

    Args:
        query: Free-text search query (OData $search syntax).
        max_results: Maximum number of emails to return.
    """
    result = await graph_client().me().messages.get(
        request_configuration=RequestConfiguration(
            query_parameters=MessagesQuery(
                search=f'"{query}"',
                top=max_results,
                orderby=["receivedDateTime DESC"],
            )
        )
    )
    return [_to_dict(m) for m in (result and result.value or [])]


@mcp.tool()
async def list_emails(
    folder: str = "inbox",
    max_results: int = 10,
    only_unread: bool = False,
    start_datetime: str | None = None,
    end_datetime: str | None = None,
) -> list[dict]:
    """List emails from a mailbox folder.

    Args:
        folder: Folder name: inbox, drafts, sentitems, deleteditems, or junkemail.
        max_results: Maximum number of emails to return.
        only_unread: If True, return only unread messages.
        start_datetime: ISO 8601 lower bound on receivedDateTime.
        end_datetime: ISO 8601 upper bound on receivedDateTime.
    """
    filters: list[str] = []
    if only_unread:
        filters.append("isRead eq false")
    if start_datetime:
        filters.append(f"receivedDateTime ge {start_datetime}")
    if end_datetime:
        filters.append(f"receivedDateTime le {end_datetime}")

    result = await graph_client().me().mail_folders.by_mail_folder_id(folder).messages.get(
        request_configuration=RequestConfiguration(
            query_parameters=FolderMessagesQuery(
                top=max_results,
                orderby=["receivedDateTime DESC"],
                filter=" and ".join(filters) or None,
            )
        )
    )
    return [_to_dict(m) for m in (result and result.value or [])]


@mcp.tool()
async def read_email(email_id: str) -> dict:
    """Read the full content of a specific email.

    Args:
        email_id: The unique message ID returned by search_emails or list_emails.
    """
    message = await graph_client().me().messages.by_message_id(email_id).get()
    if message is None:
        raise RuntimeError(f"Email not found: {email_id!r}")
    return _to_dict(message)


@mcp.tool()
async def list_calendar_events(
    max_results: int = 10,
    start_datetime: str | None = None,
    end_datetime: str | None = None,
) -> list[dict]:
    """List upcoming calendar events.

    Args:
        max_results: Maximum number of events to return.
        start_datetime: ISO 8601 start date/time filter.
        end_datetime: ISO 8601 end date/time filter.
    """
    filters: list[str] = []
    if start_datetime:
        filters.append(f"start/dateTime ge '{start_datetime}'")
    if end_datetime:
        filters.append(f"end/dateTime le '{end_datetime}'")

    result = await graph_client().me().events.get(
        request_configuration=RequestConfiguration(
            query_parameters=EventsQuery(
                top=max_results,
                orderby=["start/dateTime ASC"],
                filter=" and ".join(filters) or None,
            )
        )
    )
    return [_to_dict(e) for e in (result and result.value or [])]


@mcp.tool()
async def search_calendar_events(query: str, max_results: int = 10) -> list[dict]:
    """Search calendar events by subject text.

    Args:
        query: Search string to match against event subjects.
        max_results: Maximum number of events to return.
    """
    escaped = query.replace("'", "''")
    result = await graph_client().me().events.get(
        request_configuration=RequestConfiguration(
            query_parameters=EventsQuery(
                filter=f"contains(subject, '{escaped}')",
                top=max_results,
            )
        )
    )
    return [_to_dict(e) for e in (result and result.value or [])]
