"""MCP server that mirrors the Namespace devbox tools on Azure Windows VMs, plus GUI tools."""

import asyncio
import base64
import contextlib
import functools
import logging
import os
import re
import secrets
import subprocess
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Literal
from xml.sax.saxutils import escape

import uvicorn
from mcp.server.mcpserver import Image, MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.server.transport_security import TransportSecuritySettings
from starlette.applications import Starlette
from starlette.routing import Mount, WebSocketRoute

from arm import TAG, Azure, AzureError
from hub import AGENT_SOURCE, AgentError, Hub, agent_token

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)

PUBLIC_URL = os.environ.get("PUBLIC_URL", "http://localhost:8000").rstrip("/")
IDLE_MINUTES = int(os.environ.get("IDLE_MINUTES", "30"))
MAX_DEVBOXES = int(os.environ.get("MAX_DEVBOXES", "2"))
SHUTDOWN_TIME = os.environ.get("SHUTDOWN_TIME", "0300")
SHUTDOWN_TIME_ZONE = os.environ.get("SHUTDOWN_TIME_ZONE", "AUS Eastern Standard Time")
USER = "devbox"
OUTPUT_LIMIT = 64 * 1024
BOOTSTRAP = (Path(__file__).parent / "agent" / "bootstrap.ps1").read_text()
FIRST_LOGON = (
    "powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "
    '"Copy-Item -Force C:\\AzureData\\CustomData.bin C:\\AzureData\\bootstrap.ps1; '
    '& C:\\AzureData\\bootstrap.ps1 *> C:\\AzureData\\bootstrap.log"'
)

SHAPES = {
    "S": "Standard_D2as_v5",
    "M": "Standard_D4as_v5",
    "L": "Standard_D8as_v5",
    "XL": "Standard_D16as_v5",
}
IMAGES = {
    "windows-server-2025": {
        "publisher": "MicrosoftWindowsServer",
        "offer": "WindowsServer",
        "sku": "2025-datacenter-smalldisk-g2",
        "version": "latest",
    },
    "windows-server-2022": {
        "publisher": "MicrosoftWindowsServer",
        "offer": "WindowsServer",
        "sku": "2022-datacenter-smalldisk-g2",
        "version": "latest",
    },
    # needs a Windows 10/11 Enterprise E3/E5 or VDA licence for multitenant hosting rights
    "windows-11": {
        "publisher": "MicrosoftWindowsDesktop",
        "offer": "windows-11",
        "sku": "win11-24h2-ent",
        "version": "latest",
    },
}
CAPACITY_ERRORS = {
    "SkuNotAvailable",
    "AllocationFailed",
    "ZonalAllocationFailed",
    "OverconstrainedAllocationRequest",
    "OverconstrainedZonalAllocationRequest",
    "QuotaExceeded",
    "OperationNotAllowed",
}

azure = Azure()
hub = Hub()
last_used: dict[str, datetime] = {}
tagged: dict[str, datetime] = {}
progress: dict[str, dict] = {}
tasks: set[asyncio.Task] = set()

mcp = MCPServer(
    name="Windows devbox",
    instructions=(
        "Azure Windows VMs with the Namespace devbox tool surface plus GUI tools. "
        "Create with devbox_create, poll devbox_wait_ready, then use devbox_exec, the file tools "
        "and the GUI tools (devbox_screenshot, devbox_mouse, devbox_keyboard, devbox_windows). "
        f"Idle devboxes stop after {IDLE_MINUTES} minutes without a tool call. "
        "Delete or stop devboxes when the task is done."
    ),
)


def tool(**kwargs):
    def register(fn):
        @functools.wraps(fn)
        async def wrapper(*args, **kw):
            try:
                return await fn(*args, **kw)
            except (AgentError, AzureError, ValueError, TimeoutError) as exc:
                raise ToolError(str(exc)) from exc

        return mcp.tool(**kwargs)(wrapper)

    return register


def spawn(coro) -> None:
    task = asyncio.create_task(coro)
    tasks.add(task)
    task.add_done_callback(tasks.discard)


def now() -> datetime:
    return datetime.now(UTC)


def touch(name: str) -> None:
    last_used[name] = now()
    if now() - tagged.get(name, datetime.min.replace(tzinfo=UTC)) > timedelta(minutes=5):
        tagged[name] = now()
        spawn(tag(name, {"last-used": now().isoformat()}))


