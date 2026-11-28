"""WebSocket hub for the agents that dial out from each VM's desktop session."""

import asyncio
import contextlib
import hashlib
import hmac
import json
import logging
import os
from pathlib import Path

from starlette.websockets import WebSocket, WebSocketDisconnect

log = logging.getLogger(__name__)

AGENT_SECRET = os.environ.get("AGENT_SECRET", "")
AGENT_SOURCE = (Path(__file__).parent / "agent" / "Agent.cs").read_text()


def source_hash(source: str) -> str:
    return hashlib.sha256(source.replace("\r\n", "\n").strip().encode()).hexdigest()


AGENT_HASH = source_hash(AGENT_SOURCE)


def agent_token(name: str) -> str:
    return hmac.new(AGENT_SECRET.encode(), name.encode(), hashlib.sha256).hexdigest()


class AgentError(RuntimeError):
    pass


class AgentConnection:
    def __init__(self, ws: WebSocket, hello: dict):
        self.ws = ws
        self.hello = hello
        self.pending: dict[int, asyncio.Future] = {}
        self.next_id = 0
        self.lock = asyncio.Lock()

    async def call(self, op: str, timeout: float = 60, **params) -> dict:
        self.next_id += 1
        request_id = self.next_id
        future = asyncio.get_running_loop().create_future()
        self.pending[request_id] = future
        try:
            async with self.lock:
                await self.ws.send_text(json.dumps({"id": request_id, "op": op, **params}))
            message = await asyncio.wait_for(future, timeout)
        finally:
            self.pending.pop(request_id, None)
        if "error" in message:
            raise AgentError(message["error"])
        return message["result"]

    def resolve(self, message: dict) -> None:
        future = self.pending.get(message.get("id"))
        if future and not future.done():
            future.set_result(message)

    def fail(self) -> None:
        for future in self.pending.values():
            if not future.done():
                future.set_exception(AgentError("agent disconnected"))


class Hub:
    def __init__(self) -> None:
        self.agents: dict[str, AgentConnection] = {}
        self.connected: dict[str, asyncio.Event] = {}

    def event(self, name: str) -> asyncio.Event:
        return self.connected.setdefault(name, asyncio.Event())

    def get(self, name: str) -> AgentConnection:
        agent = self.agents.get(name)
        if not agent:
            raise AgentError(
                f"devbox {name} has no connected agent; call devbox_wait_ready until it is ready"
            )
        return agent

    async def drop(self, name: str) -> None:
        self.event(name).clear()
        if agent := self.agents.pop(name, None):
            agent.fail()
            with contextlib.suppress(Exception):
                await agent.ws.close()

    async def wait(self, name: str, timeout: float) -> bool:
        if name in self.agents:
            return True
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(self.event(name).wait(), timeout)
        return name in self.agents

    async def endpoint(self, ws: WebSocket) -> None:
        name = ws.path_params["name"]
        auth = ws.headers.get("authorization", "")
        if not AGENT_SECRET or not hmac.compare_digest(auth, f"Bearer {agent_token(name)}"):
            await ws.close(code=1008)
            return
        await ws.accept()
        hello = json.loads(await ws.receive_text())
        agent = AgentConnection(ws, hello)
        if old := self.agents.get(name):
            old.fail()
            with contextlib.suppress(Exception):
                await old.ws.close()
        if hello.get("agent") != AGENT_HASH:
            log.info("updating agent on %s from %s", name, hello.get("agent"))
            await ws.send_text(json.dumps({"op": "update", "source": AGENT_SOURCE}))
            with contextlib.suppress(WebSocketDisconnect):
                while True:
                    await ws.receive_text()
            return
        self.agents[name] = agent
        self.event(name).set()
        log.info("agent connected: %s %s", name, hello)
        try:
            while True:
                agent.resolve(json.loads(await ws.receive_text()))
        except WebSocketDisconnect:
            pass
        finally:
            agent.fail()
            if self.agents.get(name) is agent:
                del self.agents[name]
                self.event(name).clear()
            log.info("agent disconnected: %s", name)
