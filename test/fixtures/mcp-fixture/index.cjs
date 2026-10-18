// Synthetic provider used only by the isolated real-server integration tests.
module.exports = (app) => {
  const calls = {
    reads: 0,
    writes: 0,
    unapproved: 0,
    history: 0,
    disconnected: 0,
  };
  let historyMode = "valid";
  let heldRead;
  async function waitForRelease(kind) {
    if (heldRead?.kind !== kind) return;
    const pending = heldRead;
    heldRead = undefined;
    pending.entered();
    await pending.released;
  }
  const document = {
    openapi: "3.0.3",
    info: { title: "Fixture", version: "1" },
    servers: [{ url: "http://must-never-be-contacted.invalid" }],
    components: {
      schemas: { Scale: { type: "integer", minimum: 1, maximum: 4 } },
    },
    paths: {
      "/reading/{name}": {
        get: {
          operationId: "readReading",
          summary: "Read a fixture measurement",
          parameters: [
            {
              name: "name",
              in: "path",
              required: true,
              schema: { type: "string", maxLength: 32 },
            },
            {
              name: "scale",
              in: "query",
              schema: { $ref: "#/components/schemas/Scale" },
            },
          ],
        },
      },
      "/admin-reading": { get: { operationId: "adminReading" } },
      "/unapproved": { get: { operationId: "unapproved" } },
      "/write": { post: { operationId: "write" } },
      "/redirect": { get: { operationId: "redirect" } },
      "/bad-schema": {
        get: {
          operationId: "badSchema",
          parameters: [
            {
              name: "filter",
              in: "query",
              schema: {
                $ref: "http://must-never-be-contacted.invalid/schema.json",
              },
            },
          ],
        },
      },
    },
  };
  return {
    id: "mcp-fixture",
    name: "MCP test fixture",
    description: "Synthetic tests only",
    schema: { type: "object", properties: {} },
    testCalls: calls,
    testDocument: document,
    holdNextRead(kind) {
      if (heldRead) throw new Error("A fixture read is already held");
      let entered, release;
      const started = new Promise((resolve) => {
        entered = resolve;
      });
      const released = new Promise((resolve) => {
        release = resolve;
      });
      heldRead = { kind, entered, released };
      return { started, release };
    },
    setHistoryMode: (mode) => {
      historyMode = mode;
    },
    start() {
      app.registerHistoryApiProvider({
        getContexts: async () => ["vessels.self"],
        getPaths: async () => ["navigation.speedOverGround"],
        async getValues(query) {
          calls.history++;
          await waitForRelease("history");
          if (historyMode === "error")
            throw new Error("synthetic provider error");
          const values = query.pathSpecs.map((spec) => ({
            path: spec.path,
            method: spec.aggregate,
            $source: spec.sourceRef,
          }));
          if (historyMode === "wrong-source")
            values[0].$source = "private-source.XX";
          if (historyMode === "missing-source") delete values[0].$source;
          const response = {
            context: "vessels.self",
            range: { from: query.from.toString(), to: query.to.toString() },
            values,
            data: [[query.from.toString(), ...values.map(() => 0)]],
          };
          if (historyMode === "wrong-context")
            response.context = "vessels.someone-else";
          if (historyMode === "wrong-path")
            values[0].path = "electrical.secret";
          if (historyMode === "extra-column") response.data[0].push("hidden");
          return response;
        },
      });
    },
    stop() {
      app.unregisterHistoryApiProvider();
    },
    getOpenApi: () => document,
    registerWithRouter(router) {
      router.access("readonly").get("/reading/:name", async (req, res) => {
        res.once("close", () => {
          if (!res.writableFinished) calls.disconnected++;
        });
        if (
          !app.securityStrategy.checkACL(
            req.skPrincipal.identifier,
            "vessels.self",
            "navigation.speedOverGround",
            "fixture.XX",
            "read",
          )
        )
          return res.sendStatus(403);
        calls.reads++;
        await waitForRelease("plugin");
        res.json({
          principal: req.skPrincipal.identifier,
          name: req.params.name,
          value: 42 * Number(req.query.scale ?? 1),
          cookieSeen: !!req.headers.cookie,
        });
      });
      router.get("/admin-reading", (req, res) => {
        calls.reads++;
        res.json({ principal: req.skPrincipal.identifier });
      });
      router.access("readonly").get("/unapproved", (_req, res) => {
        calls.unapproved++;
        res.json({ value: 1 });
      });
      router.access("readonly").post("/write", (_req, res) => {
        calls.writes++;
        res.json({ done: true });
      });
      router
        .access("readonly")
        .get("/redirect", (_req, res) =>
          res.redirect("http://must-never-be-contacted.invalid/steal"),
        );
    },
  };
};
