"""Exercise the installed Hermes CLI and its own tool registry, without an LLM."""
import json
import os
from pathlib import Path
import subprocess
import sys

root = Path(sys.argv[1])
sys.path.insert(0, str(root))
sys._hermes_pin_default_home = True
import hermes_bootstrap  # activate the installed product dependency environment

endpoint = json.load(sys.stdin)["endpoint"]
config = {
    "mcp_servers": {
        "signalk_fixture": {
            "url": endpoint,
            "transport": "streamable-http",
            "headers": {"Authorization": "Bearer ${SIGNALK_MCP_TEST_BEARER}"},
            "connect_timeout": 10,
            "tools": {"prompts": False, "resources": False},
        }
    }
}
(Path(os.environ["HERMES_HOME"]) / "config.yaml").write_text(json.dumps(config))
probe = subprocess.run(
    [str(root / ".hermes/bin/hermes"), "mcp", "test", "signalk_fixture"],
    capture_output=True, text=True, timeout=20,
)
assert probe.returncode == 0, "Hermes CLI connection test failed"
assert "Tools discovered: 9" in probe.stdout, "Hermes CLI did not discover nine tools"

from tools.mcp_tool_discovery import discover_mcp_tools
from tools.mcp_tool_lifecycle import shutdown_mcp_servers
from tools.registry import registry

try:
    for connection in range(2):
        names = discover_mcp_tools(allowed_mcp_names=["signalk_fixture"])
        assert len(names) == 7, names
        name = next(n for n in names if n.endswith("_get_values"))
        result = json.loads(registry.get_entry(name).handler({
            "paths": ["navigation.speedOverGround", "electrical.batteries.house.voltage"]
        }))
        # Hermes deduplicates equivalent MCP text and structured payloads.
        data = result.get("structuredContent", result.get("result"))
        if isinstance(data, str):
            data = json.loads(data)
        values = data["measurements"]
        assert values[0]["value"] == 0 and values[0]["unit"] == "m/s"
        assert values[1] == {
            "path": "electrical.batteries.house.voltage", "status": "unavailable"
        }
        name = next(n for n in names if n.endswith("_execute_capability"))
        error = json.loads(registry.get_entry(name).handler({
            "id": "plugin.mcp-fixture", "operation": "write", "arguments": {}
        }))
        assert error.get("error") == "OPERATION_DISABLED", error
        assert "structuredContent" not in error, error
        shutdown_mcp_servers()
    print("HERMES_FIXTURE_OK")
finally:
    shutdown_mcp_servers()
