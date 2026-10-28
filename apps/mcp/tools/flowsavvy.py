"""FlowSavvy tools — task and event management."""

import json
import os
import re
from typing import Optional

import httpx

from tools.runtime import mcp

FLOWSAVVY_COOKIE = os.environ.get("FLOWSAVVY_COOKIE", "")
_BASE = "https://my.flowsavvy.app/api"


def _client() -> httpx.AsyncClient:
    if not FLOWSAVVY_COOKIE:
        raise RuntimeError("FLOWSAVVY_COOKIE environment variable is not set")
    jar = httpx.Cookies()
    jar.set("Identity.Cookie", FLOWSAVVY_COOKIE, domain="my.flowsavvy.app")
    return httpx.AsyncClient(cookies=jar)


async def _get_antiforgery_token(client: httpx.AsyncClient) -> str:
    """Fetch the ASP.NET Core anti-forgery token required for all POST requests."""
    resp = await client.get(f"{_BASE}/Schedule/AntiForgeryToken")
    resp.raise_for_status()
    m = re.search(r'value="([^"]+)"', resp.text)
    if not m:
        raise RuntimeError("Could not parse anti-forgery token from response")
    return m.group(1)


async def _get_defaults(client: httpx.AsyncClient) -> dict:
    """Fetch the default task list ID, calendar ID, and time profile ID."""
    tl_resp, tp_resp = await asyncio.gather(
        client.get(f"{_BASE}/TaskList/Get"),
        client.get(f"{_BASE}/TimeProfile/Get"),
    )
    tl_resp.raise_for_status()
    tp_resp.raise_for_status()
    tl = tl_resp.json()
    tp = tp_resp.json()
    default_list_id = tl["defaultTaskListId"]
    default_cal_id = next(
        t["calendarId"] for t in tl["taskLists"] if t["id"] == default_list_id
    )
    return {
        "task_list_id": default_list_id,
        "calendar_id": default_cal_id,
        "time_profile_id": tp["defaultTimeProfileId"],
    }


def _extract_item(item: dict) -> dict:
    source = item.get("Item") if isinstance(item.get("Item"), dict) else item
    entry = {
        k: source[k]
        for k in (
            "id", "Title", "ItemType", "DueDateTime", "StartDateTime",
            "EndDateTime", "Notes", "priority", "FixedTime", "AllDay",
            "taskListId", "Completed",
        )
        if k in source
    }
    # CalendarID uses different casing in schedule vs other responses
    if "CalendarID" in source:
        entry["calendarId"] = source["CalendarID"]
    elif "calendarId" in source:
        entry["calendarId"] = source["calendarId"]
    if "id" not in entry:
        for key in ("id", "ItemID", "newItemId"):
            if key in item:
                entry["id"] = item[key]
                break
    return entry


def _parse_schedule_response(data) -> list[dict]:
    if isinstance(data, list):
        items = data
    elif isinstance(data, dict):
        schedule = data.get("scheduleResponse", data)
        if isinstance(schedule, dict):
            schedule_items = schedule.get("scheduleItems", [])
            all_day_events = schedule.get("allDayEvents", [])
            if isinstance(schedule_items, list) or isinstance(all_day_events, list):
                items = []
                if isinstance(schedule_items, list):
                    items.extend(schedule_items)
                if isinstance(all_day_events, list):
                    items.extend(all_day_events)
            else:
                items = schedule.get("items", schedule.get("Items", [schedule]))
        else:
            items = [schedule]
    else:
        items = [data]

    results = []
    for item in items:
        if not isinstance(item, dict):
            continue
        entry = _extract_item(item)
        if entry:
            results.append(entry)
    return results


