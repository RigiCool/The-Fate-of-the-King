const { makeValidator } = require("../validator/validator.js");
const { CARD_SCHEMA } = require("../schema/card-schema");
const { KING_SCHEMA } = require("../schema/king-schema");
const { generateCard, generateKing } = require("./safe-generate-card");

const validateCard = makeValidator(CARD_SCHEMA.schema);
const validateKing = makeValidator(KING_SCHEMA.schema);
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
const RUN_LLM_CONTRACT = 'false'; // change to 'true' to turn on llm contract test

const cardPrompt = `Create a single narrative card object with:
- title
- description
- exactly 2 choices
- each choice with text and effects (army/economy/loyalty/diplomacy ints -20..20)
- optionally include an arc field with: title, kind (enum: rebellion/war/famine/plague/church/intrigue/succession/trade), expectedTurns (2-8), triggerMetric (army/economy/loyalty/diplomacy), stakes
Return only valid JSON.`;

const kingPrompt = `Create a new medieval king with:
- name (1-60 chars, unique and distinct)
- age (integer 14-50)
- description (1-800 chars, origin story)
Return only valid JSON.`;

(RUN_LLM_CONTRACT ? describe : describe.skip)("LLM contract tests: Cards", () => {
  beforeAll(() => {
    if (!OPENROUTER_API_KEY) {
      console.warn("OPENROUTER_API_KEY is missing; real LLM tests will run as skipped.");
    }
  });

  test("generateCard execution 5 times)", async () => {
    if (!OPENROUTER_API_KEY) return expect(true).toBe(true);

    const runs = 5;
    let failures = 0;
    let arcFailures = 0;

    for (let i = 0; i < runs; i++) {
      const { card, validation, raw } = await generateCard(cardPrompt);
      
      if (!validation.ok) failures += 1;
      expect(card).toBeDefined();
      
      if (card && validation.ok) {
        expect(validateCard(card).ok).toBe(true);
        
        if (card.arc) arcFailures++;
      }
      
      if (card && !validation.ok) {
        console.warn(`LLM card invalid execution ${i + 1}:`, validation.errors, "raw:", raw);
      }
    }

    expect(failures).toBeLessThanOrEqual(runs);
    expect(failures).toBeLessThanOrEqual(2);
    console.log(`Card executions: ${runs - failures} passed, arc fields included ${arcFailures}/${runs - failures}`);
  }, 120000);

  test("Card generation 12 times with acceptable 15% failure", async () => {
    if (!OPENROUTER_API_KEY) return expect(true).toBe(true);

    const runs = 12;
    let failures = 0;

    for (let i = 0; i < runs; i++) {
      const { card, validation } = await generateCard(cardPrompt);
      if (!validation.ok) failures += 1;
    }

    const failureRate = failures / runs;
    expect(failureRate).toBeLessThanOrEqual(0.15);
  }, 180000);

});

(RUN_LLM_CONTRACT ? describe : describe.skip)("LLM contract tests: Kings", () => {
  test("generateKing execution 5 times", async () => {
    if (!OPENROUTER_API_KEY) return expect(true).toBe(true);

    const runs = 5;
    let failures = 0;

    for (let i = 0; i < runs; i++) {
      const { king, validation, raw } = await generateKing(kingPrompt);
      
      if (!validation.ok) failures += 1;
      expect(king).toBeDefined();
      
      if (king && validation.ok) {
        expect(validateKing(king).ok).toBe(true);
        expect(king.name).toBeTruthy();
        expect(king.age).toBeGreaterThanOrEqual(14);
        expect(king.age).toBeLessThanOrEqual(50);
        expect(king.description).toBeTruthy();
      }
      
      if (king && !validation.ok) {
        console.warn(`LLM king invalid execution ${i + 1}:`, validation.errors, "raw:", raw);
      }
    }

    expect(failures).toBeLessThanOrEqual(runs);
    expect(failures).toBeLessThanOrEqual(2);
    
    console.log(`King executions: ${runs - failures} passed`);

  }, 120000);

  test("King generation 12 times with acceptable 15% failure", async () => {
    if (!OPENROUTER_API_KEY) return expect(true).toBe(true);

    const runs = 12;
    let failures = 0;

    for (let i = 0; i < runs; i++) {
      const { king, validation } = await generateKing(kingPrompt);
      if (!validation.ok) failures += 1;
    }

    const failureRate = failures / runs;
    expect(failureRate).toBeLessThanOrEqual(0.15);
  }, 180000);

});