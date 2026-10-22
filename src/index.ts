import { DiscoveryCache } from "./capabilities/discovery-cache.js";
import type { Plugin, PluginRouter } from "@signalk/server-api";
import type { Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { authenticate, GatewayError, type App } from "./auth.js";
import { configSchema, schema, uiSchema, type Config } from "./config.js";
import {
  localActions,
  localGet,
  localPost,
  localPluginMutation,
  localResourceMutation,
} from "./capabilities/http.js";
import { createMcpServer } from "./mcp.js";
import { boundedJson } from "./json.js";
import { validateOrigin } from "./origin.js";
import { ApprovalRequests } from "./approvals.js";
import { record } from "./data.js";
import { NativePuts } from "./puts.js";

function pluginFactory(app: App): Plugin {
  let config: Config | undefined;
  const requests = new ApprovalRequests();
  const puts = new NativePuts(app);
  const discovery = new DiscoveryCache();
  let metadataGeneration = 0;
  const active = new Set<ReturnType<typeof createMcpServer>>();
  const pending = new Map<AbortController, Response>();
  const guard = (req: Request, res: Response) => {
    if (!config) throw new GatewayError("PLUGIN_UNAVAILABLE", 503);
    validateOrigin(
      req.get("origin"),
      res.getHeader("Access-Control-Allow-Origin"),
    );
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
      const settings = guard(req, res);
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        res.status(405).end();
        return;
      }
      if (active.size >= 8) throw new GatewayError("BUSY", 429);
      // Signal K parses JSON before plugin routes. Bound the already-parsed body
      // too; the host server owns the wire/body-parser limit.
      if (req.body !== undefined)
        boundedJson(req.body, 64 * 1024, "REQUEST_TOO_LARGE", 413);
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
        requests,
        puts,
        localActions(
          req,
          req.get("authorization")!,
          controller.signal,
          settings.localTlsServerName,
        ),
        localPost(
          req,
          req.get("authorization")!,
          controller.signal,
          settings.localTlsServerName,
        ),
        localResourceMutation(
          req,
          req.get("authorization")!,
          controller.signal,
          settings.localTlsServerName,
        ),
        localPluginMutation(
          req,
          req.get("authorization")!,
          controller.signal,
          settings.localTlsServerName,
        ),
        discovery,
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
    description:
      "Authenticated MCP telemetry and individually approved native PUT actions",
    schema: () => {
      // A disabled plugin may never have started in this process. Its saved
      // reviews must still be visible/editable in the native configuration UI.
      if (!config && typeof app.readPluginOptions === "function") {
        const options: unknown = app.readPluginOptions();
        const saved = configSchema.safeParse(
          record(options) ? options.configuration : undefined,
        );
        if (saved.success) requests.reset(saved.data.readRequests);
      }
      return {
        ...schema,
        properties: { readRequests: requests.schema(), ...schema.properties },
      };
    },
    uiSchema: () => ({ ...uiSchema, readRequests: requests.uiSchema() }),
    start(options: unknown) {
      config = undefined;
      puts.reset();
      discovery.clear();
      const parsed = configSchema.safeParse(options);
      if (!parsed.success) {
        app.setPluginError(
          "Invalid MCP configuration: check pluginOperations (unique reviewed GET approvals), readRequests, localTlsServerName and staleAfterSeconds",
        );
        return;
      }
      config = parsed.data;
      requests.reset(config.readRequests);
      const generation = ++metadataGeneration;
      // Native metadata-only targets need not exist in the value model. Record
      // bounded path hints from public deltas and always preserve host delivery.
      // The native plugin facade removes this hook when the plugin stops.
      if (typeof app.registerDeltaInputHandler === "function")
        app.registerDeltaInputHandler((delta, next) => {
          try {
            if (config && generation === metadataGeneration)
              puts.observeDelta(delta);
          } catch {
            // Malformed provider metadata must not interrupt Signal K telemetry.
          } finally {
            next(delta);
          }
        });
      app.setPluginStatus(
        "MCP endpoint ready; reads and individually approved writes require Signal K permissions",
      );
    },
    async stop() {
      config = undefined;
      metadataGeneration++;
      puts.reset();
      discovery.clear();
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
