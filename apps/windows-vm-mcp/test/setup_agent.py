import json
import re
import sys
from pathlib import Path

import hub

out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)
bootstrap = Path("agent/bootstrap.ps1").read_text()
for name, body in re.findall(r'WriteAllText\("\$dir\\(\w+\.ps1)", @\'\n(.*?)\n\'@', bootstrap, re.S):
    (out / name).write_text(body)
(out / "config.json").write_text(
    json.dumps({"url": "ws://127.0.0.1:8000/agent/test", "token": hub.agent_token("test")})
)
(out / "Agent.cs").write_text(hub.AGENT_SOURCE + "\n// outdated, so the server pushes the current agent\n")
print(sorted(p.name for p in out.iterdir()))