async def _build_item_form(
    client: httpx.AsyncClient,
    aft: str,
    title: str,
    item_type: str,
    due_date_time: str,
    start_date_time: str,
    end_date_time: str,
    notes: str = "<p></p>",
    priority: int = 1,
    task_list_id: int = 0,
    calendar_id: int = 0,
    time_profile_id: int = 0,
    fixed_time: bool = False,
    all_day: bool = False,
    item_id: int = 0,
    instance_id: int = 0,
    dont_start_until: str = "0001-01-01T00:00",
    location: str = "",
    busy: bool = True,
    save_type: str = "all",
) -> dict:
    # For tasks, IDs of 0 are invalid — auto-fetch the account defaults.
    if item_type == "task" and (task_list_id == 0 or time_profile_id == 0):
        defaults = await _get_defaults(client)
        if task_list_id == 0:
            task_list_id = defaults["task_list_id"]
        if calendar_id == 0:
            calendar_id = defaults["calendar_id"]
        if time_profile_id == 0:
            time_profile_id = defaults["time_profile_id"]

    return {
        "id": str(item_id),
        "InstanceID": str(instance_id),
        "Notes": notes,
        "DueDateTime": due_date_time,
        "StartDateTime": start_date_time,
        "EndDateTime": end_date_time,
        "DontStartUntil": dont_start_until,
        "TimeZone": "Floating",
        "IsAutoIgnored": "false",
        "Title": title,
        "ItemType": item_type,
        "ProgressHours": "0",
        "ProgressMinutes": "0",
        "minLengthTotalMinutes": "60",
        "BufferTimeBeforeHours": "0",
        "BufferTimeBeforeMinutes": "0",
        "BufferTimeAfterHours": "0",
        "BufferTimeAfterMinutes": "0",
        "Busy": str(busy).lower(),
        "FixedTime": str(fixed_time).lower(),
        "AllDay": str(all_day).lower(),
        "RepeatType": "Never",
        "Interval": "1",
        "Sunday": "false",
        "Monday": "false",
        "Tuesday": "false",
        "Wednesday": "false",
        "Thursday": "false",
        "Friday": "false",
        "Saturday": "false",
        "MonthlyType": "Each...",
        "Dates": "",
        "MonthOrdinal": "0",
        "WeekDay": "0",
        "EndRepeatType": "Never",
        "EndRepeatDate": "0001-01-01T00:00",
        "NumOccurrences": "1",
        "priority": str(priority),
        "customColor": "",
        "taskListId": str(task_list_id),
        "calendarId": str(calendar_id),
        "timeProfileId": str(time_profile_id),
        "Location": location,
        "saveType": save_type,
        "__RequestVerificationToken": aft,
    }


import asyncio


async def _fetch_schedule(client: httpx.AsyncClient) -> list[dict]:
    """Return all items from the current scheduled window."""
    resp = await client.get(f"{_BASE}/Schedule/GetSchedule")
    resp.raise_for_status()
    return _parse_schedule_response(resp.json())


@mcp.tool()
async def get_flowsavvy_schedule(
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
) -> list[dict]:
    """Get tasks and events from FlowSavvy schedule.

    Args:
        start_date: Start date in ISO format (e.g. "2026-06-01"). Defaults to current week.
        end_date: End date in ISO format (e.g. "2026-06-30").
    """
    params = {}
    if start_date:
        params["start"] = start_date
    if end_date:
        params["end"] = end_date

    async with _client() as client:
        resp = await client.get(f"{_BASE}/Schedule/GetSchedule", params=params)
        resp.raise_for_status()
        return _parse_schedule_response(resp.json())


@mcp.tool()
async def list_flowsavvy_items() -> list[dict]:
    """List all currently scheduled tasks and events from FlowSavvy."""
    async with _client() as client:
        return await _fetch_schedule(client)


@mcp.tool()
async def get_flowsavvy_item(item_id: int) -> dict:
    """Get details of a single FlowSavvy item by ID from the current schedule.

    Args:
        item_id: The numeric ID of the task or event.
    """
    async with _client() as client:
        items = await _fetch_schedule(client)

    found = [i for i in items if i.get("id") == item_id]
    if not found:
        raise ValueError(f"Item {item_id} not found in current schedule")
    return found[0]


@mcp.tool()
async def list_flowsavvy_calendars() -> list[dict]:
    """List all calendars and connected calendar accounts in FlowSavvy."""
    async with _client() as client:
        resp = await client.get(f"{_BASE}/Calendar/Info")
        resp.raise_for_status()
        return resp.json()


@mcp.tool()
async def list_flowsavvy_lists() -> list[dict]:
    """List all task lists in FlowSavvy."""
    async with _client() as client:
        resp = await client.get(f"{_BASE}/TaskList/Get")
        resp.raise_for_status()
        return resp.json()


@mcp.tool()
async def list_flowsavvy_scheduling_hours() -> list[dict]:
    """List all scheduling hour profiles (time profiles) in FlowSavvy."""
    async with _client() as client:
        resp = await client.get(f"{_BASE}/TimeProfile/Get")
        resp.raise_for_status()
        return resp.json()


