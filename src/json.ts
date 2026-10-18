import { GatewayError } from "./auth.js";

// Count UTF-8 JSON bytes during serialization, before an oversized string or
// repeated value can allocate the full result. The native serializer still
// defines escaping, omitted fields, toJSON, array holes and circular errors.
export function boundedJson(
  value: unknown,
  limit: number,
  code = "OUTPUT_LIMIT",
  status = 400,
): string {
  let bytes = 0;
  let root = true;
  const children = new WeakMap<object, number>();
  const add = (amount: number) => {
    bytes += amount;
    if (bytes > limit) throw new GatewayError(code, status);
  };
  const stringBytes = (text: string) => {
    // Each UTF-16 code unit needs at least one byte in its JSON spelling.
    // Avoid quoting/copying a huge native model string just to reject it.
    if (text.length > limit - bytes) throw new GatewayError(code, status);
    return Buffer.byteLength(JSON.stringify(text));
  };
  const text = JSON.stringify(value, function (key, current) {
    const scalar =
      current instanceof String ||
      current instanceof Number ||
      current instanceof Boolean
        ? current.valueOf()
        : current;
    const omitted = ["undefined", "function", "symbol"].includes(typeof scalar);
    if (!root && omitted && !Array.isArray(this)) return current;
    if (!root) {
      const count = children.get(this) ?? 0;
      if (count) add(1); // comma
      children.set(this, count + 1);
      if (!Array.isArray(this)) add(stringBytes(key) + 1); // key and colon
    }
    root = false;
    if (scalar === null || omitted) add(4);
    else if (typeof scalar === "string") add(stringBytes(scalar));
    else if (typeof scalar === "object") {
      add(2); // brackets/braces; children are counted as they are visited
      children.set(current, 0);
    } else add(Buffer.byteLength(JSON.stringify(scalar)));
    return current;
  });
  if (text === undefined) throw new GatewayError("DATA_ACCESS_FAILED");
  // Retain the final wire-data check for non-JSON-native objects (for example
  // JSON.rawJSON) whose special serializer behavior can bypass child visits.
  if (Buffer.byteLength(text) > limit) throw new GatewayError(code, status);
  return text;
}
