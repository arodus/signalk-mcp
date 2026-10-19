/** A single native action target. Its source is explicit, never a wildcard. */
export interface PutTarget {
  context: "vessels.self";
  path: string;
  source: string;
  metadata: Record<string, unknown>;
  inputSchema: Record<string, unknown>;
}

/** Fixed-local native HTTP operations; callers cannot supply a destination. */
export interface LocalActions {
  put(path: string, body: { value: unknown; source: string }): Promise<unknown>;
  getRequest(id: string): Promise<unknown>;
}
