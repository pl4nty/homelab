import asyncio
import base64
import json
import sys
import time

from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client


async def main(out: str) -> None:
    async with streamable_http_client("http://127.0.0.1:8000/mcp") as streams:
        async with ClientSession(*streams[:2]) as s:
            await s.initialize()

            async def call(name, **args):
                res = await s.call_tool(name, {"name": "test", **args})
                images = [c for c in res.content if c.type == "image"]
                texts = [c.text for c in res.content if c.type == "text"]
                print(f"== {name} {json.dumps(args)[:200]} error={res.is_error}")
                for t in texts:
                    print(t[:3000])
                for i, img in enumerate(images):
                    path = f"{out}/{name}-{int(time.time() * 1000)}-{i}.png"
                    with open(path, "wb") as f:
                        f.write(base64.b64decode(img.data))
                    print(f"saved {path} ({len(img.data)} b64 chars)")
                return res, texts

            for _ in range(60):
                res, _ = await call("devbox_wait_ready", timeoutSeconds=5)
                if not res.is_error and "READY" in res.content[0].text:
                    break
                await asyncio.sleep(2)
            await call("devbox_exec", command="cmd", args=["/c", "echo hello & echo oops 1>&2 & exit 3"])
            res, texts = await call(
                "devbox_exec",
                command="powershell",
                args=["-NoProfile", "-Command", "1..3 | % { $_; Start-Sleep 2 }; 'done ünïcode'"],
                waitSeconds=1,
            )
            exec_id = json.loads(texts[0])["execID"]
            await call("devbox_exec", execID=exec_id, waitSeconds=20)
            res, texts = await call("devbox_exec", command="ping", args=["-n", "60", "127.0.0.1"], waitSeconds=1)
            await call("devbox_exec_kill", execID=json.loads(texts[0])["execID"])
            await call("devbox_file_write", path="C:\\mcp-test\\a b\\x.txt", content="line1\nline2 ✓\n")
            await call("devbox_file_write", path="C:\\mcp-test\\a b\\x.txt", content="appended\n", append=True)
            await call("devbox_file_read", path="C:\\mcp-test\\a b\\x.txt")
            await call("devbox_file_write", path="C:\\mcp-test\\bin.dat", content=base64.b64encode(bytes(range(256))).decode(), encoding="base64")
            await call("devbox_file_read", path="C:\\mcp-test\\bin.dat", offset=250)
            await call("devbox_file_list", path="C:\\mcp-test")
            await call("devbox_screenshot")
            await call("devbox_exec", command="notepad.exe", waitSeconds=3)
            await asyncio.sleep(3)
            res, texts = await call("devbox_windows")
            windows = json.loads(texts[0])["windows"]
            notepad = next(w for w in windows if (w["process"] or "").lower() == "notepad")
            await call("devbox_windows", action="maximize", handle=notepad["handle"])
            await call("devbox_windows", action="focus", handle=notepad["handle"])
            await call("devbox_keyboard", action="type", text="Hello from the Windows devbox MCP ✓\nsecond line\tTAB")
            await call("devbox_keyboard", action="key", text="ctrl+home shift+end", screenshot_after=False)
            await call("devbox_keyboard", action="type", text="Replaced first line")
            await call("devbox_mouse", action="right_click", x=400, y=300)
            await call("devbox_keyboard", action="key", text="esc", screenshot_after=False)
            await call("devbox_mouse", action="drag", x=100, y=150, toX=500, toY=200, screenshot_after=False)
            await call("devbox_mouse", action="scroll", x=400, y=300, scrollY=3, screenshot_after=False)
            await call("devbox_mouse", action="position", screenshot_after=False)
            await call("devbox_windows", action="close", handle=notepad["handle"])
            await asyncio.sleep(2)
            await call("devbox_screenshot")
            await call("devbox_keyboard", action="key", text="alt+n", screenshot_after=False)
            await asyncio.sleep(2)
            await call("devbox_windows")
            await call("devbox_keyboard", action="key", text="nosuchkey", screenshot_after=False)


asyncio.run(main(sys.argv[1]))
