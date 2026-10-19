// Synthetic plugin: npm package name and native plugin ID intentionally differ.
module.exports = () => {
  const calls = { reads: 0 };
  return {
    id: "AdvancedWind",
    name: "Mixed-case discovery test fixture",
    schema: { type: "object", properties: {} },
    testCalls: calls,
    start() {},
    stop() {},
    getOpenApi: () => ({
      openapi: "3.0.3",
      paths: {
        "/reading": { get: { operationId: "read" } },
        "/approved": { get: { operationId: "readApproved" } },
      },
    }),
    registerWithRouter(router) {
      for (const route of ["/reading", "/approved"])
        router.access("readonly").get(route, (_req, res) => {
          calls.reads++;
          res.json({ value: 0 });
        });
    },
  };
};
