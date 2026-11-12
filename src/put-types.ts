/** A single native action target. Signal K selects the native handler. */
export interface PutTarget {
  context: "vessels.self";
  path: string;
  /** Retained only when decoding legacy saved reviews. */
  source?: string;
  metadata: Record<string, unknown>;
  inputSchema: Record<string, unknown>;
}

/** Fixed-local native HTTP operations; callers cannot supply a destination. */
export interface LocalActions {
  put(path: string, body: { value: unknown }): Promise<unknown>;
  getRequest(id: string): Promise<unknown>;
}
