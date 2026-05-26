const arcManager = require('../world/arc-manager');

describe('arc-manager main functionality coverage', () => {
  test('clampInt and randInt testing', () => {
    expect(arcManager.clampInt('5', 1, 10)).toBe(5);
    expect(arcManager.clampInt('x', 1, 10)).toBe(1);
    const randomInteger = arcManager.randInt(1, 3);
    expect(randomInteger).toBeGreaterThanOrEqual(1);
    expect(randomInteger).toBeLessThanOrEqual(3);
  });

  test('getLowestMetric and getKindByMetric testing', () => {
    expect(arcManager.getLowestMetric({ army: 10, economy: 5 })).toBe('economy');
    expect(arcManager.getKindByMetric('loyalty')).toBe('rebellion');
    const outcome = arcManager.getArcOutcome('war', 'failed', 'army');
    expect(outcome).toContain('army');
  });

  test('clamp and enforceArcSeedTurns testing', () => {
    expect(arcManager.clamp(5, 1, 10)).toBe(5);
    expect(arcManager.clamp(0, 1, 10)).toBe(1);
    const seed = { expectedTurns: 100 };
    const enforced = arcManager.enforceArcSeedTurns(seed, 2);
    expect(enforced.expectedTurns).toBe(arcManager.ARC_LEN_MIN);
    expect(arcManager.enforceArcSeedTurns(null, 4)).toEqual({ expectedTurns: 4 });
  });

  test('getLongArcStakesHint variation testing', () => {
    const hint = arcManager.getLongArcStakesHint('');
    expect(hint).toContain('Long Arc');
    const short = arcManager.getLongArcStakesHint('short');
    expect(short).toContain('short');
    const long = arcManager.getLongArcStakesHint('a'.repeat(200));
    expect(long.length).toBeGreaterThan(120);
  });

  test('getArcGap and getArcLengthFromHistory testing', () => {
    const gap = arcManager.getArcGap();
    expect(gap).toBeGreaterThanOrEqual(arcManager.ARC_GAP_MIN);
    expect(gap).toBeLessThanOrEqual(arcManager.ARC_GAP_MAX);
    const len1 = arcManager.getArcLengthFromHistory([3, 3, 3, 3, 3, 3]);
    expect(len1).toBeGreaterThanOrEqual(3);
    const len2 = arcManager.getArcLengthFromHistory([6, 6, 6, 6]);
    expect(len2).toBeGreaterThanOrEqual(3);
  });

  test('normalizeArcSeed reject invalid kinds and metrics', () => {
    expect(arcManager.normalizeArcSeed({ title: 't', kind: 'x', triggerMetric: 'army' })).toBeNull();
    expect(arcManager.normalizeArcSeed({ title: 't', kind: 'war', triggerMetric: 'x' })).toBeNull();
  });

  test('ensureArcCadenceMemory default return testing', () => {
    const result = arcManager.ensureArcCadenceMemory();
    expect(result.nextArcStartTurn).toBe(3);
    expect(Array.isArray(result.arcLengthHistory)).toBe(true);
  });

  test('isArcStartEligible use nextArcStartTurn', () => {
    expect(arcManager.isArcStartEligible({ memory: { nextArcStartTurn: 5 }, currentTurn: 4 })).toBe(false);
    expect(arcManager.isArcStartEligible({ memory: { nextArcStartTurn: 5 }, currentTurn: 5 })).toBe(true);
  });

  test('normalizeArcSeed reject invalid values', () => {
    expect(arcManager.normalizeArcSeed(null)).toBeNull();
    expect(arcManager.normalizeArcSeed({ title: '', kind: 'x', triggerMetric: 'army' })).toBeNull();
    expect(arcManager.normalizeArcSeed({ title: 't', kind: 'war', triggerMetric: 'army' })).toMatchObject({ kind: 'war' });
  });

  test('getDefaultArcSeed use lowest metric', () => {
    const seed = arcManager.getDefaultArcSeed({ army: 100, economy: 50, diplomacy: 60, loyalty: 70 });
    expect(seed.triggerMetric).toBe('economy');
  });

  test('getArcOutcome include trigger metric', () => {
    const outcome = arcManager.getArcOutcome('rebellion', 'resolved', 'loyalty');
    expect(outcome).toContain('loyalty');
  });

  test('advanceArcRow change stages final', () => {
    const arc = arcManager.createActiveArcFromSeed({ title: 't', kind: 'war', triggerMetric: 'army', expectedTurns: 3 }, 1);
    const newArc = arcManager.advanceArcRow(arc, { army: -50, economy: -50, diplomacy: -50, loyalty: -50 }, { army: 200 }, 1);
    expect(newArc.status).not.toBe('active');
  });
});




describe('arc-manager full functionality coverage', () => {
  test('kindByMetric all metrics valid kind return testing', () => {
    expect(arcManager.getKindByMetric('loyalty')).toBe('rebellion');
    expect(arcManager.getKindByMetric('diplomacy')).toBe('war');
    expect(arcManager.getKindByMetric('economy')).toBe('famine');
    expect(arcManager.getKindByMetric('army')).toBe('war');
    expect(arcManager.getKindByMetric('unknown')).toBe('intrigue');
  });

  test('advanceArcRow all branch testing', () => {
    expect(arcManager.advanceArcRow(null, {}, {}, 1)).toBe(null);
    expect(arcManager.advanceArcRow({ status: 'resolved' }, {}, {}, 1)).toEqual({ status: 'resolved' });

    let arc = arcManager.createActiveArcFromSeed({ title: 't', kind: 'war', triggerMetric: 'army', expectedTurns: 3 }, 1);
    arc.tension = 96; arc.stage = 2;
    arc = arcManager.advanceArcRow({ ...arc }, { army: -20, economy: -20, diplomacy: -20, loyalty: -20 }, {}, 2);
    expect(arc.status).toBe('failed');
    expect(arc.phase).toBe('end');
    expect(arc.ended_turn).toBe(2);
    expect(arc.outcome_text).toContain('drained');

    arc = arcManager.createActiveArcFromSeed({ title: 't', kind: 'war', triggerMetric: 'army', expectedTurns: 1 }, 1);
    arc.tension = 50; arc.stage = 1; arc.expires_turn = 2;
    arc = arcManager.advanceArcRow({ ...arc }, {}, { army: 150 }, 2);
    expect(arc.status).toBe('resolved');
    expect(arc.phase).toBe('end');
    expect(arc.ended_turn).toBe(2);
    expect(arc.outcome_text).toContain('secured');

    arc = arcManager.createActiveArcFromSeed({ title: 't', kind: 'war', triggerMetric: 'army', expectedTurns: 1 }, 1);
    arc.tension = 50; arc.stage = 1; arc.expires_turn = 2;
    arc = arcManager.advanceArcRow({ ...arc }, {}, { army: 100 }, 2);
    expect(arc.status).toBe('failed');
    expect(arc.phase).toBe('end');
    expect(arc.ended_turn).toBe(2);
    expect(arc.outcome_text).toContain('drained');

    arc = arcManager.createActiveArcFromSeed({ title: 't', kind: 'war', triggerMetric: 'army', expectedTurns: 3 }, 1);
    arc.tension = 15; arc.stage = 3;
    arc = arcManager.advanceArcRow({ ...arc }, {}, {}, 2);
    expect(arc.status).toBe('resolved');
    expect(arc.phase).toBe('end');
    expect(arc.ended_turn).toBe(2);
    expect(arc.outcome_text).toContain('secured');
  });
});