async def tag(name: str, tags: dict[str, str]) -> None:
    try:
        await azure.merge_tags(name, tags)
    except Exception as exc:
        log.warning("tagging %s failed: %s", name, exc)


def power_state(vm: dict) -> str:
    for status in vm.get("properties", {}).get("instanceView", {}).get("statuses", []):
        if status.get("code", "").startswith("PowerState/"):
            return status["code"].removeprefix("PowerState/")
    return "unknown"


def check_name(name: str) -> None:
    if not re.fullmatch(r"[a-z][a-z0-9-]{0,14}", name):
        raise ValueError(
            "name must be 1-15 lowercase letters, digits or hyphens, starting with a letter"
        )


def capacity_error(exc: AzureError) -> bool:
    return exc.code in CAPACITY_ERRORS or "quota" in str(exc).lower()


def vm_body(name: str, size: str, image: str, ephemeral: bool, spot: bool, nic: str) -> dict:
    password = "Aa1-" + secrets.token_urlsafe(24)
    custom_data = (
        BOOTSTRAP.replace("{{USER}}", USER)
        .replace("{{URL}}", f"{PUBLIC_URL.replace('http', 'ws', 1)}/agent/{name}")
        .replace("{{TOKEN}}", agent_token(name))
        .replace("{{AGENT}}", AGENT_SOURCE.strip())
    )
    encoded = base64.b64encode(custom_data.encode()).decode()
    if len(encoded) > 65535:
        raise RuntimeError("bootstrap script is over Azure's 64 KB customData limit")
    reference = IMAGES.get(image)
    if not reference:
        publisher, offer, sku, version = image.split(":")
        reference = {"publisher": publisher, "offer": offer, "sku": sku, "version": version}
    timestamp = now().isoformat()
    properties = {
        "hardwareProfile": {"vmSize": size},
        "storageProfile": {
            "imageReference": reference,
            "osDisk": {
                "name": f"{name}-os",
                "createOption": "FromImage",
                "deleteOption": "Delete",
                "managedDisk": {"storageAccountType": "StandardSSD_LRS"},
            },
        },
        "osProfile": {
            "computerName": name,
            "adminUsername": USER,
            "adminPassword": password,
            "customData": encoded,
            "windowsConfiguration": {
                "provisionVMAgent": True,
                "enableAutomaticUpdates": False,
                "patchSettings": {"patchMode": "Manual"},
                "additionalUnattendContent": [
                    {
                        "passName": "OobeSystem",
                        "componentName": "Microsoft-Windows-Shell-Setup",
                        "settingName": "AutoLogon",
                        "content": (
                            f"<AutoLogon><Password><Value>{password}</Value></Password>"
                            f"<Enabled>true</Enabled><LogonCount>1</LogonCount>"
                            f"<Username>{USER}</Username></AutoLogon>"
                        ),
                    },
                    {
                        "passName": "OobeSystem",
                        "componentName": "Microsoft-Windows-Shell-Setup",
                        "settingName": "FirstLogonCommands",
                        "content": (
                            "<FirstLogonCommands><SynchronousCommand>"
                            f"<CommandLine>{escape(FIRST_LOGON)}</CommandLine>"
                            f"<Description>{TAG}</Description><Order>1</Order>"
                            "</SynchronousCommand></FirstLogonCommands>"
                        ),
                    },
                ],
            },
        },
        "networkProfile": {
            "networkInterfaces": [
                {"id": nic, "properties": {"primary": True, "deleteOption": "Delete"}}
            ]
        },
        "diagnosticsProfile": {"bootDiagnostics": {"enabled": True}},
    }
    if spot:
        properties |= {
            "priority": "Spot",
            "evictionPolicy": "Delete" if ephemeral else "Deallocate",
            "billingProfile": {"maxPrice": -1},
        }
    if reference["publisher"] == "MicrosoftWindowsDesktop":
        properties["licenseType"] = "Windows_Client"
    return {
        "location": azure.location,
        "tags": {
            TAG: "true",
            "ephemeral": str(ephemeral).lower(),
            "spot": str(spot).lower(),
            "image": image,
            "created": timestamp,
            "last-used": timestamp,
        },
        "properties": properties,
    }


