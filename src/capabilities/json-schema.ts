import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { GatewayError } from "../auth.js";
import { record } from "../data.js";

export class SchemaError extends GatewayError {
  constructor(
    public readonly location: string,
    public readonly keyword: string,
    code = "UNSUPPORTED_SCHEMA",
  ) {
    super(code);
  }
}

export function resolveSchema(
  document: unknown,
  value: unknown,
): Record<string, unknown> {
  let current = value;
  const seen = new Set<string>();
  for (let depth = 0; depth < 8; depth++) {
    if (!record(current)) throw new GatewayError("UNSUPPORTED_SCHEMA");
    if (!Object.hasOwn(current, "$ref")) return current;
    const ref = current.$ref;
    if (
      Object.keys(current).length !== 1 ||
      typeof ref !== "string" ||
      !ref.startsWith("#/components/") ||
      seen.has(ref)
    )
      throw new GatewayError("UNSUPPORTED_REFERENCE");
    seen.add(ref);
    current = document;
    for (const encoded of ref.slice(2).split("/")) {
      const part = encoded.replace(/~1/g, "/").replace(/~0/g, "~");
      if (
        !record(current) ||
        !Object.hasOwn(current, part) ||
        ["__proto__", "constructor", "prototype"].includes(part)
      )
        throw new GatewayError("UNSUPPORTED_REFERENCE");
      current = current[part];
    }
  }
  throw new GatewayError("UNSUPPORTED_REFERENCE");
}

export function safeField(name: string): boolean {
  return (
    /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) &&
    !["constructor", "prototype"].includes(name) &&
    // A description is ordinary content, not an executable script.
    (name === "description" ||
      !/token|secret|password|authorization|cookie|url|uri|host|endpoint|command|script|file|config/i.test(
        name,
      ))
  );
}

