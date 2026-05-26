const { makeValidator, parseStrictJson, normalizeCard } = require('../validator/validator.js');

describe('validator helpers', () => {
  test('parseStrictJson handles various inputs', () => {
    expect(parseStrictJson(null)).toBeNull();
    expect(parseStrictJson({ a: 1 })).toEqual({ a: 1 });
    expect(parseStrictJson('not json')).toBeNull();
    expect(parseStrictJson('hello {"x":2} world')).toEqual({ x: 2 });
  });

  test('makeValidator returns errors array', () => {
    const schema = { type: 'object', properties: { a: { type: 'number' } }, required: ['a'] };
    const validatedSchema = makeValidator(schema);
    expect(validatedSchema({ a: 1 }).ok).toBe(true);
    const result = validatedSchema({ a: 'no' });
    expect(result.ok).toBe(false);
    expect(Array.isArray(result.errors)).toBe(true);
  });

  test('normalizeCard normalizes fields and limits lengths', () => {
    const card = {
      title: '  Title  ',
      description: 'Desc',
      choices: [{ text: 'yes', effects: { army: 5 } }]
    };
    const normalizedCard = normalizeCard(card);
    expect(normalizedCard.title).toBe('Title');
    expect(normalizedCard.choices.length).toBe(2);
    expect(normalizedCard.choices[0].effects.army).toBe(5);

    const longTitle = 'a'.repeat(200);
    expect(normalizeCard({ title: longTitle }).title.length).toBeLessThanOrEqual(120);
  });
});

describe('validator uncovered branches', () => {
  const validator = require('../validator/validator.js');

  test('extractFirstJsonObject handles non-string and no object', () => {
    expect(validator.extractFirstJsonObject(123)).toBeNull();
    expect(validator.extractFirstJsonObject('no braces here')).toBeNull();
    expect(validator.extractFirstJsonObject('{a:1}')).toBe('{a:1}');
    expect(validator.extractFirstJsonObject('foo {"a":1} bar')).toBe('{"a":1}');
  });

  test('clamp values correctly', () => {
    expect(validator.clamp(5, 1, 10)).toBe(5);
    expect(validator.clamp(-5, 1, 10)).toBe(1);
    expect(validator.clamp(15, 1, 10)).toBe(10);
  });

  test('normalizeCard handle missed and invalid fields and truncates', () => {
    let normalizedCard = validator.normalizeCard({ title: 'T', description: 'D' });
    expect(normalizedCard.choices.length).toBe(2);
    normalizedCard = validator.normalizeCard({ title: 'T', description: 'D', choices: [{ text: 'x', effects: { army: '7', economy: '8', loyalty: '9', diplomacy: '10' } }] });
    expect(normalizedCard.choices[0].effects.army).toBe(7);
    const longText = 'a'.repeat(200);
    normalizedCard = validator.normalizeCard({ title: longText, description: longText, choices: [{ text: longText, effects: {} }] });
    expect(normalizedCard.title.length).toBeLessThanOrEqual(120);
    expect(normalizedCard.description.length).toBeLessThanOrEqual(800);
    expect(normalizedCard.choices[0].text.length).toBeLessThanOrEqual(180);
    normalizedCard = validator.normalizeCard({ title: 'T', description: 'D', arc: { title: 'A', kind: 'war', triggerMetric: 'army', expectedTurns: 10, stakes: 's'.repeat(200) } });
    expect(normalizedCard.arc.title).toBe('A');
    expect(normalizedCard.arc.expectedTurns).toBeLessThanOrEqual(8);
    expect(normalizedCard.arc.stakes.length).toBeLessThanOrEqual(160);
  });
});