async def put_with_fallback(
    name: str, size: str, image: str, ephemeral: bool, spot: bool
) -> tuple[object, bool]:
    subnet = await azure.ensure_network()
    nic = await azure.create_nic(f"{name}-nic", subnet)
    try:
        return await azure.put_vm(name, vm_body(name, size, image, ephemeral, spot, nic)), spot
    except AzureError as exc:
        if not spot or not capacity_error(exc):
            raise
        log.info("spot %s unavailable for %s, using regular priority: %s", size, name, exc)
        return await azure.put_vm(name, vm_body(name, size, image, ephemeral, False, nic)), False


async def provision(name: str, resp, size: str, image: str, ephemeral: bool, spot: bool) -> None:
    progress[name] = {"phase": "provisioning", "spot": spot}
    try:
        try:
            await azure.wait(resp)
        except AzureError as exc:
            if not spot or not capacity_error(exc):
                raise
            progress[name] = {
                "phase": "retrying without spot",
                "spot": False,
                "spot_error": str(exc),
            }
            await azure.wait(await azure.delete_vm(name))
            resp, spot = await put_with_fallback(name, size, image, ephemeral, False)
            await azure.wait(resp)
        progress[name] = {"phase": "booting", "spot": spot}
        try:
            await azure.schedule_shutdown(name, SHUTDOWN_TIME, SHUTDOWN_TIME_ZONE)
        except AzureError as exc:
            log.warning("auto-shutdown schedule for %s failed: %s", name, exc)
    except Exception as exc:
        log.exception("provisioning %s failed", name)
        progress[name] = {"phase": "failed", "error": str(exc)}


async def repair(name: str) -> None:
    await tag(name, {"repair": now().isoformat()})
    progress[name] = {"phase": "bootstrapping with Run Command"}
    try:
        resp = await azure.action(
            name,
            "runCommand",
            {
                "commandId": "RunPowerShellScript",
                "script": [
                    "Copy-Item -Force C:\\AzureData\\CustomData.bin C:\\AzureData\\bootstrap.ps1",
                    "& C:\\AzureData\\bootstrap.ps1 *> C:\\AzureData\\bootstrap.log",
                    "Get-Content C:\\AzureData\\bootstrap.log",
                ],
            },
        )
        result = await azure.wait(resp)
        log.info("bootstrap Run Command on %s: %s", name, result)
        progress[name] = {"phase": "rebooting after bootstrap"}
    except Exception as exc:
        progress[name] = {"phase": "failed", "error": f"Run Command bootstrap failed: {exc}"}


async def stop(name: str, ephemeral: bool) -> None:
    await hub.drop(name)
    if ephemeral:
        await azure.delete_vm(name)
    else:
        await azure.action(name, "deallocate")


async def sweep() -> None:
    while True:
        await asyncio.sleep(60)
        if not azure.configured:
            continue
        try:
            for vm in await azure.list_vms():
                name = vm["name"]
                tags = vm.get("tags") or {}
                ephemeral = tags.get("ephemeral") == "true"
                state = power_state(vm)
                if state == "deallocated" and ephemeral:
                    log.info("deleting deallocated ephemeral devbox %s", name)
                    await azure.delete_vm(name)
                elif state == "stopped":
                    log.info("deallocating stopped devbox %s", name)
                    await azure.action(name, "deallocate")
                elif state == "running":
                    used = last_used.get(name)
                    with contextlib.suppress(KeyError, ValueError):
                        used = max(
                            used or datetime.min.replace(tzinfo=UTC),
                            datetime.fromisoformat(tags["last-used"]),
                        )
                    if used is None:
                        last_used[name] = now()
                    elif now() - used > timedelta(minutes=IDLE_MINUTES):
                        log.info("stopping idle devbox %s, last used %s", name, used)
                        await stop(name, ephemeral)
        except Exception:
            log.exception("idle sweep failed")