// Compile a bounded JSON subset without coercing values, applying defaults or
// dropping object properties. Unknown validation keywords fail explicitly.
export class JsonSchemaCompiler {
  private remaining = 256;
  private readonly metadata = new WeakMap<
    z.ZodTypeDef,
    Record<string, unknown>
  >();
  constructor(private readonly document: unknown) {}
  json(input: z.ZodTypeAny): object {
    return zodToJsonSchema(input, {
      $refStrategy: "none",
      postProcess: (json, def) => {
        const extra = this.metadata.get(def);
        if (!json || !extra) return json;
        const result = { ...json, ...extra };
        if ("oneOf" in extra) delete (result as Record<string, unknown>).anyOf;
        return result;
      },
    });
  }
  private jsonValue(): z.ZodTypeAny {
    const value = z.custom<unknown>((input) => {
      let remaining = 2048;
      const visit = (item: unknown, depth: number): boolean => {
        if (depth > 8 || --remaining < 0) return false;
        if (item === null || typeof item === "boolean") return true;
        if (typeof item === "string") return item.length <= 16384;
        if (typeof item === "number")
          return Number.isFinite(item) && Math.abs(item) <= 1e12;
        if (Array.isArray(item))
          return (
            item.length <= 128 && item.every((child) => visit(child, depth + 1))
          );
        if (
          !record(item) ||
          ![Object.prototype, null].includes(Object.getPrototypeOf(item)) ||
          Object.keys(item).length > 32
        )
          return false;
        return Object.entries(item).every(
          ([key, child]) => safeField(key) && visit(child, depth + 1),
        );
      };
      return visit(input, 0);
    }, "Expected bounded JSON data with supported property names");
    this.metadata.set(value._def, {
      description:
        "JSON value: depth at most 8, 2048 nodes, 128 array items, 32 object keys, 16384 characters per string and finite numbers between -1e12 and 1e12. Credential, URL, command, script, file and configuration property names are excluded.",
    });
    return value;
  }
  parse(
    raw: unknown,
    location: string,
    scalar = false,
    depth = 0,
    additionalKeys: string[] = [],
  ): z.ZodTypeAny {
    const fail = (keyword: string): never => {
      throw new SchemaError(location, keyword);
    };
    if (depth > 8 || --this.remaining < 0) fail("schema-limit");
    let schema: Record<string, unknown>;
    try {
      schema = resolveSchema(this.document, raw);
    } catch (error) {
      if (error instanceof GatewayError)
        throw new SchemaError(
          location,
          error.code === "UNSUPPORTED_REFERENCE" ? "$ref" : "schema",
          error.code,
        );
      throw error;
    }
    const annotations = [
      "description",
      "title",
      "default",
      "example",
      "examples",
      "deprecated",
    ];
    const common = [...annotations, "type", "enum", "nullable"];
    const typed: Record<string, string[]> = {
      string: ["minLength", "maxLength", "format", "pattern"],
      number: [
        "minimum",
        "maximum",
        "exclusiveMinimum",
        "exclusiveMaximum",
        "format",
      ],
      integer: [
        "minimum",
        "maximum",
        "exclusiveMinimum",
        "exclusiveMaximum",
        "format",
      ],
      boolean: [],
      null: [],
      object: [
        "properties",
        "required",
        "additionalProperties",
        "minProperties",
        "maxProperties",
      ],
      array: ["items", "minItems", "maxItems", "uniqueItems"],
    };
    let type = schema.type;
    let nullable = schema.nullable === true;
    if (schema.nullable !== undefined && typeof schema.nullable !== "boolean")
      fail("nullable");
    if (Array.isArray(type)) {
      if (type.length !== 2 || !type.includes("null")) fail("type");
      type = type.find((item) => item !== "null");
      nullable = true;
    }
    if (
      scalar &&
      (nullable ||
        !["string", "number", "integer", "boolean"].includes(String(type)))
    )
      fail("parameter-type");
    const composition =
      schema.oneOf !== undefined
        ? "oneOf"
        : schema.allOf !== undefined
          ? "allOf"
          : undefined;
    const allowed =
      composition !== undefined
        ? [...annotations, composition, "nullable"]
        : [...common, ...(typed[String(type)] ?? [])];
    for (const key of Object.keys(schema))
      if (!allowed.includes(key)) fail(key);
    const count = (key: string, fallback: number, ceiling: number): number => {
      const n = schema[key] ?? fallback;
      if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > ceiling)
        fail(key);
      return n as number;
    };
    let value!: z.ZodTypeAny;
    const extra: Record<string, unknown> = {};
    if (schema.allOf !== undefined) {
      if (
        scalar ||
        !Array.isArray(schema.allOf) ||
        schema.allOf.length < 2 ||
        schema.allOf.length > 8
      )
        fail("allOf");
      const branches = (schema.allOf as unknown[]).map((item) =>
        resolveSchema(this.document, item),
      );
      // Ordinary object extension via allOf: sibling fields are known, not
      // silently stripped. Explicit additionalProperties:false stays closed.
      if (branches.some((branch) => branch.type !== "object")) fail("allOf");
      const keys = [
        ...new Set(
          branches.flatMap((branch) =>
            record(branch.properties) ? Object.keys(branch.properties) : [],
          ),
        ),
      ];
      if (keys.length > 32 || keys.some((key) => !safeField(key)))
        fail("allOf");
      const alternatives = branches.map((branch, i) =>
        this.parse(branch, `${location}.allOf[${i}]`, false, depth + 1, keys),
      );
      value = alternatives
        .slice(1)
        .reduce((prior, next) => z.intersection(prior, next), alternatives[0]!);
    } else if (schema.oneOf !== undefined) {
      if (
        scalar ||
        !Array.isArray(schema.oneOf) ||
        schema.oneOf.length < 2 ||
        schema.oneOf.length > 8
      )
        fail("oneOf");
      const alternatives = (schema.oneOf as unknown[]).map((item, i) =>
        this.parse(item, `${location}.oneOf[${i}]`, false, depth + 1),
      );
      value = z
        .union(alternatives as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]])
        .refine(
          (input) =>
            alternatives.filter(
              (alternative) => alternative.safeParse(input).success,
            ).length === 1,
          "Value must match exactly one schema",
        );
      extra.oneOf = alternatives.map((alternative) => {
        const json = { ...this.json(alternative) } as Record<string, unknown>;
        delete json.$schema;
        return json;
      });
    } else if (type === undefined && !scalar) {
      value = this.jsonValue();
    } else if (type === "string") {
      // Retain the legacy default so previously reviewed contracts keep their key.
      const ceiling = scalar ? 512 : 16384;
      const min = count("minLength", 0, ceiling),
        max = count("maxLength", 256, ceiling);
      if (max < min) fail("maxLength");
      let text = z.string().min(min).max(max);
      if (schema.format !== undefined) {
        if (schema.format === "date-time")
          text = text.datetime({ offset: true });
        else if (schema.format === "date") text = text.date();
        else if (schema.format === "uuid") text = text.uuid();
        else fail("format");
      }
      if (schema.pattern !== undefined) {
        // Only a sequence of character classes with bounded repetition: no
        // groups, alternation, lookarounds, backreferences or nested quantifiers.
        if (
          typeof schema.pattern !== "string" ||
          schema.pattern.length > 256 ||
          !/^\^(?:\[[A-Za-z0-9_-]+\](?:\{\d{1,4}(?:,\d{1,4})?\})?){1,8}\$$/.test(
            schema.pattern,
          )
        )
          fail("pattern");
        const segments = (schema.pattern as string)
          .slice(1, -1)
          .match(/\[[^\]]+\](?:\{[^}]+\})?/g)!;
        if (segments.slice(0, -1).some((part) => part.includes(",")))
          fail("pattern");
        try {
          text = text.regex(new RegExp(schema.pattern as string));
        } catch {
          fail("pattern");
        }
      }
      value = text;
    } else if (type === "integer" || type === "number") {
      const min = schema.minimum ?? -1e12,
        max = schema.maximum ?? 1e12;
      if (
        typeof min !== "number" ||
        typeof max !== "number" ||
        !Number.isFinite(min) ||
        !Number.isFinite(max) ||
        min > max
      )
        fail("minimum/maximum");
      if (
        schema.format !== undefined &&
        !(
          type === "integer" ? ["int32", "int64"] : ["float", "double"]
        ).includes(String(schema.format))
      )
        fail("format");
      let number = z
        .number()
        .finite()
        .min(Math.max(-1e12, min as number))
        .max(Math.min(1e12, max as number));
      for (const [key, bound] of [
        ["exclusiveMinimum", min],
        ["exclusiveMaximum", max],
      ] as const) {
        const exclusive = schema[key];
        if (exclusive === undefined || exclusive === false) continue;
        if (
          exclusive !== true &&
          (typeof exclusive !== "number" || !Number.isFinite(exclusive))
        )
          fail(key);
        if (
          exclusive === true &&
          schema[key === "exclusiveMinimum" ? "minimum" : "maximum"] ===
            undefined
        )
          fail(key);
        const limit =
          exclusive === true ? (bound as number) : (exclusive as number);
        number =
          key === "exclusiveMinimum" ? number.gt(limit) : number.lt(limit);
      }
      if (type === "integer") number = number.int();
      if (schema.format === "int32")
        number = number
          .min(Math.max(-2147483648, min as number))
          .max(Math.min(2147483647, max as number));
      value = number;
    } else if (type === "boolean") value = z.boolean();
    else if (type === "null") value = z.null();
    else if (type === "array" && !scalar) {
      const min = count("minItems", 0, 128),
        max = count("maxItems", 128, 128);
      if (min > max) fail("maxItems");
      if (
        schema.uniqueItems !== undefined &&
        typeof schema.uniqueItems !== "boolean"
      )
        fail("uniqueItems");
      value = z
        .array(this.parse(schema.items, `${location}.items`, false, depth + 1))
        .min(min)
        .max(max);
      if (schema.uniqueItems === true) {
        value = value.refine(
          (items: unknown[]) =>
            items.every(
              (item, i) =>
                !items
                  .slice(0, i)
                  .some((other) => isDeepStrictEqual(item, other)),
            ),
          "Duplicate array items",
        );
        extra.uniqueItems = true;
      }
    } else if (type === "object" && !scalar) {
      const props = schema.properties ?? {};
      if (!record(props) || Object.keys(props).length > 32) fail("properties");
      const required = schema.required ?? [];
      if (
        !Array.isArray(required) ||
        new Set(required).size !== required.length ||
        required.some(
          (key) =>
            typeof key !== "string" || !Object.hasOwn(props as object, key),
        )
      )
        fail("required");
      const shape: z.ZodRawShape = Object.create(null);
      for (const [name, rawProperty] of Object.entries(
        props as Record<string, unknown>,
      )) {
        if (!safeField(name))
          throw new SchemaError(`${location}.properties.${name}`, "field-name");
        const property = this.parse(
          rawProperty,
          `${location}.properties.${name}`,
          false,
          depth + 1,
        );
        shape[name] = (required as string[]).includes(name)
          ? property
          : property.optional();
      }
      if (schema.additionalProperties === undefined) {
        for (const key of additionalKeys)
          if (!Object.hasOwn(shape, key))
            shape[key] = this.jsonValue().optional();
      }
      let object = z.object(shape).strict();
      if (
        schema.additionalProperties !== undefined &&
        schema.additionalProperties !== false
      ) {
        if (
          schema.additionalProperties !== true &&
          !record(schema.additionalProperties)
        )
          fail("additionalProperties");
        object = object.catchall(
          schema.additionalProperties === true
            ? this.jsonValue()
            : this.parse(
                schema.additionalProperties,
                `${location}.additionalProperties`,
                false,
                depth + 1,
              ),
        );
      }
      value = object;
      const min = count("minProperties", 0, 32),
        max = count("maxProperties", 32, 32);
      if (min > max) fail("maxProperties");
      // Fixed-shape legacy objects already have a 32-key bound. Add refinements
      // only where needed, preserving their previously generated review schema.
      if (
        schema.minProperties !== undefined ||
        schema.maxProperties !== undefined ||
        record(schema.additionalProperties) ||
        schema.additionalProperties === true
      ) {
        value = value.refine(
          (input) =>
            Object.keys(input).length >= min &&
            Object.keys(input).length <= max &&
            Object.keys(input).every(
              (key) =>
                /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(key) &&
                !["__proto__", "constructor", "prototype"].includes(key) &&
                (key === "description" ||
                  !/token|secret|password|authorization|cookie|url|uri|host|endpoint|command|script|file|config/i.test(
                    key,
                  )),
            ),
          "Invalid object keys or property count",
        );
        extra.minProperties = min;
        extra.maxProperties = max;
      }
    } else fail("type");
    if (Object.keys(extra).length) this.metadata.set(value._def, extra);
    if (nullable) value = value.nullable();
    if (schema.enum !== undefined) {
      if (
        !Array.isArray(schema.enum) ||
        schema.enum.length < 1 ||
        schema.enum.length > 32 ||
        schema.enum.some(
          (item) =>
            (item !== null &&
              !["string", "number", "boolean"].includes(typeof item)) ||
            !value.safeParse(item).success,
        )
      )
        fail("enum");
      const literals = (
        schema.enum as (string | number | boolean | null)[]
      ).map((choice) => z.literal(choice));
      value =
        literals.length === 1
          ? literals[0]!
          : z.union(
              literals as [
                z.ZodLiteral<string | number | boolean | null>,
                z.ZodLiteral<string | number | boolean | null>,
                ...z.ZodLiteral<string | number | boolean | null>[],
              ],
            );
    }
    return value;
  }
}
