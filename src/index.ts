import type { Plugin, PluginRouter } from "@signalk/server-api";
import type { Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { authenticate, GatewayError, type App } from "./auth.js";
import { configSchema, schema, uiSchema, type Config } from "./config.js";
import { localGet } from "./capabilities/http.js";
import { createMcpServer } from "./mcp.js";

function pluginFactory(app: App): Plugin {
  let config: Config | undefined;
  const active = new Set<ReturnType<typeof createMcpServer>>();
  const pending = new Map<AbortController, Response>();
  const guard = (req: Request) => {
    if (!config) throw new GatewayError("PLUGIN_UNAVAILABLE", 503);
    if (!config.allowedHosts.includes(req.headers.host ?? ""))
      throw new GatewayError("HOST_DENIED", 403);
    const origin = req.get("origin");
    if (origin !== undefined && !config.allowedOrigins.includes(origin))
      throw new GatewayError("ORIGIN_DENIED", 403);
    authenticate(app, req.get("authorization"));
    return config;
  };
  const fail = (res: Response, error: unknown) => {
    const status = error instanceof GatewayError ? error.status : 500;
    if (status === 401)
      res.setHeader("WWW-Authenticate", 'Bearer realm="Signal K MCP"');
    if (!res.headersSent)
      res.status(status).json({
        error:
          error instanceof GatewayError ? error.code : "MCP_REQUEST_FAILED",
      });
    else if (!res.writableEnded) res.end();
  };
  const handler = async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    let server: ReturnType<typeof createMcpServer> | undefined;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const settings = guard(req);
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        res.status(405).end();
        return;
      }
      if (active.size >= 8) throw new GatewayError("BUSY", 429);
      // Signal K parses JSON before plugin routes. Bound the already-parsed body
      // too; the host server owns the wire/body-parser limit.
      if (
        req.body !== undefined &&
        Buffer.byteLength(JSON.stringify(req.body)) > 64 * 1024
      )
        throw new GatewayError("REQUEST_TOO_LARGE", 413);
      pending.set(controller, res);
      timer = setTimeout(() => {
        controller.abort();
        res.destroy();
      }, 15000);
      timer.unref();
      server = createMcpServer(
        app,
        req.get("authorization")!,
        settings,
        () => config === settings && !controller.signal.aborted,
        localGet(
          req,
          req.get("authorization")!,
          controller.signal,
          settings.localTlsServerName,
        ),
      );
      active.add(server);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      const current = server;
      let finishClosed!: () => void;
      const disconnected = new Promise<void>((resolve) => {
        finishClosed = resolve;
      });
      const closed = () => {
        finishClosed();
        controller.abort();
        void current.close().catch(() => {});
      };
      res.once("close", closed);
      try {
        await server.connect(transport);
        // SDK JSON-response promises can remain pending after transport.close().
        // A disconnected client must still reach our resource cleanup.
        await Promise.race([
          transport.handleRequest(req, res, req.body),
          disconnected,
        ]);
      } finally {
        res.off("close", closed);
      }
    } catch (error) {
      fail(res, error);
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
      pending.delete(controller);
      if (server) {
        active.delete(server);
        await server.close().catch(() => {});
      }
    }
  };
  return {
    id: "signalk-mcp",
    name: "Signal K MCP",
    description: "Authenticated read-only MCP vessel telemetry",
    schema,
    uiSchema,
    start(options: unknown) {
      config = undefined;
      const parsed = configSchema.safeParse(options);
      if (!parsed.success) {
        app.setPluginError(
          "Invalid MCP configuration: check allowedHosts, allowedOrigins, pluginOperations (unique reviewed GET approvals), localTlsServerName and staleAfterSeconds",
        );
        return;
      }
      config = parsed.data;
      app.setPluginStatus(
        "Read-only MCP endpoint ready; Signal K token security required",
      );
    },
    async stop() {
      config = undefined;
      for (const [controller, response] of pending) {
        controller.abort();
        // Closing the MCP transport alone can leave its HTTP response pending.
        // End the client connection too instead of retaining it until deadline.
        response.destroy();
      }
      await Promise.allSettled([...active].map((server) => server.close()));
      active.clear();
    },
    registerWithRouter(router: PluginRouter) {
      if (typeof router.access !== "function") {
        config = undefined;
        app.setPluginError("Signal K 2.33.0 permission-aware router required");
        return;
      }
      router
        .access("readonly")
        .post("/mcp", handler)
        .get("/mcp", handler)
        .delete("/mcp", handler);
    },
  };
}
export = pluginFactory;