@tool()
async def devbox_create(
    name: str,
    shape: Literal["XL", "L", "M", "S"] = "S",
    imageName: str = "windows-server-2025",
    ephemeral: bool = False,
    spot: bool = True,
) -> dict:
    """Create and start a Windows devbox asynchronously; call devbox_wait_ready before using
    devbox_exec or the GUI tools. Omit optional parameters unless the user asks for specific
    values.

    Args:
        name: Name of the devbox, 1-15 lowercase letters, digits or hyphens
        shape: Machine shape; S is 2 vCPU/8 GiB, M 4/16, L 8/32, XL 16/64
        imageName: An image from devbox_image_list, or a publisher:offer:sku:version URN
        ephemeral: Delete the devbox (and its disk) when it stops, instead of deallocating it
        spot: Use a spot VM, falling back to regular priority when spot capacity or quota is
            unavailable; spot devboxes can be evicted at any time
    """
    check_name(name)
    existing = await azure.list_vms()
    if any(vm["name"] == name for vm in existing):
        raise ValueError(f"devbox {name} already exists")
    if len(existing) >= MAX_DEVBOXES:
        raise ValueError(
            f"limit of {MAX_DEVBOXES} devboxes reached; delete one first: "
            + ", ".join(vm["name"] for vm in existing)
        )
    size = SHAPES[shape]
    resp, spot = await put_with_fallback(name, size, imageName, ephemeral, spot)
    touch(name)
    spawn(provision(name, resp, size, imageName, ephemeral, spot))
    return {
        "name": name,
        "state": "STARTING",
        "size": size,
        "image": imageName,
        "ephemeral": ephemeral,
        "spot": spot,
    }


@tool()
async def devbox_list(maxEntries: int = 50) -> dict:
    """List Windows devboxes, ordered by most recently used.

    Args:
        maxEntries: Maximum number of devboxes to return
    """
    devboxes = []
    for vm in await azure.list_vms():
        tags = vm.get("tags") or {}
        devboxes.append(
            {
                "name": vm["name"],
                "state": power_state(vm),
                "agent": vm["name"] in hub.agents,
                "ephemeral": tags.get("ephemeral") == "true",
                "spot": vm.get("properties", {}).get("priority") == "Spot",
                "image": tags.get("image"),
                "lastUsed": last_used[vm["name"]].isoformat()
                if vm["name"] in last_used
                else tags.get("last-used", ""),
                **({"progress": progress[vm["name"]]} if vm["name"] in progress else {}),
            }
        )
    devboxes.sort(key=lambda d: d["lastUsed"], reverse=True)
    return {"devboxes": devboxes[:maxEntries]}


@tool()
async def devbox_start(name: str) -> dict:
    """Start a stopped devbox asynchronously. After this returns, call devbox_wait_ready until it
    reports ready.

    Args:
        name: Name of the devbox
    """
    touch(name)
    progress[name] = {"phase": "starting"}
    spawn(start(name))
    return {"name": name, "state": "STARTING"}


async def start(name: str) -> None:
    try:
        await azure.wait(await azure.action(name, "start"))
        progress[name] = {"phase": "booting"}
    except Exception as exc:
        progress[name] = {"phase": "failed", "error": str(exc)}


@tool()
async def devbox_stop(name: str) -> dict:
    """Stop (deallocate) a devbox so it stops billing for compute; its disk is kept. An ephemeral
    devbox is deleted instead.

    Args:
        name: Name of the devbox
    """
    vm = await azure.get_vm(name)
    if not vm:
        raise ValueError(f"no devbox named {name}")
    ephemeral = (vm.get("tags") or {}).get("ephemeral") == "true"
    await stop(name, ephemeral)
    progress.pop(name, None)
    return {"name": name, "state": "DELETING" if ephemeral else "STOPPING"}


@tool()
async def devbox_delete(name: str) -> dict:
    """Delete a devbox with its disk and network interface.

    Args:
        name: Name of the devbox
    """
    await hub.drop(name)
    progress.pop(name, None)
    await azure.delete_vm(name)
    return {"name": name, "state": "DELETING"}


