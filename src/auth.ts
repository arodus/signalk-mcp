import type { ServerAPI } from "@signalk/server-api";

export interface Principal {
  identifier: string;
  permissions: string;
}
interface Connection {
  headers: { authorization: string };
  skIsAuthenticated?: boolean;
  skPrincipal?: Principal;
}
interface Security {
  isDummy(): boolean;
  authorizeWS(connection: Connection): void;
  checkACL(
    id: string,
    context: string,
    path: string,
    source: string,
    operation: string,
  ): boolean;
}
export type App = ServerAPI & { securityStrategy?: Partial<Security> };
export class GatewayError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 400,
  ) {
    super(code);
  }
}

// These are version-sensitive Signal K internals. No keys/configuration are read,
// and no JWTs are decoded, signed, cached or verified by this plugin.
function security(app: App): Security {
  const strategy = app.securityStrategy;
  if (
    !strategy ||
    typeof strategy.isDummy !== "function" ||
    strategy.isDummy() !== false ||
    typeof strategy.authorizeWS !== "function" ||
    typeof strategy.checkACL !== "function"
  ) {
    throw new GatewayError("SIGNALK_SECURITY_UNAVAILABLE", 503);
  }
  return strategy as Security;
}
export function authenticate(
  app: App,
  authorization: string | undefined,
): Principal {
  const strategy = security(app);
  if (!authorization || !/^Bearer [^\s]+$/.test(authorization))
    throw new GatewayError("BEARER_TOKEN_REQUIRED", 401);
  // A fresh connection containing only the bearer header prevents a cookie,
  // query token or existing request principal from overriding the bearer token.
  const connection: Connection = { headers: { authorization } };
  try {
    strategy.authorizeWS(connection);
  } catch {
    throw new GatewayError("INVALID_TOKEN", 401);
  }
  const principal = connection.skPrincipal;
  if (
    connection.skIsAuthenticated !== true ||
    !principal ||
    typeof principal.identifier !== "string" ||
    principal.identifier === "AUTO" ||
    !principal.identifier ||
    !["readonly", "readwrite", "admin"].includes(principal.permissions)
  ) {
    throw new GatewayError("PERMISSION_DENIED", 403);
  }
  return Object.freeze({
    identifier: principal.identifier,
    permissions: principal.permissions,
  });
}
export function canRead(
  app: App,
  principal: Principal,
  path: string,
  source: string,
): boolean {
  if (!["readonly", "readwrite", "admin"].includes(principal.permissions))
    return false;
  return (
    security(app).checkACL(
      principal.identifier,
      "vessels.self",
      path,
      source,
      "read",
    ) === true
  );
}
