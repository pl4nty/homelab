"""MCP server with the Namespace devbox tool surface, backed by crabbox on Azure, Namespace and Sprites."""

import asyncio
import base64
import contextlib
import functools
import json
import logging
import os
import re
import secrets
import shlex
import shutil
import tempfile
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Literal

import uvicorn
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.server.transport_security import TransportSecuritySettings
from starlette.applications import Starlette
from starlette.routing import Mount

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)

DATA = Path(os.environ.get("DATA_DIR", "/data"))
CRABBOX = os.environ.get("CRABBOX", "crabbox")
MAX_DEVBOXES = int(os.environ.get("MAX_DEVBOXES", "4"))
MAX_TTL_MINUTES = int(os.environ.get("MAX_TTL_MINUTES", "480"))
MAX_IDLE_MINUTES = int(os.environ.get("MAX_IDLE_MINUTES", "120"))
OUTPUT_LIMIT = 64 * 1024
FILE_LIMIT = 4 * 1024 * 1024

AZURE_SIZES = {
    "S": "Standard_D2as_v6",
    "M": "Standard_D4as_v6",
    "L": "Standard_D8as_v6",
    "XL": "Standard_D16as_v6",
}
CHECKPOINT_ID = re.compile(r"\bid=(chk_[0-9a-f]+)")


@dataclass
class Box:
    name: str
    backend: str
    os: str
    size: str
    persistent: bool
    ttl_minutes: int
    idle_minutes: int
    state: str = "STARTING"
    created: str = ""
    started: str = ""
    last_used: str = ""
    checkpoint: str = ""
    error: str = ""
    log: list[str] = field(default_factory=list)

    def flags(self) -> list[str]:
        if self.backend == "azure":
            return [
                "--provider",
                "azure",
                "--target",
                self.os,
                "--type",
                AZURE_SIZES[self.size],
                "--market",
                "spot",
            ]
        if self.backend == "namespace":
            return ["--provider", "namespace-devbox", "--namespace-size", self.size]
        return ["--provider", self.backend]

    def lease_flags(self) -> list[str]:
        # persistent boxes outlive one session, so crabbox's own deadline only bounds a session
        ttl = MAX_TTL_MINUTES if self.persistent else self.ttl_minutes
        idle = MAX_IDLE_MINUTES if self.persistent else self.idle_minutes
        flags = ["--slug", self.name, "--ttl", f"{ttl}m", "--idle-timeout", f"{idle}m"]
        if self.backend == "namespace":
            flags += ["--namespace-auto-stop-idle-timeout", f"{self.idle_minutes}m"]
            if not self.persistent:
                flags.append("--namespace-delete-on-release")
        return flags

    @property
    def workdir(self) -> Path:
        return DATA / "boxes" / self.name

    def deadline(self) -> datetime | None:
        if self.state != "READY":
            return None
        return min(
            datetime.fromisoformat(self.started) + timedelta(minutes=self.ttl_minutes),
            datetime.fromisoformat(self.last_used) + timedelta(minutes=self.idle_minutes),
        )


@dataclass
class Exec:
    proc: asyncio.subprocess.Process
    dir: tempfile.TemporaryDirectory
    log: asyncio.Task
    sent: dict[str, int] = field(default_factory=lambda: {"stdout": 0, "stderr": 0})

    def read(self, stream: str) -> str:
        path = Path(self.dir.name) / stream
        if not path.exists():
            return ""
        with path.open("rb") as f:
            f.seek(self.sent[stream])
            data = f.read()
        self.sent[stream] += len(data)
        return data.decode(errors="replace")


boxes: dict[str, Box] = {}
execs: dict[str, Exec] = {}
locks: dict[str, asyncio.Lock] = {}
tasks: set[asyncio.Task] = set()
logins: dict[str, asyncio.subprocess.Process] = {}

mcp = MCPServer(
    name="crabbox",
    instructions=(
        "Linux and Windows devboxes on Azure spot VMs, Namespace devboxes and Fly.io Sprites, "
        "managed by crabbox. Create with devbox_create, poll devbox_wait_ready, then use "
        "devbox_exec and the file tools. Every devbox has a hard TTL and an idle timeout: an "
        "ephemeral devbox is deleted when either passes, a persistent one is suspended and keeps "
        "its disk. Delete devboxes when the task is done."
    ),
)