@tool()
async def devbox_wait_ready(name: str, timeoutSeconds: int = 30) -> dict:
    """Wait for a devbox and its desktop agent to become ready; call again when the state is
    STARTING. A new devbox takes about 3-6 minutes.

    Args:
        name: Name of the devbox
        timeoutSeconds: Maximum time to wait per call; capped at 45 seconds
    """
    touch(name)
    if name in hub.agents:
        return {"name": name, "state": "READY", **hub.agents[name].hello}
    status = progress.get(name, {})
    if status.get("phase") == "failed":
        return {"name": name, "state": "FAILED", "error": status.get("error")}
    vm = await azure.get_vm(name)
    if not vm:
        raise ValueError(f"no devbox named {name}")
    state = power_state(vm)
    tags = vm.get("tags") or {}
    if state in ("deallocated", "stopped") and not status:
        return {"name": name, "state": "STOPPED", "detail": "call devbox_start"}
    with contextlib.suppress(KeyError, ValueError):
        created = datetime.fromisoformat(tags["created"])
        if (
            state == "running"
            and "bootstrapped" not in tags
            and "repair" not in tags
            and now() - created > timedelta(minutes=10)
        ):
            spawn(repair(name))
    if await hub.wait(name, max(1, min(timeoutSeconds, 45))):
        if "bootstrapped" not in tags:
            spawn(tag(name, {"bootstrapped": now().isoformat()}))
        progress.pop(name, None)
        return {"name": name, "state": "READY", **hub.agents[name].hello}
    return {"name": name, "state": "STARTING", "power": state, **status}


def tail(text: str) -> str:
    if len(text) <= OUTPUT_LIMIT:
        return text
    return f"[{len(text) - OUTPUT_LIMIT} characters cut]\n" + text[-OUTPUT_LIMIT:]


@tool()
async def devbox_exec(
    name: str,
    command: str | None = None,
    args: list[str] | None = None,
    execID: str | None = None,
    waitSeconds: int = 10,
    cwd: str | None = None,
) -> dict:
    """Execute a command after devbox_wait_ready reports ready, then observe it for up to
    waitSeconds. If it is still running, call this tool again with its execID and no command.
    There is no shell: run powershell with ["-NoProfile", "-Command", "..."] for pipelines.
    Each call returns only the output produced since the previous call.

    Args:
        name: Name of the devbox
        command: Executable to start; omit when observing an existing execution
        args: Arguments passed directly to the executable
        execID: Existing execution to observe instead of starting a command
        waitSeconds: Maximum time to observe the execution; defaults to 10 and is capped at 45
        cwd: Working directory; defaults to the user's profile
    """
    agent = hub.get(name)
    touch(name)
    wait = max(0, min(waitSeconds, 45))
    if command:
        started = await agent.call(
            "exec", command=command, args=subprocess.list2cmdline(args or []), cwd=cwd
        )
        execID = started["exec_id"]
    elif not execID:
        raise ValueError("pass a command to start or an execID to observe")
    result = await agent.call("exec_poll", timeout=wait + 30, exec_id=execID, wait_ms=wait * 1000)
    result["stdout"] = tail(result["stdout"])
    result["stderr"] = tail(result["stderr"])
    return {"execID": result.pop("exec_id"), **result}


@tool()
async def devbox_exec_kill(name: str, execID: str) -> dict:
    """Kill a running execution and its child processes.

    Args:
        name: Name of the devbox
        execID: Execution to kill
    """
    touch(name)
    result = await hub.get(name).call("exec_kill", timeout=30, exec_id=execID)
    return {"execID": result.pop("exec_id"), **result}


@tool()
async def devbox_image_list() -> dict:
    """List devbox images and shapes."""
    return {
        "images": {name: ":".join(ref.values()) for name, ref in IMAGES.items()},
        "shapes": SHAPES,
        "location": azure.location,
    }


@tool()
async def devbox_file_read(name: str, path: str, offset: int = 0, length: int = 262144) -> dict:
    """Read a file on a devbox. UTF-8 files come back as text, others as base64.

    Args:
        name: Name of the devbox
        path: Windows path of the file
        offset: Byte offset to start reading from
        length: Maximum number of bytes to read; capped at 4 MiB
    """
    touch(name)
    result = await hub.get(name).call(
        "file_read", path=path, offset=offset, length=max(0, min(length, 4 * 1024 * 1024))
    )
    data = base64.b64decode(result.pop("data"))
    try:
        result |= {"encoding": "text", "content": data.decode("utf-8-sig")}
    except UnicodeDecodeError:
        result |= {"encoding": "base64", "content": base64.b64encode(data).decode()}
    return result | {"read": len(data)}


@tool()
async def devbox_file_write(
    name: str,
    path: str,
    content: str,
    encoding: Literal["text", "base64"] = "text",
    append: bool = False,
) -> dict:
    """Write a file on a devbox, creating parent directories.

    Args:
        name: Name of the devbox
        path: Windows path of the file
        content: File content, UTF-8 text or base64
        encoding: How content is encoded
        append: Append to the file instead of replacing it
    """
    touch(name)
    data = content.encode() if encoding == "text" else base64.b64decode(content)
    return await hub.get(name).call(
        "file_write", path=path, data=base64.b64encode(data).decode(), append=append
    )


