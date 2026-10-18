"""Optional independent MCP client; credentials arrive over stdin, never argv."""
import asyncio
import json
import sys

import httpx
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client


async def main():
    config = json.load(sys.stdin)
    async with httpx.AsyncClient(headers={"Authorization": "Bearer " + config["token"]}) as http:
        async with streamable_http_client(config["url"], http_client=http) as (read, write, _):
            async with ClientSession(read, write) as session:
                await session.initialize()
                tools = await session.list_tools()
                assert sorted(tool.name for tool in tools.tools) == ["describe_capability", "execute_capability", "get_history", "get_values", "get_vessel_state", "list_capabilities", "list_paths"]
                paths = await session.call_tool("list_paths", {"prefix": "navigation"})
                assert "navigation.speedOverGround" in json.loads(paths.content[0].text)["paths"]
                values = await session.call_tool("get_values", {"paths": ["navigation.speedOverGround"]})
                measurement = json.loads(values.content[0].text)["measurements"][0]
                assert measurement["value"] == 0
                assert measurement["unit"] == "m/s"
                print("Python MCP client: initialization, discovery and telemetry passed")


asyncio.run(main())
