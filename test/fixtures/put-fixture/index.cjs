// This synthetic provider records commands only inside the temporary server.
module.exports = (app) => {
  const calls = [];
  const postCalls = [];
  const mutationCalls = [];
  const postModes = [
    "normal",
    "admin",
    "badjson",
    "redirect",
    "large",
    "disconnect",
    "pending",
    "empty",
    "failure",
  ];
  const document = {
    openapi: "3.0.3",
    paths: Object.fromEntries(
      postModes.map((mode) => [
        `/post-${mode}`,
        {
          post: {
            operationId: mode,
            summary: `Synthetic ${mode} mutation`,
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["value"],
                    properties: { value: { type: "boolean" } },
                  },
                },
              },
            },
          },
        },
      ]),
    ),
  };
  for (const mode of ["normal", "admin", "disconnect", "failure"]) {
    document.paths[`/method-${mode}/{id}`] = Object.fromEntries(
      ["put", "patch", "delete"].map((method) => [
        method,
        {
          operationId: `${method}-${mode}`,
          summary: `Synthetic ${method} ${mode}`,
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          ...(method === "delete"
            ? {}
            : {
                requestBody: {
                  required: true,
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        required: ["value"],
                        additionalProperties: false,
                        properties: {
                          value: {
                            type: "object",
                            additionalProperties: false,
                            required: ["enabled", "labels"],
                            properties: {
                              enabled: { type: "boolean" },
                              labels: {
                                type: "array",
                                items: { type: "string", nullable: true },
                                maxItems: 4,
                              },
                              amount: { type: "number", nullable: true },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              }),
        },
      ]),
    );
  }
  const completions = new Map();
  const delayed = new Set();
  const lifecycle = { starts: 0, stops: 0 };
  const prefix = "electrical.switches.mcpTest";
  const paths = {
    state: `${prefix}.state`,
    pending: `${prefix}.pending`,
    failure: `${prefix}.failure`,
    held: `${prefix}.held`,
    timeout: `${prefix}.timeout`,
    constrained: `${prefix}.constrained`,
    choices: `${prefix}.choices`,
    unsupported: `${prefix}.unsupported`,
    missing: `${prefix}.missing`,
    writeOnly: `${prefix}.writeOnly`,
  };
  function meta(path, value) {
    app.handleMessage("put-fixture", {
      context: "vessels.self",
      updates: [{ meta: [{ path, value }] }],
    });
  }
  function handler(source, kind) {
    return (context, path, value, callback) => {
      calls.push({ context, path, source, value });
      if (kind === "pending") {
        completions.set(path, callback);
        return { state: "PENDING" };
      }
      if (kind === "timeout" || kind === "held") {
        return new Promise((resolve) => {
          delayed.add(resolve);
        });
      }
      return {
        state: "COMPLETED",
        statusCode: kind === "failure" ? 502 : 200,
        message:
          kind === "failure"
            ? "synthetic handler failure"
            : "synthetic command accepted",
      };
    };
  }
  return {
    id: "put-fixture",
    name: "Synthetic native PUT fixture",
    description: "Commands never leave the isolated integration test server",
    schema: { type: "object", properties: {} },
    testCalls: calls,
    postCalls,
    mutationCalls,
    postDocument: document,
    getOpenApi: () => document,
    registerWithRouter(router) {
      for (const mode of ["normal", "admin", "disconnect", "failure"]) {
        for (const method of ["put", "patch", "delete"]) {
          const routes = mode === "admin" ? router : router.access("readwrite");
          routes[method](`/method-${mode}/:id`, (req, res) => {
            const call = {
              method: req.method,
              id: req.params.id,
              body: req.body,
              principal: req.skPrincipal.identifier,
            };
            mutationCalls.push(call);
            if (mode === "disconnect") return req.socket.destroy();
            if (mode === "failure")
              return res.status(500).json({ privateError: "must not escape" });
            if (method === "delete") return res.status(204).end();
            return res.json(call);
          });
        }
      }
      for (const mode of postModes) {
        // Deliberately misdeclared readonly for normal: gateway still requires writer.
        const routes =
          mode === "admin"
            ? router
            : router.access(mode === "normal" ? "readonly" : "readwrite");
        routes.post(`/post-${mode}`, (req, res) => {
          postCalls.push({
            mode,
            body: req.body,
            principal: req.skPrincipal.identifier,
          });
          if (mode === "redirect")
            return res.redirect(307, "/plugins/put-fixture/post-normal");
          if (mode === "badjson")
            return res.type("application/json").send("not json");
          if (mode === "large")
            return res.json({ large: "x".repeat(256 * 1024) });
          if (mode === "disconnect") return req.socket.destroy();
          if (mode === "empty") return res.status(204).end();
          if (mode === "failure")
            return res.status(500).json({ secret: "provider-only-error" });
          res.status(mode === "pending" ? 202 : 200).json({
            value: req.body.value,
            principal: req.skPrincipal.identifier,
            state: mode === "pending" ? "PENDING" : "COMPLETED",
          });
        });
      }
    },
    testPaths: paths,
    testLifecycle: lifecycle,
    setMetadata: meta,
    readPath: (path) => app.getSelfPath(path),
    readMetadata: (path) => app.getMetadata(`vessels.self.${path}`),
    complete(path, statusCode = 200) {
      const callback = completions.get(path);
      if (!callback) throw new Error("No synthetic pending command");
      completions.delete(path);
      callback({ state: "COMPLETED", statusCode });
    },
    releaseDelayed() {
      for (const resolve of delayed)
        resolve({ state: "COMPLETED", statusCode: 200 });
      delayed.clear();
    },
    start() {
      lifecycle.starts++;
      for (const [key, path] of Object.entries(paths)) {
        if (key === "missing") continue;
        for (const source of ["public", "private"])
          app.registerPutHandler(
            "vessels.self",
            path,
            handler(source, key),
            source,
          );
        meta(path, {
          supportsPut: key !== "unsupported",
          displayName: `Synthetic ${key} command`,
          description: "Integration fixture metadata; no physical device",
          ...(key === "choices"
            ? {
                type: "multiple",
                possibleValues: [
                  { title: "Off", value: "off" },
                  { title: "On", value: "on" },
                ],
              }
            : {}),
          ...(key === "constrained"
            ? { type: "number", enum: [0, 1, 2], minimum: 0, maximum: 2 }
            : {}),
        });
      }
      // A data value alone must never make a path executable.
      app.handleMessage("put-fixture", {
        context: "vessels.self",
        updates: [
          {
            source: { label: "synthetic" },
            timestamp: "2026-10-19T10:00:00.000Z",
            values: [
              { path: paths.missing, value: 0 },
              { path: "navigation.speedOverGround", value: 0 },
            ],
          },
        ],
      });
    },
    stop() {
      lifecycle.stops++;
      completions.clear();
      for (const resolve of delayed)
        resolve({ state: "COMPLETED", statusCode: 503 });
      delayed.clear();
    },
  };
};