@mcp.tool()
async def create_flowsavvy_task(
    title: str,
    due_date_time: str,
    start_date_time: str,
    end_date_time: str,
    notes: str = "<p></p>",
    priority: int = 1,
    task_list_id: int = 0,
    calendar_id: int = 0,
    time_profile_id: int = 0,
    fixed_time: bool = False,
    all_day: bool = False,
) -> dict:
    """Create a new task in FlowSavvy.

    Args:
        title: Task title.
        due_date_time: Due date/time in ISO format (e.g. "2026-05-10T23:59").
        start_date_time: Scheduled start date/time (e.g. "2026-05-10T14:00").
        end_date_time: Scheduled end date/time (e.g. "2026-05-10T15:00").
        notes: HTML notes for the task.
        priority: Priority level (1 = default).
        task_list_id: FlowSavvy task list ID (0 = use account default).
        calendar_id: FlowSavvy calendar ID (0 = use account default).
        time_profile_id: FlowSavvy time profile ID (0 = use account default).
        fixed_time: Whether the task is fixed to its scheduled time.
        all_day: Whether this is an all-day task.
    """
    async with _client() as client:
        aft = await _get_antiforgery_token(client)
        form_data = await _build_item_form(
            client=client, aft=aft,
            title=title, item_type="task",
            due_date_time=due_date_time,
            start_date_time=start_date_time,
            end_date_time=end_date_time,
            notes=notes, priority=priority,
            task_list_id=task_list_id,
            calendar_id=calendar_id,
            time_profile_id=time_profile_id,
            fixed_time=fixed_time, all_day=all_day,
        )
        resp = await client.post(f"{_BASE}/Item/Create", data=form_data)
        resp.raise_for_status()
        return resp.json()


@mcp.tool()
async def create_flowsavvy_event(
    title: str,
    start_date_time: str,
    end_date_time: str,
    notes: str = "<p></p>",
    calendar_id: int = 0,
    fixed_time: bool = True,
    all_day: bool = False,
    location: str = "",
    busy: bool = True,
) -> dict:
    """Create a new calendar event in FlowSavvy.

    Args:
        title: Event title.
        start_date_time: Event start date/time in ISO format (e.g. "2026-06-10T14:00").
        end_date_time: Event end date/time in ISO format (e.g. "2026-06-10T15:00").
        notes: HTML notes for the event.
        calendar_id: FlowSavvy calendar ID (0 = use account default).
        fixed_time: Whether the event is at a fixed time (default True for events).
        all_day: Whether this is an all-day event.
        location: Optional location string.
        busy: Whether to mark the time as busy.
    """
    async with _client() as client:
        aft = await _get_antiforgery_token(client)
        form_data = await _build_item_form(
            client=client, aft=aft,
            title=title, item_type="event",
            due_date_time=end_date_time,
            start_date_time=start_date_time,
            end_date_time=end_date_time,
            notes=notes, calendar_id=calendar_id,
            fixed_time=fixed_time, all_day=all_day,
            location=location, busy=busy,
        )
        resp = await client.post(f"{_BASE}/Item/Create", data=form_data)
        resp.raise_for_status()
        return resp.json()


@mcp.tool()
async def update_flowsavvy_task(
    item_id: int,
    title: str,
    due_date_time: str,
    start_date_time: str,
    end_date_time: str,
    notes: str = "<p></p>",
    priority: int = 1,
    task_list_id: int = 0,
    calendar_id: int = 0,
    time_profile_id: int = 0,
    fixed_time: bool = False,
    all_day: bool = False,
    instance_id: int = 0,
    save_type: str = "all",
) -> dict:
    """Update an existing task in FlowSavvy.

    Args:
        item_id: The numeric ID of the task to update.
        title: Task title.
        due_date_time: Due date/time in ISO format (e.g. "2026-05-10T23:59").
        start_date_time: Scheduled start date/time (e.g. "2026-05-10T14:00").
        end_date_time: Scheduled end date/time (e.g. "2026-05-10T15:00").
        notes: HTML notes for the task.
        priority: Priority level (1 = default).
        task_list_id: FlowSavvy task list ID (0 = use account default).
        calendar_id: FlowSavvy calendar ID (0 = use account default).
        time_profile_id: FlowSavvy time profile ID (0 = use account default).
        fixed_time: Whether the task is fixed to its scheduled time.
        all_day: Whether this is an all-day task.
        instance_id: Instance ID for repeating tasks (0 for non-repeating).
        save_type: How to save repeating tasks — "all", "this", or "thisAndFuture".
    """
    async with _client() as client:
        aft = await _get_antiforgery_token(client)
        form_data = await _build_item_form(
            client=client, aft=aft,
            title=title, item_type="task",
            due_date_time=due_date_time,
            start_date_time=start_date_time,
            end_date_time=end_date_time,
            notes=notes, priority=priority,
            task_list_id=task_list_id,
            calendar_id=calendar_id,
            time_profile_id=time_profile_id,
            fixed_time=fixed_time, all_day=all_day,
            item_id=item_id, instance_id=instance_id,
            save_type=save_type,
        )
        resp = await client.post(f"{_BASE}/Item/Edit", data=form_data)
        resp.raise_for_status()
        return resp.json()


