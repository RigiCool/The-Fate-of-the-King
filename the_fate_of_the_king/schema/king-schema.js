const KING_SCHEMA = {
  name: "king",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["name", "age", "description"],
    properties: {
      name: { type: "string", minLength: 1, maxLength: 60 },
      age: { type: "integer", minimum: 14, maximum: 60 },
      description: { type: "string", minLength: 1, maxLength: 800 }
    }
  }
};

module.exports = { KING_SCHEMA };

