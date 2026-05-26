exports.KING_SCHEMA = {
  name: "king",
  schema: {
    type: "object",
    properties: {
      name: { type: "string" },
      age: { type: "integer" },
      description: { type: "string" }
    },
    required: ["name", "age", "description"],
    additionalProperties: false
  }
};

schema/king_schema.js