@mcp.tool()
async def update_flowsavvy_event(
    item_id: int,
    title: str,
    start_date_time: str,
    end_date_time: str,
    notes: str = "<p></p>",
    calendar_id: int = 0,
    fixed_time: bool = True,
    all_day: bool = False,
    location: str = "",
    busy: bool = True,
    instance_id: int = 0,
    save_type: str = "all",
) -> dict:
    """Update an existing event in FlowSavvy.

    Args:
        item_id: The numeric ID of the event to update.
        title: Event title.
        start_date_time: Event start date/time in ISO format (e.g. "2026-06-10T14:00").
        end_date_time: Event end date/time in ISO format (e.g. "2026-06-10T15:00").
        notes: HTML notes for the event.
        calendar_id: FlowSavvy calendar ID (0 = use account default).
        fixed_time: Whether the event is at a fixed time.
        all_day: Whether this is an all-day event.
        location: Optional location string.
        busy: Whether to mark the time as busy.
        instance_id: Instance ID for repeating events (0 for non-repeating).
        save_type: How to save repeating events — "all", "this", or "thisAndFuture".
    """
    async with _client() as client:
        aft = await _get_antiforgery_token(client)
        form_data = await _build_item_form(
            client=client, aft=aft,
            title=title, item_type="event",
            due_date_time=end_date_time,
            start_date_time=start_date_time,
            end_date_time=end_date_time,
            notes=notes, calendar_id=calendar_id,
            fixed_time=fixed_time, all_day=all_day,
            location=location, busy=busy,
            item_id=item_id, instance_id=instance_id,
            save_type=save_type,
        )
        resp = await client.post(f"{_BASE}/Item/Edit", data=form_data)
        resp.raise_for_status()
        return resp.json()


@mcp.tool()
async def complete_flowsavvy_task(item_id: int, instance_id: int = 0) -> dict:
    """Mark a FlowSavvy task as complete.

    Args:
        item_id: The numeric ID of the task to complete.
        instance_id: Instance ID for repeating tasks (0 for non-repeating).
    """
    serialized = json.dumps({str(item_id): [instance_id]})
    async with _client() as client:
        aft = await _get_antiforgery_token(client)
        resp = await client.post(
            f"{_BASE}/Item/ChangeTaskCompleteStatus",
            data={
                "serializedItemIdToInstanceIdsDict": serialized,
                "platform": "web",
                "__RequestVerificationToken": aft,
            },
        )
        resp.raise_for_status()
        return resp.json()


@mcp.tool()
async def uncomplete_flowsavvy_task(item_id: int, instance_id: int = 0) -> dict:
    """Mark a FlowSavvy task as incomplete (reopen it).

    Args:
        item_id: The numeric ID of the task to reopen.
        instance_id: Instance ID for repeating tasks (0 for non-repeating).
    """
    serialized = json.dumps({str(item_id): [instance_id]})
    async with _client() as client:
        aft = await _get_antiforgery_token(client)
        resp = await client.post(
            f"{_BASE}/Item/ChangeTaskCompleteStatus",
            data={
                "serializedItemIdToInstanceIdsDict": serialized,
                "platform": "web",
                "__RequestVerificationToken": aft,
            },
        )
        resp.raise_for_status()
        return resp.json()


@mcp.tool()
async def delete_flowsavvy_item(
    item_id: int,
    instance_id: int = 0,
    delete_type: str = "deleteThis",
) -> dict:
    """Delete a task or event from FlowSavvy.

    Args:
        item_id: The numeric ID of the item to delete.
        instance_id: Instance ID for repeating items (0 for non-repeating).
        delete_type: "deleteThis" to delete only this instance, "deleteAll" to delete all instances.
    """
    serialized = json.dumps({str(item_id): [instance_id]})
    async with _client() as client:
        aft = await _get_antiforgery_token(client)
        resp = await client.post(
            f"{_BASE}/Item/MultipleDelete",
            data={
                "serializedItemIdToInstanceIdsDict": serialized,
                "deleteType": delete_type,
                "__RequestVerificationToken": aft,
            },
        )
        resp.raise_for_status()
        return resp.json()


@mcp.tool()
async def recalculate_flowsavvy(
    force: bool = False,
    reschedule_past_tasks: Optional[bool] = None,
) -> dict:
    """Trigger FlowSavvy to recalculate and reschedule all tasks.

    Args:
        force: Force recalculation even if not needed.
        reschedule_past_tasks: Whether to reschedule tasks with past start times.
    """
    async with _client() as client:
        aft = await _get_antiforgery_token(client)
        form_data: dict = {
            "force": str(force).lower(),
            "__RequestVerificationToken": aft,
        }
        if reschedule_past_tasks is not None:
            form_data["reschedulePastTasks"] = str(reschedule_past_tasks).lower()
        resp = await client.post(f"{_BASE}/Schedule/Recalculate", data=form_data)
        resp.raise_for_status()
        return resp.json()