def tool(**kwargs):
    def register(fn):
        @functools.wraps(fn)
        async def wrapper(*args, **kw):
            try:
                return await fn(*args, **kw)
            except (ValueError, KeyError, TimeoutError, RuntimeError) as exc:
                raise ToolError(str(exc)) from exc

        return mcp.tool(**kwargs)(wrapper)

    return register


def spawn(coro) -> None:
    task = asyncio.create_task(coro)
    tasks.add(task)
    task.add_done_callback(tasks.discard)


def now() -> datetime:
    return datetime.now(UTC)


def save() -> None:
    path = DATA / "boxes.json"
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps([asdict(box) for box in boxes.values()], indent=2))
    tmp.replace(path)


def load() -> None:
    path = DATA / "boxes.json"
    if path.exists():
        for item in json.loads(path.read_text()):
            box = Box(**item)
            if box.state == "STARTING":
                box.state, box.error = "FAILED", "the server restarted while it was starting"
            boxes[box.name] = box


def get(name: str) -> Box:
    if name not in boxes:
        raise ValueError(f"no devbox named {name}")
    return boxes[name]


def touch(box: Box) -> None:
    box.last_used = now().isoformat()
    save()


def lock(name: str) -> asyncio.Lock:
    return locks.setdefault(name, asyncio.Lock())


def tail(text: str) -> str:
    if len(text) <= OUTPUT_LIMIT:
        return text
    return f"[{len(text) - OUTPUT_LIMIT} characters cut]\n" + text[-OUTPUT_LIMIT:]


async def crabbox(box: Box, *args: str, timeout: float = 1800) -> tuple[int, str, str]:
    box.workdir.mkdir(parents=True, exist_ok=True)
    proc = await asyncio.create_subprocess_exec(
        CRABBOX,
        *args,
        cwd=box.workdir,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout)
    except TimeoutError:
        proc.kill()
        await proc.wait()
        raise TimeoutError(f"crabbox {args[0]} timed out after {timeout:.0f}s") from None
    stdout, stderr = out.decode(errors="replace"), err.decode(errors="replace")
    box.log = (box.log + [f"$ crabbox {shlex.join(args)} -> {proc.returncode}"])[-20:]
    if proc.returncode:
        log.warning("crabbox %s for %s exited %s: %s", args[0], box.name, proc.returncode, stderr)
    return proc.returncode, stdout, stderr


async def must(box: Box, *args: str, timeout: float = 1800) -> str:
    code, out, err = await crabbox(box, *args, timeout=timeout)
    if code:
        raise RuntimeError(f"crabbox {args[0]} exited {code}: {tail(err.strip() or out.strip())}")
    return out + err


async def provision(box: Box) -> None:
    try:
        if box.checkpoint:
            await must(box, "checkpoint", "fork", box.checkpoint, *box.flags(), *box.lease_flags())
        else:
            await must(box, "warmup", *box.flags(), *box.lease_flags())
        box.state, box.error = "READY", ""
        box.started = box.last_used = now().isoformat()
    except Exception as exc:
        log.exception("provisioning %s failed", box.name)
        box.state, box.error = "FAILED", str(exc)
    save()


async def resume(box: Box) -> None:
    if box.backend == "azure":
        await provision(box)
        return
    try:
        await must(box, "run", *box.flags(), "--id", box.name, "--no-sync", "--", "true")
        box.state, box.error = "READY", ""
        box.started = box.last_used = now().isoformat()
    except Exception as exc:
        box.state, box.error = "FAILED", str(exc)
    save()


async def suspend(box: Box) -> None:
    """Free a persistent devbox's compute and keep its disk."""
    async with lock(box.name):
        box.state = "SUSPENDING"
        save()
        try:
            if box.backend == "azure":
                out = await must(
                    box,
                    "checkpoint",
                    "create",
                    *box.flags(),
                    "--id",
                    box.name,
                    "--mode",
                    "native",
                    "--strategy",
                    "disk-snapshot",
                    "--no-reboot=false",
                    "--wait",
                    timeout=3600,
                )
                match = CHECKPOINT_ID.search(out)
                if not match:
                    raise RuntimeError(f"no checkpoint id in crabbox output: {tail(out)}")
                old, box.checkpoint = box.checkpoint, match[1]
                save()
                await must(box, "stop", *box.flags(), box.name)
                if old:
                    await crabbox(box, "checkpoint", "delete", old)
            elif box.backend == "namespace":
                await must(box, "stop", *box.flags(), box.name)
            box.state, box.error = "SUSPENDED", ""
        except Exception as exc:
            log.exception("suspending %s failed", box.name)
            box.state, box.error = "FAILED", f"suspend failed: {exc}"
        save()


