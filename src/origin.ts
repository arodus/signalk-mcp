import { GatewayError } from "./auth.js";

// Signal K's CORS middleware runs before plugin routes. Its response header is
// the host's decision; never use an incoming Access-Control-Allow-Origin header.
export function validateOrigin(
  origin: string | undefined,
  allowed: unknown,
): void {
  if (origin === undefined) return;
  let valid = false;
  try {
    const url = new URL(origin);
    valid = /^https?:$/.test(url.protocol) && url.origin === origin;
  } catch {
    // Invalid and opaque origins fail closed, even under a wildcard policy.
  }
  if (!valid || (allowed !== "*" && allowed !== origin)) {
    throw new GatewayError("ORIGIN_DENIED", 403);
  }
}
