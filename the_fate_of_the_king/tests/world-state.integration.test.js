const worldState = require('../world/world-state');

describe('world-state utilities', () => {
  test('createInitialWorldState contains proper keys', () => {
    const world = worldState.createInitialWorldState({ name: 'A', age: 30 });
    expect(world.turn).toBe(0);
    expect(world.king.name).toBe('A');
  });

  test('applyChoiceToMemory updates summaries and themes', () => {
    const base = { turn: 0, memory: { recentThemes: [] } };
    const card = { title: 'T', description: 'D', choices: [{ text: 'yes' }] };
    const updatedWorldState = worldState.applyChoiceToMemory(base, card, 0, 'foo');
    expect(updatedWorldState.turn).toBe(1);
    expect(updatedWorldState.memory.lastEventSummary).toContain('T:');
    expect(updatedWorldState.memory.recentThemes[0]).toBe('foo');
  });
});

describe('world-state uncovered branches', () => {
  const worldState = require('../world/world-state');

  test('summarizeCard handles missing/empty fields and long description', () => {
    expect(worldState.createInitialWorldState).toBeDefined();
    expect(worldState.summarizeCard({})).toBe(':');
    expect(worldState.summarizeCard({ title: 'T' })).toBe('T:');
    expect(worldState.summarizeCard({ description: 'D' })).toBe(': D');
    const longDesc = 'a'.repeat(200);
    expect(worldState.summarizeCard({ title: 'T', description: longDesc })).toBe('T: ' + 'a'.repeat(177) + '...');
  });

  test('applyChoiceToMemory handles missing choices, themes, and memory', () => {
    const base = { turn: 2 };
    const card = { title: 'T', description: 'D' };
    const updatedWorldStateStage1 = worldState.applyChoiceToMemory(base, card, 0, undefined);
    expect(updatedWorldStateStage1.turn).toBe(3);
    expect(updatedWorldStateStage1.memory.lastChoiceSummary).toBe('');
    const base2 = { turn: 1 };
    const updatedWorldStateStage2 = worldState.applyChoiceToMemory(base2, card, 0, 'bar');
    expect(updatedWorldStateStage2.memory.recentThemes[0]).toBe('bar');
    const base3 = { turn: 1, memory: { recentThemes: null } };
    const updatedWorldStateStage3 = worldState.applyChoiceToMemory(base3, card, 0, 'baz');
    expect(Array.isArray(updatedWorldStateStage3.memory.recentThemes)).toBe(true);
    expect(updatedWorldStateStage3.memory.recentThemes[0]).toBe('baz');
    const card2 = { title: 'T', description: 'D', choices: [{ text: 'x'.repeat(300) }] };
    const updatedWorldStateStage4 = worldState.applyChoiceToMemory(base, card2, 0, 'foo');
    expect(updatedWorldStateStage4.memory.lastChoiceSummary.length).toBe(220);
  });
});