async def destroy(box: Box) -> None:
    async with lock(box.name):
        suspended, box.state = box.state == "SUSPENDED", "DELETING"
        save()
        for exec_id in [k for k in execs if k.startswith(f"{box.name}:")]:
            with contextlib.suppress(ProcessLookupError):
                execs[exec_id].proc.kill()
            finish(exec_id)
        if box.backend == "namespace" and box.persistent:
            await crabbox(box, "stop", *box.flags(), "--namespace-delete-on-release", box.name)
        elif not (box.backend == "azure" and suspended):
            await crabbox(box, "stop", *box.flags(), box.name)
        if box.checkpoint:
            await crabbox(box, "checkpoint", "delete", box.checkpoint)
        boxes.pop(box.name, None)
        save()


async def expire() -> None:
    sweeps = 0
    while True:
        await asyncio.sleep(60)
        for box in list(boxes.values()):
            deadline = box.deadline()
            if deadline is None or now() < deadline or lock(box.name).locked():
                continue
            if any(k.startswith(f"{box.name}:") for k in execs):
                continue
            log.info("devbox %s passed its deadline %s", box.name, deadline.isoformat())
            if box.persistent:
                spawn(suspend(box))
            else:
                spawn(destroy(box))
        sweeps += 1
        if sweeps % 10 == 0 and os.environ.get("AZURE_CLIENT_SECRET"):
            spawn(cleanup())


