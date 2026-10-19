import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  authenticate,
  GatewayError,
  type App,
  type Principal,
} from "../auth.js";
import { getValues, listPaths, record } from "../data.js";
import type { Config } from "../config.js";
import { applyReviews, type ApprovalRequests } from "../approvals.js";
import type { LocalGet } from "./http.js";
import { getHistory, historyProviders } from "./history.js";
import { getNotification, listNotifications } from "./notifications.js";
import {
  discoverOperations,
  operationDescription,
  operationRoute,
} from "./openapi.js";
import {
  historyInput,
  notificationInput,
  notificationsInput,
  pathsInput,
  pluginIdSchema,
  stateInput,
  valuesInput,
} from "./schemas.js";

const vesselPaths = [
  "navigation.position",
  "navigation.speedOverGround",
  "navigation.courseOverGroundTrue",
  "navigation.headingTrue",
  "navigation.datetime",
  "environment.wind.speedApparent",
  "environment.wind.angleApparent",
  "environment.depth.belowKeel",
];
interface CoreOperation {
  description: string;
  input: z.AnyZodObject;
  run: (args: unknown) => object | Promise<object>;
}
interface PluginInfo {
  id: string;
  enabled: boolean;
}
export class CapabilityRegistry {
  private readonly core: Record<
    string,
    { description: string; operations: Record<string, CoreOperation> }
  >;
  constructor(
    private readonly app: App,
    private readonly authorization: string,
    private readonly config: Config,
    private readonly running: () => boolean,
    private readonly get: LocalGet = async () => {
      throw new GatewayError("LOCAL_HTTP_UNAVAILABLE");
    },
    private readonly requests?: ApprovalRequests,
  ) {
    this.core = {
      "signalk.telemetry": {
        description: "Permission-filtered current measurements on vessels.self",
        operations: {
          list_paths: {
            description: "Discover authorized measurement leaf paths",
            input: pathsInput,
            run: (args) => {
              const a = pathsInput.parse(args);
              return listPaths(
                app,
                this.authorize(),
                a.prefix ?? "",
                a.offset,
                a.limit,
              );
            },
          },
          get_values: {
            description:
              "Read batched measurements with units, timestamps, source and freshness",
            input: valuesInput,
            run: (args) =>
              getValues(
                app,
                this.authorize(),
                [...new Set(valuesInput.parse(args).paths)],
                config.staleAfterSeconds,
              ),
          },
          get_vessel_state: {
            description:
              "Read a compact navigation and environment snapshot; missing or denied values remain unavailable",
            input: stateInput,
            run: () =>
              getValues(
                app,
                this.authorize(),
                vesselPaths,
                config.staleAfterSeconds,
              ),
          },
        },
      },
      "signalk.notifications": {
        description:
          "Read permission-filtered legacy measurements and v2 notification records; no lifecycle commands",
        operations: {
          list_notifications: {
            description:
              "Fetch v2 registry records unchanged, filtered by native context/path/source permissions. Pagination covers authorized records, not a stable snapshot.",
            input: notificationsInput,
            run: (args) =>
              listNotifications(
                app,
                () => this.authorize(),
                this.get,
                notificationsInput.parse(args),
              ),
          },
          get_notification: {
            description:
              "Fetch one authorized v2 registry record unchanged. Missing, denied and unresolved-source records are indistinguishable.",
            input: notificationInput,
            run: (args) =>
              getNotification(
                app,
                () => this.authorize(),
                this.get,
                notificationInput.parse(args).id,
              ),
          },
          list: {
            description:
              "List authorized notification values from the self data model",
            input: notificationsInput,
            run: (args) => {
              const a = notificationsInput.parse(args);
              const principal = this.authorize();
              const paths = listPaths(
                app,
                principal,
                "notifications",
                a.offset,
                a.limit,
              );
              return {
                ...getValues(
                  app,
                  principal,
                  paths.paths,
                  config.staleAfterSeconds,
                ),
                nextOffset: paths.nextOffset,
              };
            },
          },
        },
      },
      "signalk.history": {
        description:
          "Bounded standard v2 history reads using Signal K permissions",
        operations: {
          get_history: {
            description:
              "Forward provider results unchanged; source filters are required when telemetry ACLs exist, response $source is optional",
            input: historyInput,
            run: (args) =>
              getHistory(
                app,
                () => this.authorize(),
                this.get,
                historyInput.parse(args),
              ),
          },
        },
      },
    };
  }
  authorize(): Principal {
    if (!this.running()) throw new GatewayError("PLUGIN_STOPPED", 503);
    return authenticate(this.app, this.authorization);
  }
  private async features(): Promise<{ apis: string[]; plugins: PluginInfo[] }> {
    this.authorize();
    if (typeof this.app.getFeatures !== "function")
      throw new GatewayError("DISCOVERY_UNAVAILABLE");
    const raw: unknown = await this.app.getFeatures();
    this.authorize();
    if (
      !record(raw) ||
      !Array.isArray(raw.plugins) ||
      !Array.isArray(raw.apis) ||
      raw.plugins.length > 256 ||
      raw.apis.length > 64
    )
      throw new GatewayError("INVALID_FEATURES");
    const plugins: PluginInfo[] = [];
    const ids = new Set<string>();
    for (const plugin of raw.plugins) {
      if (
        !record(plugin) ||
        !pluginIdSchema.safeParse(plugin.id).success ||
        typeof plugin.enabled !== "boolean"
      )
        throw new GatewayError("INVALID_FEATURES");
      const id = plugin.id as string;
      if (ids.has(id)) throw new GatewayError("INVALID_FEATURES");
      ids.add(id);
      if (id !== "signalk-mcp") plugins.push({ id, enabled: plugin.enabled });
    }
    const apis = raw.apis.filter(
      (api): api is string =>
        typeof api === "string" && /^[a-z][a-z0-9_-]{0,63}$/i.test(api),
    );
    return { apis: [...new Set(apis)], plugins };
  }
  async list(offset = 0, limit = 100) {
    this.authorize();
    const capabilities: object[] = Object.entries(this.core).map(
      ([id, cap]) => ({
        id,
        provider: "signalk",
        kind: "core",
        description: cap.description,
        readOnly: true,
        availability:
          id === "signalk.history" ? "provider-dependent" : "available",
      }),
    );
    let discovery: string = "complete";
    try {
      const features = await this.features();
      for (const api of features.apis)
        if (!["history", "notifications"].includes(api))
          capabilities.push({
            id: `api.${api}`,
            provider: "signalk",
            kind: "api",
            readOnly: true,
            availability: "adapter-required",
          });
      for (const plugin of features.plugins.sort((a, b) =>
        a.id.localeCompare(b.id),
      ))
        capabilities.push({
          id: `plugin.${plugin.id}`,
          provider: plugin.id,
          kind: "plugin",
          readOnly: true,
          availability: plugin.enabled ? "inspect-required" : "disabled",
        });
    } catch (error) {
      this.authorize();
      discovery =
        error instanceof GatewayError ? error.code : "DISCOVERY_UNAVAILABLE";
    }
    return {
      capabilities: capabilities.slice(offset, offset + limit),
      nextOffset: offset + limit < capabilities.length ? offset + limit : null,
      discovery,
    };
  }
  async describe(id: string) {
    this.authorize();
    if (Object.hasOwn(this.core, id)) {
      const capability = this.core[id]!;
      let providers: { id: string; isDefault: boolean }[] | undefined;
      let reason: string | null = null;
      let notificationsReason: string | null = null;
      if (id === "signalk.notifications") {
        try {
          await listNotifications(this.app, () => this.authorize(), this.get, {
            offset: 0,
            limit: 1,
          });
        } catch (error) {
          notificationsReason =
            error instanceof GatewayError
              ? error.code
              : "NOTIFICATIONS_UNAVAILABLE";
        }
        this.authorize();
      }
      if (id === "signalk.history") {
        try {
          providers = await historyProviders(this.get);
          if (providers.length === 0) reason = "HISTORY_UNAVAILABLE";
        } catch (error) {
          reason =
            error instanceof GatewayError ? error.code : "HISTORY_UNAVAILABLE";
        }
        this.authorize();
      }
      return {
        id,
        provider: "signalk",
        readOnly: true,
        description: capability.description,
        available: reason === null,
        reason,
        ...(providers ? { providers } : {}),
        operations: Object.entries(capability.operations).map(
          ([name, operation]) => ({
            id: name,
            permission: "readonly",
            enabled:
              reason === null &&
              (id !== "signalk.notifications" ||
                name === "list" ||
                notificationsReason === null),
            ...(id === "signalk.notifications" && name !== "list"
              ? { reason: notificationsReason }
              : {}),
            description: operation.description,
            inputSchema: zodToJsonSchema(operation.input, {
              $refStrategy: "none",
            }),
          }),
        ),
      };
    }
    if (id.startsWith("api.")) {
      const features = await this.features();
      if (features.apis.includes(id.slice(4)))
        return {
          id,
          provider: "signalk",
          readOnly: true,
          available: false,
          reason: "ADAPTER_REQUIRED",
          operations: [],
        };
    }
    const plugin = await this.plugin(id);
    if (!plugin.enabled)
      return {
        id,
        provider: plugin.id,
        readOnly: true,
        available: false,
        reason: "PLUGIN_DISABLED",
        operations: [],
      };
    try {
      const document = await this.get(
        `/skServer/openapi/plugins/${encodeURIComponent(plugin.id)}`,
      );
      const operations = applyReviews(
        discoverOperations(
          document,
          plugin.id,
          this.config.pluginOperations ?? [],
          this.authorize(),
        ),
        plugin.id,
        this.config.readRequests ?? {},
        this.authorize(),
      );
      return {
        id,
        provider: plugin.id,
        readOnly: true,
        available: true,
        reason: null,
        operations: operations.map(operationDescription),
      };
    } catch (error) {
      this.authorize();
      return {
        id,
        provider: plugin.id,
        readOnly: true,
        available: false,
        reason:
          error instanceof GatewayError ? error.code : "DISCOVERY_UNAVAILABLE",
        operations: [],
      };
    }
  }
  private async plugin(id: string): Promise<PluginInfo> {
    if (!id.startsWith("plugin."))
      throw new GatewayError("CAPABILITY_NOT_FOUND");
    const plugin = (await this.features()).plugins.find(
      (plugin) => plugin.id === id.slice(7),
    );
    if (!plugin) throw new GatewayError("CAPABILITY_NOT_FOUND");
    return plugin;
  }
  async execute(id: string, operation: string, args: unknown): Promise<object> {
    this.authorize();
    if (Object.hasOwn(this.core, id)) {
      const operations = this.core[id]!.operations;
      if (!Object.hasOwn(operations, operation))
        throw new GatewayError("OPERATION_NOT_FOUND");
      const target = operations[operation]!;
      const input = target.input.safeParse(args);
      if (!input.success) throw new GatewayError("INVALID_ARGUMENTS");
      const result = await target.run(input.data);
      this.authorize();
      return result;
    }
    const plugin = await this.plugin(id);
    if (!plugin.enabled) throw new GatewayError("CAPABILITY_UNAVAILABLE");
    const document = await this.get(
      `/skServer/openapi/plugins/${encodeURIComponent(plugin.id)}`,
    );
    const target = applyReviews(
      discoverOperations(
        document,
        plugin.id,
        this.config.pluginOperations ?? [],
        this.authorize(),
      ),
      plugin.id,
      this.config.readRequests ?? {},
      this.authorize(),
    ).find((candidate) => candidate.id === operation);
    if (target?.reason === "NOT_ALLOWLISTED" && this.requests) {
      if (!target.input?.safeParse(args).success)
        throw new GatewayError("INVALID_ARGUMENTS");
      this.authorize();
      this.requests.request(plugin.id, target);
    }
    if (target?.reason === "APPROVAL_REJECTED")
      throw new GatewayError("APPROVAL_REJECTED", 403);
    if (!target || !target.enabled)
      throw new GatewayError("OPERATION_DISABLED", 403);
    const route = operationRoute(plugin.id, target, args);
    this.authorize();
    const result = await this.get(route);
    const principal = this.authorize();
    if (target.permission === "admin" && principal.permissions !== "admin")
      throw new GatewayError("PERMISSION_DENIED", 403);
    return { capability: id, operation, provider: plugin.id, data: result };
  }
}
