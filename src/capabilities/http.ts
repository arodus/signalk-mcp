import http from "node:http";
import https from "node:https";
import type { Request } from "express";
import { GatewayError } from "../auth.js";

export type LocalGet = (path: string) => Promise<unknown>;

// The network destination comes only from the accepted server socket, never
// from client input, Host, proxy headers, OpenAPI servers or redirects.
export function localGet(
  req: Request,
  authorization: string,
  signal: AbortSignal,
): LocalGet {
  const hostname = req.socket.localAddress;
  const port = req.socket.localPort;
  const encrypted = "encrypted" in req.socket && req.socket.encrypted === true;
  return async (path) => {
    if (!hostname || !port)
      throw new GatewayError("LOCAL_HTTP_UNAVAILABLE", 503);
    if (
      !/^\/(?:skServer\/openapi\/plugins\/|plugins\/|signalk\/v2\/api\/history\/)/.test(
        path,
      ) ||
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
