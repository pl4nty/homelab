"""Drive the tools against a static SSH host: STATIC_HOST, STATIC_PORT and STATIC_USER."""

import asyncio
import os
import sys
import tempfile
from pathlib import Path

os.environ.setdefault("DATA_DIR", tempfile.mkdtemp())
sys.path.insert(0, str(Path(__file__).parent.parent))

import main

STATIC = [
    "--provider",
    "ssh",
    "--static-host",
    os.environ.get("STATIC_HOST", "127.0.0.1"),
    "--static-port",
    os.environ.get("STATIC_PORT", "22"),
    "--static-user",
    os.environ.get("STATIC_USER", "root"),
]
main.Box.flags = lambda self: STATIC


async def run() -> None:
    for path in ("boxes", "tmp"):
        (main.DATA / path).mkdir(parents=True, exist_ok=True)
    print(await main.devbox_create("e2e", ttlMinutes=2, idleMinutes=1))
    while (status := await main.devbox_wait_ready("e2e"))["state"] == "STARTING":
        pass
    print(status)
    assert status["state"] == "READY", status

    result = await main.devbox_exec("e2e", command="echo out; echo err >&2; exit 3", waitSeconds=30)
    print(result)
    assert result["exitCode"] == 3 and result["stdout"] == "out\n", result
    assert result["stderr"] == "err\n" and "crabbox" not in result, result

    result = await main.devbox_exec("e2e", command="sleep 3; echo done", waitSeconds=0)
    assert result["running"], result
    while result["running"]:
        result = await main.devbox_exec("e2e", execID=result["execID"], waitSeconds=5)
    assert result["stdout"] == "done\n" and result["exitCode"] == 0, result

    result = await main.devbox_exec("e2e", command="sleep 60", waitSeconds=1)
    print(await main.devbox_exec_kill("e2e", result["execID"]))
    assert not main.execs

    print(await main.devbox_file_write("e2e", "/tmp/crabbox-mcp-e2e.txt", "héllo\n"))
    result = await main.devbox_file_read("e2e", "/tmp/crabbox-mcp-e2e.txt")
    assert result["content"] == "héllo\n", result

    main.boxes["e2e"].last_used = "2000-01-01T00:00:00+00:00"
    assert main.boxes["e2e"].deadline() < main.now()
    await main.destroy(main.boxes["e2e"])
    assert "e2e" not in main.boxes
    print("ok")


asyncio.run(run())