@tool()
async def devbox_file_list(name: str, path: str = "C:\\Users\\devbox") -> dict:
    """List a directory on a devbox.

    Args:
        name: Name of the devbox
        path: Windows path of the directory
    """
    touch(name)
    return await hub.get(name).call("file_list", path=path)


async def screenshot(name: str) -> list:
    shot = await hub.get(name).call("screenshot")
    return [
        Image(data=base64.b64decode(shot["png"]), format="png"),
        {"width": shot["width"], "height": shot["height"]},
    ]


@tool(structured_output=False)
async def devbox_screenshot(name: str) -> list:
    """Take a screenshot of a devbox's desktop. Coordinates for devbox_mouse are pixels in this
    image.

    Args:
        name: Name of the devbox
    """
    touch(name)
    return await screenshot(name)


@tool(structured_output=False)
async def devbox_mouse(
    name: str,
    action: Literal[
        "move",
        "left_click",
        "double_click",
        "triple_click",
        "right_click",
        "middle_click",
        "left_down",
        "left_up",
        "drag",
        "scroll",
        "position",
    ],
    x: int = -1,
    y: int = -1,
    toX: int = -1,
    toY: int = -1,
    scrollX: int = 0,
    scrollY: int = 0,
    screenshot_after: bool = True,
) -> list:
    """Move, click, drag or scroll the mouse on a devbox's desktop.

    Args:
        name: Name of the devbox
        action: Mouse action; clicks and scrolls happen at x,y (or the current position)
        x: Screen x in pixels; omit to keep the current position
        y: Screen y in pixels; omit to keep the current position
        toX: Drag end x
        toY: Drag end y
        scrollX: Wheel clicks right (negative: left)
        scrollY: Wheel clicks down (negative: up)
        screenshot_after: Return a screenshot after the action
    """
    touch(name)
    result = await hub.get(name).call(
        "mouse", action=action, x=x, y=y, x2=toX, y2=toY, dx=scrollX, dy=scrollY
    )
    if not screenshot_after:
        return [result]
    await asyncio.sleep(0.5)
    return [result, *await screenshot(name)]


@tool(structured_output=False)
async def devbox_keyboard(
    name: str,
    action: Literal["type", "key"],
    text: str,
    repeat: int = 1,
    screenshot_after: bool = True,
) -> list:
    """Type text or press keys on a devbox's desktop, into the focused window.

    Args:
        name: Name of the devbox
        action: type sends text as Unicode characters; key presses space-separated combos
            such as "ctrl+s", "alt+f4", "win+r" or "enter"
        text: Text to type, or key combos to press
        repeat: Times to press each key combo
        screenshot_after: Return a screenshot after the action
    """
    touch(name)
    result = await hub.get(name).call(
        "keyboard", timeout=120, action=action, text=text, repeat=repeat
    )
    if not screenshot_after:
        return [result]
    await asyncio.sleep(0.5)
    return [result, *await screenshot(name)]


@tool()
async def devbox_windows(
    name: str,
    action: Literal["list", "focus", "minimize", "maximize", "restore", "close"] = "list",
    handle: int = 0,
) -> dict:
    """List the top-level windows on a devbox's desktop, or focus, resize or close one.

    Args:
        name: Name of the devbox
        action: list, or an action on the window with this handle
        handle: Window handle from a list result
    """
    touch(name)
    return await hub.get(name).call("windows", action=action, handle=handle)


def main() -> None:
    mcp_app = mcp.streamable_http_app(
        stateless_http=True,
        transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
    )

    @contextlib.asynccontextmanager
    async def lifespan(app):
        spawn(sweep())
        async with mcp_app.router.lifespan_context(app):
            yield

    app = Starlette(
        lifespan=lifespan,
        routes=[
            WebSocketRoute("/agent/{name}", endpoint=hub.endpoint),
            Mount("/", app=mcp_app),
        ],
    )
    uvicorn.run(
        app,
        host=os.environ.get("HOST", "0.0.0.0"),
        port=int(os.environ.get("PORT", "8000")),
        ws_max_size=64 * 1024 * 1024,
    )


if __name__ == "__main__":
    main()
