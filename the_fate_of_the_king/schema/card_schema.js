const CARD_SCHEMA = {
  name: "card",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["title", "description", "choices"],
    properties: {
      title: { type: "string", description: "Короткий заголовок ситуации" },
      description: { type: "string", description: "Описание ситуации перед королём" },
      choices: {
        type: "array",
        minItems: 2,
        maxItems: 2,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["text", "effects"],
          properties: {
            text: { type: "string" },
            effects: {
              type: "object",
              additionalProperties: false,
              required: ["army", "economy", "loyalty", "diplomacy"],
              properties: {
                army: { type: "integer", minimum: -20, maximum: 20 },
                economy: { type: "integer", minimum: -20, maximum: 20 },
                loyalty: { type: "integer", minimum: -20, maximum: 20 },
                diplomacy: { type: "integer", minimum: -20, maximum: 20 }
              }
            }
          }
        }
      }
    }
  }
};

module.exports = { CARD_SCHEMA };

schema/card_schema.js
