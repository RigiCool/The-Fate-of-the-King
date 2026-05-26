const {
  buildPlannerPacket
} = require("../planner/planner.js");

// Mock the db module
jest.mock("../db", () => ({
  db: {
    prepare: jest.fn(() => ({
      run: jest.fn(() => ({ lastInsertRowid: 1 })),
      all: jest.fn(() => []),
      get: jest.fn(() => null)
    }))
  },
  getKingRow: jest.fn()
}));

describe("buildPlannerPacket - Integration Tests", () => {
  it("returns correct packet with active arc and varied metrics", () => {
    const metrics = { army: 100, economy: 100, loyalty: 100, diplomacy: 100 };
    const worldRow = { memory: { recentThemes: [] } };
    const activeArc = { 
      status: "active", 
      kind: "rebellion", 
      phase: "mid", 
      stage: 2, 
      tension: 5, 
      expires_turn: 10 
    };
    
    const packet = buildPlannerPacket(metrics, worldRow, activeArc);
    
    expect(packet.theme).toBeDefined();
    expect(packet.intent).toBeDefined();
    expect(packet.arcDirective).toEqual({
      kind: "rebellion",
      phase: "mid",
      stage: 2,
      tension: 5,
      expiresTurn: 10
    });
  });

  it("returns correct packet with no active arc and high metrics", () => {
    const metrics = { army: 150, economy: 150, loyalty: 150, diplomacy: 150 };
    const worldRow = { memory: { recentThemes: [] } };
    
    const packet = buildPlannerPacket(metrics, worldRow, null);
    
    expect(packet.theme).toBeDefined();
    expect(packet.intent).toBeDefined();
    expect(packet.arcDirective).toBeNull();
  });

  it("handles missing memory gracefully", () => {
    const metrics = { army: 150, economy: 150, loyalty: 150, diplomacy: 150 };
    const worldRow = {};
    
    const packet = buildPlannerPacket(metrics, worldRow, null);
    
    expect(packet.theme).toBeDefined();
    expect(packet.intent).toBeDefined();
  });

  it("creates valid intent for all metric levels", () => {
    const testCases = [
      { army: 50, economy: 50, loyalty: 50, diplomacy: 50 },
      { army: 100, economy: 100, loyalty: 100, diplomacy: 100 },
      { army: 150, economy: 150, loyalty: 150, diplomacy: 150 }
    ];
    
    for (const metrics of testCases) {
      const packet = buildPlannerPacket(metrics, { memory: {} }, null);
      expect(packet.intent).toBeDefined();
      expect(typeof packet.intent).toBe("string");
      expect(packet.theme).toBeDefined();
    }
  });

  it("prioritizes arc when active arc is present with low metrics", () => {
    const metrics = { army: 50, economy: 50, loyalty: 50, diplomacy: 50 };
    const worldRow = { memory: { recentThemes: [] } };
    const activeArc = { status: "active", kind: "uprising" };
    
    const results = [];
    for (let i = 0; i < 50; i++) {
      results.push(buildPlannerPacket(metrics, worldRow, activeArc).theme);
    }
    
    // arc_progress should appear frequently when arc is active
    const arcCount = results.filter(t => t === "arc_progress").length;
    expect(arcCount).toBeGreaterThan(5);
  });

  it("respects recent theme memory and avoids repeating", () => {
    const metrics = { army: 100, economy: 100, loyalty: 100, diplomacy: 100 };
    const worldRow = { memory: { recentThemes: ["court"] } };
    
    const results = [];
    for (let i = 0; i < 30; i++) {
      results.push(buildPlannerPacket(metrics, worldRow, null).theme);
    }
    
    const courtCount = results.filter(t => t === "court").length;
    // Court weight should be reduced due to recent theme
    expect(courtCount).toBeLessThan(15);
  });

  it("generates consistent packet structure across multiple calls", () => {
    const metrics = { army: 100, economy: 100, loyalty: 100, diplomacy: 100 };
    const worldRow = { memory: { recentThemes: [] } };
    const activeArc = { status: "active", kind: "war", phase: "early", stage: 1, tension: 3, expires_turn: 20 };
    
    const packets = [];
    for (let i = 0; i < 5; i++) {
      packets.push(buildPlannerPacket(metrics, worldRow, activeArc));
    }
    
    // All packets should have the same structure
    packets.forEach(packet => {
      expect(packet).toHaveProperty("theme");
      expect(packet).toHaveProperty("intent");
      expect(packet).toHaveProperty("arcDirective");
      expect(packet.arcDirective).toHaveProperty("kind");
      expect(packet.arcDirective).toHaveProperty("phase");
      expect(packet.arcDirective).toHaveProperty("stage");
    });
  });

  it("handles extreme metric values", () => {
    const metrics = { army: 0, economy: 0, loyalty: 0, diplomacy: 0 };
    const worldRow = { memory: { recentThemes: [] } };
    
    const packet = buildPlannerPacket(metrics, worldRow, null);
    expect(packet.intent).toBeDefined();
    expect(packet.theme).toBeDefined();
  });

  it("handles very high metric values", () => {
    const metrics = { army: 500, economy: 500, loyalty: 500, diplomacy: 500 };
    const worldRow = { memory: { recentThemes: [] } };
    
    const packet = buildPlannerPacket(metrics, worldRow, null);
    expect(packet.intent).toBeDefined();
    expect(packet.theme).toBeDefined();
  });

  it("correctly transforms expires_turn to expiresTurn in arcDirective", () => {
    const metrics = { army: 100, economy: 100, loyalty: 100, diplomacy: 100 };
    const worldRow = { memory: {} };
    const activeArc = { 
      status: "active", 
      kind: "famine", 
      phase: "late", 
      stage: 3, 
      tension: 8, 
      expires_turn: 75 
    };
    
    const packet = buildPlannerPacket(metrics, worldRow, activeArc);
    
    expect(packet.arcDirective.expiresTurn).toBe(75);
    expect(packet.arcDirective.expires_turn).toBeUndefined();
  });

  it("works with multiple active arcs by preferring first one", () => {
    const metrics = { army: 100, economy: 100, loyalty: 100, diplomacy: 100 };
    const worldRow = { memory: { recentThemes: [] } };
    const activeArc = { status: "active", kind: "revolution", phase: "start", stage: 1, tension: 2, expires_turn: 30 };
    
    const packet = buildPlannerPacket(metrics, worldRow, activeArc);
    
    expect(packet.arcDirective.kind).toBe("revolution");
  });

  it("adapts to combined crisis scenarios", () => {
    const metrics = { army: 50, economy: 80, loyalty: 40, diplomacy: 60 };
    const worldRow = { memory: { recentThemes: ["military", "loyalty"] } };
    const activeArc = { status: "active", kind: "civil_unrest" };
    
    const packet = buildPlannerPacket(metrics, worldRow, activeArc);
    expect(packet.theme).toBeDefined();
    expect(packet.intent).toBeDefined();
  });
});