async def cleanup() -> None:
    proc = await asyncio.create_subprocess_exec(
        CRABBOX,
        "cleanup",
        "--provider",
        "azure",
        cwd=DATA,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    out, _ = await proc.communicate()
    if proc.returncode:
        log.warning("crabbox cleanup exited %s: %s", proc.returncode, out.decode()[-2000:])


def check_name(name: str) -> None:
    if not re.fullmatch(r"[a-z][a-z0-9-]{0,30}", name):
        raise ValueError(
            "name must be 1-31 lowercase letters, digits or hyphens, starting with a letter"
        )


def summary(box: Box) -> dict:
    deadline = box.deadline()
    return {
        "name": box.name,
        "state": box.state,
        "backend": box.backend,
        "os": box.os,
        "size": box.size,
        "persistent": box.persistent,
        "lastUsed": box.last_used,
        **({"deadline": deadline.isoformat()} if deadline else {}),
        **({"error": box.error} if box.error else {}),
    }


@tool()
async def devbox_create(
    name: str,
    backend: Literal["azure", "namespace", "sprites"] = "sprites",
    os: Literal["linux", "windows"] = "linux",
    shape: Literal["S", "M", "L", "XL"] = "S",
    ttlMinutes: int = 60,
    idleMinutes: int = 30,
    persistent: bool = False,
) -> dict:
    """Create a devbox asynchronously; call devbox_wait_ready before devbox_exec. Omit optional
    parameters unless the task needs specific values.

    Args:
        name: Name of the devbox, 1-31 lowercase letters, digits or hyphens
        backend: sprites is a Fly.io microVM (Linux, no compute billing while idle);
            namespace is a Namespace devbox (Linux); azure is a spot VM (Linux amd64 or
            Windows Server 2022)
        os: windows needs backend azure
        shape: Machine size. azure: S 2 vCPU/8 GiB, M 4/16, L 8/32, XL 16/64. namespace: S, M,
            L, XL devbox sizes. Ignored by sprites
        ttlMinutes: Hard limit on running time; the devbox is deleted, or suspended if
            persistent, once it passes
        idleMinutes: The devbox is deleted, or suspended if persistent, after this long without
            a tool call
        persistent: Keep the disk across suspends; devbox_start resumes it. Azure persistence
            is a disk snapshot taken at suspend time
    """
    check_name(name)
    if os == "windows" and backend != "azure":
        raise ValueError("windows devboxes need backend azure")
    if not 1 <= ttlMinutes <= MAX_TTL_MINUTES:
        raise ValueError(f"ttlMinutes must be between 1 and {MAX_TTL_MINUTES}")
    if not 1 <= idleMinutes <= MAX_IDLE_MINUTES:
        raise ValueError(f"idleMinutes must be between 1 and {MAX_IDLE_MINUTES}")
    if name in boxes:
        raise ValueError(f"devbox {name} already exists; use devbox_start or devbox_delete")
    running = [b.name for b in boxes.values() if b.state not in ("SUSPENDED", "FAILED")]
    if len(running) >= MAX_DEVBOXES:
        raise ValueError(
            f"limit of {MAX_DEVBOXES} running devboxes reached; stop or delete one first: "
            + ", ".join(running)
        )
    box = Box(name, backend, os, shape, persistent, ttlMinutes, idleMinutes)
    box.created = box.last_used = now().isoformat()
    boxes[name] = box
    save()
    spawn(provision(box))
    return summary(box)


@tool()
async def devbox_list() -> dict:
    """List devboxes with their state, deadline and last use."""
    return {"devboxes": [summary(box) for box in boxes.values()]}


@tool()
async def devbox_wait_ready(name: str, timeoutSeconds: int = 30) -> dict:
    """Wait for a devbox to become ready; call again while the state is STARTING. Sprites and
    Namespace take under a minute, Azure Linux about 2 minutes, Azure Windows 5-10 minutes.

    Args:
        name: Name of the devbox
        timeoutSeconds: Maximum time to wait per call; capped at 45 seconds
    """
    box = get(name)
    end = now() + timedelta(seconds=max(1, min(timeoutSeconds, 45)))
    while box.state in ("STARTING", "RESUMING") and now() < end:
        await asyncio.sleep(1)
    result = summary(box)
    if box.state == "FAILED":
        result["log"] = box.log
    return result


@tool()
async def devbox_start(name: str) -> dict:
    """Resume a suspended persistent devbox asynchronously, then call devbox_wait_ready.

    Args:
        name: Name of the devbox
    """
    box = get(name)
    if box.state not in ("SUSPENDED", "FAILED"):
        raise ValueError(f"devbox {name} is {box.state}")
    box.state = "RESUMING"
    save()
    spawn(resume(box))
    return summary(box)


@tool()
async def devbox_stop(name: str) -> dict:
    """Stop a devbox: a persistent one is suspended and keeps its disk, an ephemeral one is
    deleted.

    Args:
        name: Name of the devbox
    """
    box = get(name)
    spawn(suspend(box) if box.persistent else destroy(box))
    return {"name": name, "state": "SUSPENDING" if box.persistent else "DELETING"}


@tool()
async def devbox_delete(name: str) -> dict:
    """Delete a devbox with its disk and any snapshot.

    Args:
        name: Name of the devbox
    """
    spawn(destroy(get(name)))
    return {"name": name, "state": "DELETING"}


def ready(name: str) -> Box:
    box = get(name)
    if box.state != "READY":
        raise ValueError(
            f"devbox {name} is {box.state}"
            + ("; call devbox_start" if box.state == "SUSPENDED" else "")
        )
    touch(box)
    return box


def finish(execID: str) -> None:
    execs.pop(execID).dir.cleanup()
    name = execID.split(":")[0]
    if name in boxes:
        shutil.rmtree(boxes[name].workdir / ".crabbox" / "captures", ignore_errors=True)


@tool()
async def devbox_exec(
    name: str,
    command: str | None = None,
    execID: str | None = None,
    waitSeconds: int = 10,
) -> dict:
    """Run a shell command after devbox_wait_ready reports READY, then observe it for up to
    waitSeconds. If it is still running, call again with its execID and no command. Each call
    returns only the output produced since the previous call. Linux runs it in a Bash login
    shell; Windows runs it in PowerShell.

    Args:
        name: Name of the devbox
        command: Shell command to start; omit when observing an existing execution
        execID: Existing execution to observe instead of starting a command
        waitSeconds: Maximum time to observe the execution; defaults to 10 and is capped at 45
    """
    box = ready(name)
    if command:
        execID = f"{name}:{secrets.token_hex(4)}"
        out = tempfile.TemporaryDirectory(dir=DATA / "tmp")
        proc = await asyncio.create_subprocess_exec(
            CRABBOX,
            "run",
            *box.flags(),
            "--id",
            name,
            "--no-sync",
            "--capture-stdout",
            str(Path(out.name) / "stdout"),
            "--capture-stderr",
            str(Path(out.name) / "stderr"),
            "--shell",
            command,
            cwd=box.workdir,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        execs[execID] = Exec(proc, out, asyncio.create_task(proc.stdout.read()))
    elif not execID or execID not in execs:
        raise ValueError("pass a command to start, or the execID of a running execution")
    job = execs[execID]
    with contextlib.suppress(TimeoutError):
        await asyncio.wait_for(asyncio.shield(job.proc.wait()), max(0, min(waitSeconds, 45)))
    result = {
        "execID": execID,
        "running": job.proc.returncode is None,
        "stdout": tail(job.read("stdout")),
        "stderr": tail(job.read("stderr")),
    }
    if job.proc.returncode is not None:
        result["exitCode"] = job.proc.returncode
        log_text = (await job.log).decode(errors="replace")
        if job.proc.returncode and "remote command exited" not in log_text:
            result["crabbox"] = "\n".join(log_text.splitlines()[-15:])
        finish(execID)
    touch(box)
    return result


@tool()
async def devbox_exec_kill(name: str, execID: str) -> dict:
    """Kill a running execution.

    Args:
        name: Name of the devbox
        execID: Execution to kill
    """
    get(name)
    job = execs.get(execID)
    if not job:
        raise ValueError(f"no running execution {execID}")
    with contextlib.suppress(ProcessLookupError):
        job.proc.kill()
    await job.proc.wait()
    finish(execID)
    return {"execID": execID, "killed": True}


@tool()
async def devbox_file_write(
    name: str, path: str, content: str, encoding: Literal["utf-8", "base64"] = "utf-8"
) -> dict:
    """Write a file on a devbox, replacing it if it exists. Parent directories must exist.

    Args:
        name: Name of the devbox
        path: Absolute path on the devbox
        content: File content
        encoding: base64 for binary content
    """
    box = ready(name)
    data = base64.b64decode(content) if encoding == "base64" else content.encode()
    if len(data) > FILE_LIMIT:
        raise ValueError(f"files are limited to {FILE_LIMIT} bytes")
    with tempfile.TemporaryDirectory(dir=DATA / "tmp") as tmp:
        local = Path(tmp) / "file"
        local.write_bytes(data)
        await must(box, "cp", *box.flags(), "--id", name, str(local), f"SANDBOX:{path}")
    return {"path": path, "bytes": len(data)}


@tool()
async def devbox_file_read(
    name: str, path: str, encoding: Literal["utf-8", "base64"] = "utf-8"
) -> dict:
    """Read a file from a devbox.

    Args:
        name: Name of the devbox
        path: Absolute path on the devbox
        encoding: base64 for binary content
    """
    box = ready(name)
    with tempfile.TemporaryDirectory(dir=DATA / "tmp") as tmp:
        local = Path(tmp) / "file"
        await must(box, "cp", *box.flags(), "--id", name, f"SANDBOX:{path}", str(local))
        data = local.read_bytes()
    if len(data) > FILE_LIMIT:
        raise ValueError(f"{path} is {len(data)} bytes; files are limited to {FILE_LIMIT}")
    if encoding == "base64":
        return {"path": path, "content": base64.b64encode(data).decode()}
    return {"path": path, "content": data.decode(errors="replace")}


@tool()
async def namespace_login() -> dict:
    """Sign the Namespace devbox CLI in. Returns a URL for the user to open and approve; call
    again afterwards to check that the login completed."""
    proc = await asyncio.create_subprocess_exec(
        "devbox",
        "auth",
        "check-login",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    out, _ = await proc.communicate()
    if proc.returncode == 0:
        return {"loggedIn": True, "detail": out.decode().strip()}
    pending = logins.get("namespace")
    if pending and pending.returncode is None:
        return {"loggedIn": False, "detail": "a login is waiting for approval at the URL given"}
    proc = logins["namespace"] = await asyncio.create_subprocess_exec(
        "devbox",
        "login",
        "--browser=false",
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    text = ""
    with contextlib.suppress(TimeoutError):
        async with asyncio.timeout(20):
            while "Verification code" not in text:
                line = await proc.stdout.readline()
                if not line:
                    break
                text += line.decode()
    spawn(proc.wait())
    return {"loggedIn": False, "detail": text.strip()}


def main() -> None:
    for path in (DATA / "boxes", DATA / "tmp", Path.home()):
        path.mkdir(parents=True, exist_ok=True)
    load()
    mcp_app = mcp.streamable_http_app(
        stateless_http=True,
        transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
    )

    @contextlib.asynccontextmanager
    async def lifespan(app):
        spawn(expire())
        async with mcp_app.router.lifespan_context(app):
            yield

    uvicorn.run(
        Starlette(lifespan=lifespan, routes=[Mount("/", app=mcp_app)]),
        host=os.environ.get("HOST", "0.0.0.0"),
        port=int(os.environ.get("PORT", "8000")),
    )


if __name__ == "__main__":
    main()
