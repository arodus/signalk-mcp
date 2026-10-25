import { z } from "zod";

// Metadata is registered only for gateway-owned schemas.
// In particular, its custom JSON validator has an explicit schema description;
// arbitrary unrepresentable types must still fail conversion.
export const schemaMetadata = z.registry<Record<string, unknown>>();

// Keep the accepted provider timestamp spellings: optional seconds and compact
// UTC offsets are forwarded as supplied. Use Zod's calendar-date grammar.
const date = z.regexes.date.source.slice(1, -1);
const timestamp = new RegExp(
  `^${date}T(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|[+-]\\d{2}:?\\d{2})$`,
);
export const timestampSchema = z
  .string()
  .refine((value) => timestamp.test(value));
schemaMetadata.add(timestampSchema, { format: "date-time" });
// Zod 3 accepted GUID-shaped identifiers without restricting UUID variant bits.
export const uuidSchema = z.guid();

// Keep the established Draft 7 spelling of review contracts. Equivalent native
// output (for example enum vs anyOf literals) must not invalidate saved reviews.
function reviewSchema(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const schema = { ...value } as Record<string, unknown>;
  if (schema.properties && typeof schema.properties === "object")
    schema.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, item]) => [
        key,
        reviewSchema(item),
      ]),
    );
  for (const key of [
    "items",
    "anyOf",
    "allOf",
    "oneOf",
    "additionalProperties",
  ])
    if (key in schema)
      schema[key] = Array.isArray(schema[key])
        ? schema[key].map(reviewSchema)
        : reviewSchema(schema[key]);
  if (
    schema.propertyNames &&
    JSON.stringify(schema.propertyNames) === '{"type":"string"}'
  )
    delete schema.propertyNames;
  if (schema.properties && JSON.stringify(schema.additionalProperties) === "{}")
    schema.additionalProperties = true;
  if (Array.isArray(schema.items) && schema.maxItems === schema.items.length)
    delete schema.additionalItems;
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 1) {
    const alternatives = schema.anyOf as Record<string, unknown>[];
    if (
      alternatives.every(
        (item) =>
          Object.hasOwn(item, "const") && Object.keys(item).length === 2,
      )
    ) {
      const types = [...new Set(alternatives.map((item) => item.type))];
      schema.type = types.length === 1 ? types[0] : types;
      schema.enum = [...new Set(alternatives.map((item) => item.const))];
      delete schema.anyOf;
    }
  }
  if (Array.isArray(schema.allOf))
    schema.allOf = (schema.allOf as Record<string, unknown>[]).flatMap(
      ({ additionalProperties, ...item }) =>
        item.allOf && !item.type
          ? item.allOf
          : [
              additionalProperties === false
                ? item
                : {
                    ...item,
                    ...(additionalProperties === undefined
                      ? {}
                      : { additionalProperties }),
                  },
            ],
    );
  return schema;
}

export function toJsonSchema(input: z.ZodType): Record<string, unknown> {
  const { $schema, ...schema } = z.toJSONSchema(input, {
    target: "draft-07",
    io: "input",
    cycles: "throw",
    reused: "inline",
    metadata: schemaMetadata,
    override: ({ zodSchema, jsonSchema }) => {
      const extra = schemaMetadata.get(zodSchema);
      if (extra?.oneOf) delete jsonSchema.anyOf;
      // Zod can merge intersections into one object. Preserve the original
      // reviewed allOf branches and their individual bounds instead.
      if (extra?.allOf) {
        for (const key of Object.keys(jsonSchema)) delete jsonSchema[key];
        Object.assign(jsonSchema, extra);
      }
      if (
        "format" in zodSchema &&
        ["datetime", "date", "uuid", "guid"].includes(String(zodSchema.format))
      )
        delete jsonSchema.pattern;
    },
    unrepresentable: ({ zodSchema }) => {
      const extra = schemaMetadata.get(zodSchema);
      return zodSchema instanceof z.ZodCustom && extra ? extra : "throw";
    },
  });
  return { ...(reviewSchema(schema) as Record<string, unknown>), $schema };
}
