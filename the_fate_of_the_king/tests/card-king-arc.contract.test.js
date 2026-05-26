const { makeValidator } = require("../validator/validator.js");
const { CARD_SCHEMA } = require("../schema/card-schema");
const { KING_SCHEMA } = require("../schema/king-schema");
const { ARC_SEED_SCHEMA } = require("../schema/arc-seed-schema");

const validCard = {
  title: "Siege of the Northern Stronghold",
  description: "The enemy army approaches with banners aloft. Your courtiers demand immediate action.",
  choices: [
    {
      text: "Launch a pre-emptive strike",
      effects: { army: -5, economy: -8, loyalty: 2, diplomacy: -2 }
    },
    {
      text: "Fortify walls and pray",
      effects: { army: 3, economy: -4, loyalty: 1, diplomacy: 0 }
    }
  ]
};

const validCardWithArc = {
  ...validCard,
  arc: {
    title: "The Northern Rebellion",
    kind: "rebellion",
    expectedTurns: 4,
    triggerMetric: "loyalty",
    stakes: "If the rebellion spreads, the northern provinces will secede."
  }
};

const validKing = {
  name: "Aldric the Wise",
  age: 32,
  description: "A merchant prince turned king through cunning diplomacy and strategic marriages."
};

const validateCard = makeValidator(CARD_SCHEMA.schema);
const validateKing = makeValidator(KING_SCHEMA.schema);
const validateArcSeed = makeValidator(ARC_SEED_SCHEMA);

describe("contract tests: mocked card schema ", () => {
  test("valid card without arc", () => {
    const result = validateCard(validCard);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("valid card with arc", () => {
    const result = validateCard(validCardWithArc);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("missed required field title", () => {
    const invalid = { ...validCard };
    delete invalid.title;
    const result = validateCard(invalid);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].message).toMatch(/required/);
  });

  test("missed required field choices", () => {
    const invalid = { ...validCard, choices: [validCard.choices[0]] };
    const result = validateCard(invalid);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].message).toMatch(/must NOT have fewer than 2 items|minItems/);
  });

  test("invalid choices structure", () => {
    const invalid = {
      title: "Haunted Feast",
      description: "A cursed banquet drains morale.",
      choices: "not-an-array"
    };
    const result = validateCard(invalid);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].message).toMatch(/must be array/);
  });

  test("missed effect in choice", () => {
    const invalid = {
      ...validCard,
      choices: [{ text: "Choice without effects" }, validCard.choices[1]]
    };
    const result = validateCard(invalid);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("effect value out of range", () => {
    const invalid = {
      ...validCard,
      choices: [
        { ...validCard.choices[0], effects: { ...validCard.choices[0].effects, army: 50 } },
        validCard.choices[1]
      ]
    };
    const result = validateCard(invalid);
    expect(result.ok).toBe(false);
  });
});

describe("contract tests: mocked arc seed (nested in card)", () => {
  test("valid arc seed", () => {
    const arc = validCardWithArc.arc;
    const result = validateArcSeed(arc);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("arc missed required field kind", () => {
    const invalid = { ...validCardWithArc.arc };
    delete invalid.kind;
    const result = validateArcSeed(invalid);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("arc with invalid kind", () => {
    const invalid = { ...validCardWithArc.arc, kind: "invalid_kind" };
    const result = validateArcSeed(invalid);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("arc expectedTurns out of range", () => {
    const invalid = { ...validCardWithArc.arc, expectedTurns: 1 };
    const result = validateArcSeed(invalid);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("arc with invalid triggerMetric", () => {
    const invalid = { ...validCardWithArc.arc, triggerMetric: "invalid_metric" };
    const result = validateArcSeed(invalid);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("arc stakes exceed max length", () => {
    const invalid = { ...validCardWithArc.arc, stakes: "x".repeat(161) };
    const result = validateArcSeed(invalid);
    expect(result.ok).toBe(false);
  });

  test("card with invalid nested arc", () => {
    const invalidCard = {
      ...validCard,
      arc: { ...validCardWithArc.arc, kind: "not_a_kind" }
    };
    const result = validateCard(invalidCard);
    expect(result.ok).toBe(false);
  });
});

describe("contract tests: mocked king schema ", () => {
  test("valid king", () => {
    const result = validateKing(validKing);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("missed required field name ", () => {
    const invalid = { ...validKing };
    delete invalid.name;
    const result = validateKing(invalid);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].message).toMatch(/required/);
  });

  test("missed required field age", () => {
    const invalid = { ...validKing };
    delete invalid.age;
    const result = validateKing(invalid);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("missed required field description", () => {
    const invalid = { ...validKing };
    delete invalid.description;
    const result = validateKing(invalid);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("age out of  minimum range", () => {
    const invalid = { ...validKing, age: 10 };
    const result = validateKing(invalid);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("age out of maximum range", () => {
    const invalid = { ...validKing, age: 100 };
    const result = validateKing(invalid);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("age is not integer", () => {
    const invalid = { ...validKing, age: 32.5 };
    const result = validateKing(invalid);
    expect(result.ok).toBe(false);
  });

  test("name exceed max length", () => {
    const invalid = { ...validKing, name: "x".repeat(61) };
    const result = validateKing(invalid);
    expect(result.ok).toBe(false);
  });

  test("description exceed max length", () => {
    const invalid = { ...validKing, description: "x".repeat(801) };
    const result = validateKing(invalid);
    expect(result.ok).toBe(false);
  });

  test("king field with empty name", () => {
    const invalid = { ...validKing, name: "" };
    const result = validateKing(invalid);
    expect(result.ok).toBe(false);
  });
});
