const ARC_SEED_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "kind", "expectedTurns", "triggerMetric"],
  properties: {
    title: { type: "string", minLength: 1, maxLength: 80 },

    kind: {
      type: "string",
      enum: ["rebellion", "war", "famine", "plague", "church", "intrigue", "succession", "trade"]
    },

    expectedTurns: { type: "integer", minimum: 2, maximum: 8 },

    triggerMetric: {
      type: "string",
      enum: ["army", "economy", "loyalty", "diplomacy"]
    },

    stakes: { type: "string", maxLength: 160 }
  }
};

module.exports = { ARC_SEED_SCHEMA };
