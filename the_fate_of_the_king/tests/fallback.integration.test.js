jest.mock("../llm", () => ({
  callLLMJson: jest.fn(() => {
    throw new Error("LLM error");
  }),
}));

const { generateCard } = require("./safe-generate-card");
const { CARD_SCHEMA } = require("../schema/card-schema");
const { makeValidator } = require("../validator/validator.js");

const validateCard = makeValidator(CARD_SCHEMA.schema);

const fallbackCard = {
  title: "Fallback Card",
  choices: [
    { text: "Option 1", effects: { army: 0, economy: 0, loyalty: 0, diplomacy: 0 } },
    { text: "Option 2", effects: { army: 0, economy: 0, loyalty: 0, diplomacy: 0 } },
  ],
};

describe("fallback pipeline integration", () => {
  it("returns fallback card when LLM fails", async () => {
    const { card, validation } = await generateCard("Create a card about a rebellion.");

    expect(card).toBeDefined();
    expect(validation.ok).toBe(true);
    expect(validateCard(card).ok).toBe(true);

    expect(card).toEqual(expect.objectContaining({
      title: fallbackCard.title,
      choices: fallbackCard.choices,
    }));
  });
});