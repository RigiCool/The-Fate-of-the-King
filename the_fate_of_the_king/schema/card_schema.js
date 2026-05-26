const CARD_SCHEMA = {
  name: "card",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["title", "description", "choices"],
    properties: {
      title: { type: "string", minLength: 1, maxLength: 120, description: "Короткий заголовок ситуации" },
      description: { type: "string", minLength: 1, maxLength: 800, description: "Описание ситуации перед королём" },
      choices: {
        type: "array",
        minItems: 2,
        maxItems: 2,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["text", "effects"],
          properties: {
            text: { type: "string", minLength: 1, maxLength: 180 },
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