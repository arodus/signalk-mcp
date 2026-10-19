import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import type { Request } from "express";
import { GatewayError } from "../auth.js";
import { boundedJson } from "../json.js";
import type { LocalActions } from "../put-types.js";

export type LocalGet = (path: string) => Promise<unknown>;

export class NativeActionHttpError extends GatewayError {
  constructor(public readonly httpStatus: number) {
    super("NATIVE_PUT_HTTP_ERROR", httpStatus);
  }
}

// The network destination comes only from the accepted server socket, never
// from client input, Host, proxy headers, OpenAPI servers or redirects.
export function localGet(
  req: Request,
  authorization: string,
  signal: AbortSignal,
  tlsServerName?: string,
): LocalGet {
  const localAddress = req.socket.localAddress;
  // Node/OpenSSL versions disagree on matching mapped IPv6 certificate SANs.
  // Use the equivalent IPv4 literal, still derived only from the same socket.
  const mappedV4 = localAddress?.startsWith("::ffff:")
    ? localAddress.slice(7)
    : undefined;
  const hostname = mappedV4 && isIP(mappedV4) === 4 ? mappedV4 : localAddress;
  const port = req.socket.localPort;
  const encrypted = "encrypted" in req.socket && req.socket.encrypted === true;
  return async (path) => {
    if (!hostname || !port)
      throw new GatewayError("LOCAL_HTTP_UNAVAILABLE", 503);
    if (
      (!/^\/(?:skServer\/openapi\/plugins\/|plugins\/|signalk\/v2\/api\/history\/)/.test(
        path,
      ) &&
        path !== "/signalk/v2/api/notifications") ||
      /[\r\n\\#]/.test(path)
    ) {
      throw new GatewayError("INVALID_LOCAL_ROUTE");
    }
    return new Promise((resolve, reject) => {
      const request = (encrypted ? https : http).request(
        {
          hostname,
          port,
          method: "GET",
          path,
          ...(encrypted && tlsServerName ? { servername: tlsServerName } : {}),
          headers: { Authorization: authorization, Accept: "application/json" },
          signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
        },
        (response) => {
          const status = response.statusCode ?? 500;
          if (status < 200 || status >= 300) {
            response.destroy();
            reject(
              new GatewayError(
                status === 401 || status === 403
                  ? "UPSTREAM_PERMISSION_DENIED"
                  : status === 404 || status === 501
                    ? "CAPABILITY_UNAVAILABLE"
                    : "UPSTREAM_HTTP_ERROR",
                status,
              ),
            );
            return;
          }
          if (
            !/^application\/(?:[\w.-]+\+)?json(?:;|$)/i.test(
              response.headers["content-type"] ?? "",
            )
          ) {
            response.destroy();
            reject(new GatewayError("UPSTREAM_NOT_JSON"));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > 256 * 1024) {
              response.destroy();
              reject(new GatewayError("OUTPUT_LIMIT"));
            } else chunks.push(chunk);
          });
          response.on("error", () =>
            reject(new GatewayError("UPSTREAM_RESPONSE_FAILED")),
          );
          response.on("end", () => {
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            } catch {
              reject(new GatewayError("UPSTREAM_INVALID_JSON"));
            }
          });
        },
      );
      request.on("error", () =>
        reject(new GatewayError("UPSTREAM_UNAVAILABLE", 503)),
      );
      request.end();
    });
  };
}

// Only these two native routes are writable/readable through this adapter.
// It deliberately does not share the broader plugin GET route allowlist.
export function localActions(
  req: Request,
  authorization: string,
  signal: AbortSignal,
  tlsServerName?: string,
): LocalActions {
  const localAddress = req.socket.localAddress;
  const mappedV4 = localAddress?.startsWith("::ffff:")
    ? localAddress.slice(7)
    : undefined;
  const hostname = mappedV4 && isIP(mappedV4) === 4 ? mappedV4 : localAddress;
  const port = req.socket.localPort;
  const encrypted = "encrypted" in req.socket && req.socket.encrypted === true;
  const send = async (method: "PUT" | "GET", path: string, body?: unknown) => {
    if (!hostname || !port)
      throw new GatewayError("LOCAL_HTTP_UNAVAILABLE", 503);
    const serialized =
      method === "PUT"
        ? boundedJson(body, 64 * 1024, "INPUT_LIMIT")
        : undefined;
    return new Promise<unknown>((resolve, reject) => {
      const request = (encrypted ? https : http).request(
        {
          hostname,
          port,
          method,
          path,
          ...(encrypted && tlsServerName ? { servername: tlsServerName } : {}),
          headers: {
            Authorization: authorization,
            Accept: "application/json",
            ...(serialized === undefined
              ? {}
              : {
                  "Content-Type": "application/json",
                  "Content-Length": Buffer.byteLength(serialized),
                }),
          },
          signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
        },
        (response) => {
          const status = response.statusCode ?? 500;
          if (status >= 300 && status < 400) {
            response.destroy();
            reject(new GatewayError("NATIVE_PUT_REDIRECT_REFUSED"));
            return;
          }
          if (
            !/^application\/(?:[\w.-]+\+)?json(?:;|$)/i.test(
              response.headers["content-type"] ?? "",
            )
          ) {
            response.destroy();
            reject(new GatewayError("UPSTREAM_NOT_JSON"));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > 224 * 1024) {
              response.destroy();
              reject(new GatewayError("OUTPUT_LIMIT"));
            } else chunks.push(chunk);
          });
          response.on("error", () =>
            reject(new GatewayError("UPSTREAM_RESPONSE_FAILED")),
          );
          response.on("end", () => {
            try {
              const result: unknown = JSON.parse(
                Buffer.concat(chunks).toString("utf8"),
              );
              // Native action failures may use HTTP 4xx/5xx and still contain
              // a fully correlated native reply. Preserve that reply unchanged.
              if (
                (status < 200 || status >= 300) &&
                !(
                  typeof result === "object" &&
                  result !== null &&
                  "requestId" in result
                )
              ) {
                reject(new NativeActionHttpError(status));
              } else resolve(result);
            } catch {
              reject(new GatewayError("UPSTREAM_INVALID_JSON"));
            }
          });
        },
      );
      request.on("error", () =>
        reject(new GatewayError("UPSTREAM_UNAVAILABLE", 503)),
      );
      request.end(serialized);
    });
  };
  return {
    put: (path, body) => {
      if (
        !/^\/signalk\/v1\/api\/vessels\/self\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(
          path,
        ) ||
        path
          .split("/")
          .some((part) =>
            ["meta", "__proto__", "prototype", "constructor"].includes(part),
          )
      )
        throw new GatewayError("INVALID_LOCAL_ROUTE");
      return send("PUT", path, body);
    },
    getRequest: (id) => {
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          id,
        )
      )
        throw new GatewayError("INVALID_LOCAL_ROUTE");
      return send("GET", `/signalk/v1/requests/${id}`);
    },
  };
}
