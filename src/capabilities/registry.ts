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
import type {
  LocalGet,
  LocalPost,
  LocalResourceMutation,
  LocalPluginMutation,
  PluginMutationMethod,
} from "./http.js";
import type { LocalActions } from "../put-types.js";
import {
  NativePuts,
  describePutInput,
  putInput,
  putPathsInput,
  putStatusInput,
} from "../puts.js";
import {
  describeResource,
  describeResourceInput,
  mutateResource,
  isResourceMutation,
  createResourceInput,
  putResourceInput,
  deleteResourceInput,
} from "./resource-mutations.js";
import { getHistory, historyProviders } from "./history.js";
import {
  listResourceCollections,
  listResourceProviders,
  getResource,
  listResources,
  listLogentries,
  listLogentryDates,
  resourceProvidersInput,
  resourceInput,
  resourcesInput,
  logentriesInput,
  logentryDatesInput,
} from "./resources.js";
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
    private readonly puts?: NativePuts,
    private readonly actions?: LocalActions,
    private readonly post?: LocalPost,
    private readonly resourceMutation?: LocalResourceMutation,
    private readonly pluginMutation?: LocalPluginMutation,
  ) {
    this.core = {
      "api.resources": {
        description:
          "Native Resources API reads and individually approved writes under the caller's Signal K permissions",
        operations: {
          describe_resource: {
            description:
              "Describe create, upsert and delete contracts and saved approval for one resource collection/provider. Discovery does not queue approval.",
            input: describeResourceInput,
            run: (args) =>
              describeResource(
                this.resourceContext(),
                describeResourceInput.parse(args),
              ),
          },
          list_collections: {
            description:
              "Discover registered resource collections and which have read adapters",
            input: stateInput,
            run: () =>
              listResourceCollections(() => this.authorize(), this.get),
          },
          list_resource_providers: {
            description:
              "Discover registered providers for a resource collection; multiple providers require explicit selection",
            input: resourceProvidersInput,
            run: (args) =>
              listResourceProviders(
                () => this.authorize(),
                this.get,
                resourceProvidersInput.parse(args).collection,
              ),
          },
          list_resources: {
            description:
              "Read routes, waypoints, regions, notes or chart metadata. Standard lists default to limit 100 (maximum 500); charts accept no filters. No URL or chart-tile fetching. Provider filters and values are not recomputed.",
            input: resourcesInput,
            run: (args) =>
              listResources(
                () => this.authorize(),
                this.get,
                resourcesInput.parse(args),
              ),
          },
          get_resource: {
            description:
              "Read one resource unchanged, including a UUID logentry. URLs and attachments remain data.",
            input: resourceInput,
            run: (args) =>
              getResource(
                () => this.authorize(),
                this.get,
                resourceInput.parse(args),
              ),
          },
          list_logentries: {
            description:
              "Read logentries using a date, a from/to pair (maximum 31 days), or a limit (newest matches, maximum 500). No default window or silent truncation. Author is provider attribution, not authenticated identity.",
            input: logentriesInput,
            run: (args) =>
              listLogentries(
                () => this.authorize(),
                this.get,
                logentriesInput.parse(args),
              ),
          },
          list_logentry_dates: {
            description:
              "Fetch the provider's dates=true calendar unchanged (maximum 2000 dates); optional date or from/to pair spanning at most 366 days. Counts are supplied by the provider.",
            input: logentryDatesInput,
            run: (args) =>
              listLogentryDates(
                () => this.authorize(),
                this.get,
                logentryDatesInput.parse(args),
              ),
          },
        },
      },
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
      "signalk.put": {
        description:
          "Native self-context actions; every exact path/source needs saved administrator approval and native PUT permission",
        operations: {
          list_put_paths: {
            description:
              "Discover metadata-advertised PUT path candidates for an explicit source; no current values or inferred handler sources",
            input: putPathsInput,
            run: (args) =>
              this.nativePuts().list(
                () => this.authorize(),
                putPathsInput.parse(args),
              ),
          },
          describe_put: {
            description:
              "Describe a native action's schema diagnostics and exact approval state using its metadata and explicit source; discovery does not approve or verify a registered handler",
            input: describePutInput,
            run: (args) =>
              this.nativePuts().describe(
                () => this.authorize(),
                describePutInput.parse(args),
                this.config.readRequests,
                this.requests,
              ),
          },
          get_put_status: {
            description:
              "Check a gateway-submitted native action owned by this Signal K identity; unknown/expired requests stay unavailable",
            input: putStatusInput,
            run: (args) =>
              this.nativePuts().status(
                this.putContext(),
                putStatusInput.parse(args),
              ),
          },
        },
      },
    };
  }
  private resourceContext() {
    return {
      authorize: () => this.authorize(),
      config: this.config,
      get: this.get,
      requests: this.requests,
      http: this.resourceMutation,
    };
  }
  private nativePuts(): NativePuts {
    if (!this.puts) throw new GatewayError("PUT_UNAVAILABLE", 503);
    return this.puts;
  }
  private putContext() {
    if (!this.actions || !this.requests)
      throw new GatewayError("PUT_UNAVAILABLE", 503);
    return {
      authorize: () => this.authorize(),
      config: this.config,
      requests: this.requests,
      http: this.actions,
    };
  }
  async executeMutation(
    id: string,
    operation: string,
    args: unknown,
  ): Promise<object> {
    this.authorize();
    if (id === "api.resources" && isResourceMutation(operation))
      return mutateResource(this.resourceContext(), operation, args);
    if (id.startsWith("plugin."))
      return this.executePlugin(id, operation, args, true);
    if (id !== "signalk.put" || operation !== "put_value")
      throw new GatewayError("OPERATION_DISABLED", 403);
    const input = putInput.safeParse(args);
    if (!input.success) throw new GatewayError("INVALID_ARGUMENTS");
    return this.nativePuts().execute(this.putContext(), input.data);
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
        kind: id === "api.resources" ? "api" : "core",
        description: cap.description,
        readOnly: !["signalk.put", "api.resources"].includes(id),
        availability: ["signalk.history", "api.resources"].includes(id)
          ? "provider-dependent"
          : id === "signalk.put"
            ? "per-target-approval"
            : "available",
      }),
    );
    let discovery: string = "complete";
    try {
      const features = await this.features();
      for (const api of features.apis)
        if (!["history", "notifications", "resources"].includes(api))
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
          readOnly: false,
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
    if (id === "signalk.put") {
      const principal = this.authorize();
      const available = Boolean(this.puts && this.actions && this.requests);
      const permitted = ["readwrite", "admin"].includes(principal.permissions);
      return {
        id,
        provider: "signalk",
        readOnly: false,
        available,
        reason: available ? null : "PUT_UNAVAILABLE",
        description: this.core[id]!.description,
        operations: [
          ...Object.entries(this.core[id]!.operations).map(
            ([name, operation]) => ({
              id: name,
              readOnly: true,
              permission: "readwrite",
              enabled: available && permitted,
              reason: !available
                ? "PUT_UNAVAILABLE"
                : permitted
                  ? null
                  : "PERMISSION_DENIED",
              description: operation.description,
              inputSchema: zodToJsonSchema(operation.input, {
                $refStrategy: "none",
              }),
            }),
          ),
          {
            id: "put_value",
            readOnly: false,
            permission: "readwrite",
            enabled: false,
            reason: "PER_TARGET_APPROVAL_REQUIRED",
            executionTool: "put_value",
            description:
              "Submit one approved path/source action. Never automatically retry an unknown outcome. Use put_value or execute_mutation; execute_capability only reads.",
            inputSchema: zodToJsonSchema(putInput, { $refStrategy: "none" }),
          },
        ],
      };
    }
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
      if (id === "api.resources") {
        try {
          await listResourceCollections(() => this.authorize(), this.get);
        } catch (error) {
          reason =
            error instanceof GatewayError
              ? error.code
              : "RESOURCES_UNAVAILABLE";
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
        readOnly: id !== "api.resources",
        description: capability.description,
        available: reason === null,
        reason,
        ...(providers ? { providers } : {}),
        operations: [
          ...Object.entries(capability.operations).map(([name, operation]) => ({
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
          })),
          ...(id === "api.resources"
            ? [
                ["create_resource", createResourceInput],
                ["put_resource", putResourceInput],
                ["delete_resource", deleteResourceInput],
              ].map(([name, input]) => ({
                id: name,
                permission: "readwrite",
                readOnly: false,
                enabled: false,
                reason: "PER_OPERATION_APPROVAL_REQUIRED",
                executionTool: "execute_mutation",
                description:
                  "Use describe_resource with collection and provider for the exact reviewed body contract and approval state.",
                inputSchema: zodToJsonSchema(input as z.AnyZodObject, {
                  $refStrategy: "none",
                }),
              }))
            : []),
        ],
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
        readOnly: false,
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
        readOnly: false,
        available: true,
        reason: null,
        operations: operations.map(operationDescription),
      };
    } catch (error) {
      this.authorize();
      return {
        id,
        provider: plugin.id,
        readOnly: false,
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
    if (
      (id === "signalk.put" && operation === "put_value") ||
      (id === "api.resources" && isResourceMutation(operation))
    )
      throw new GatewayError("MUTATION_TOOL_REQUIRED", 403);
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
    return this.executePlugin(id, operation, args, false);
  }
  private async executePlugin(
    id: string,
    operation: string,
    args: unknown,
    mutation: boolean,
  ): Promise<object> {
    if (
      mutation &&
      !["readwrite", "admin"].includes(this.authorize().permissions)
    )
      throw new GatewayError("PERMISSION_DENIED", 403);
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
    if (
      target &&
      (mutation
        ? !["POST", "PUT", "PATCH", "DELETE"].includes(target.method)
        : target.method !== "GET")
    )
      throw new GatewayError(
        mutation
          ? "OPERATION_DISABLED"
          : ["POST", "PUT", "PATCH", "DELETE"].includes(target.method)
            ? "MUTATION_TOOL_REQUIRED"
            : "OPERATION_DISABLED",
        403,
      );
    if (
      mutation &&
      !["readwrite", "admin"].includes(this.authorize().permissions)
    )
      throw new GatewayError("PERMISSION_DENIED", 403);
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
    if (mutation) {
      const send =
        this.pluginMutation ??
        (target.method === "POST" && this.post
          ? (_method: PluginMutationMethod, path: string, body?: unknown) =>
              this.post!(path, body)
          : undefined);
      if (!send) throw new GatewayError("PLUGIN_MUTATION_UNAVAILABLE", 503);
      const body = target.input!.parse(args).body;
      // Recheck lifecycle, enabled state and approval after asynchronous discovery.
      if (!(await this.plugin(id)).enabled)
        throw new GatewayError("CAPABILITY_UNAVAILABLE");
      const principal = this.authorize();
      if (!["readwrite", "admin"].includes(principal.permissions))
        throw new GatewayError("PERMISSION_DENIED", 403);
      const current = applyReviews(
        [{ ...target, enabled: false, reason: "NOT_ALLOWLISTED" }],
        plugin.id,
        this.config.readRequests ?? {},
        principal,
      )[0]!;
      if (!current.enabled)
        throw new GatewayError(current.reason ?? "OPERATION_DISABLED", 403);
      try {
        const response = await send(
          target.method as PluginMutationMethod,
          route,
          body,
        );
        const after = this.authorize();
        if (
          after.identifier !== principal.identifier ||
          !["readwrite", "admin"].includes(after.permissions) ||
          !applyReviews(
            [{ ...target, enabled: false, reason: "NOT_ALLOWLISTED" }],
            plugin.id,
            this.config.readRequests ?? {},
            after,
          )[0]!.enabled
        )
          throw new GatewayError("PERMISSION_DENIED", 403);
        return {
          capability: id,
          operation,
          provider: plugin.id,
          outcome: response.status === 202 ? "accepted" : "responded",
          submitted: true,
          retrySafe: false,
          statusCode: response.status,
          ...(response.data === undefined ? {} : { data: response.data }),
        };
      } catch (error) {
        // An HTTP error can follow a provider side effect. No automatic retries,
        // invented completion state or claims that cancellation undid the action.
        return {
          capability: id,
          operation,
          provider: plugin.id,
          outcome: "unknown",
          submitted: true,
          retrySafe: false,
          code:
            error instanceof GatewayError
              ? error.code
              : target.method === "POST"
                ? "PLUGIN_POST_RESULT_UNAVAILABLE"
                : "PLUGIN_MUTATION_RESULT_UNAVAILABLE",
          ...(error instanceof GatewayError &&
          ["PLUGIN_POST_HTTP_ERROR", "PLUGIN_MUTATION_HTTP_ERROR"].includes(
            error.code,
          )
            ? { statusCode: error.status }
            : {}),
        };
      }
    }
    const result = await this.get(route);
    const principal = this.authorize();
    if (target.permission === "admin" && principal.permissions !== "admin")
      throw new GatewayError("PERMISSION_DENIED", 403);
    return { capability: id, operation, provider: plugin.id, data: result };
  }
}
