const {
  buildPlannerPacket,
  clamp,
  weightedRandom,
  normalizeTags,
  getTheme,
  getIntentFromTheme,
  mergeRetrieved,
  selectAnchors,
  buildRetrievalQuery,
  checkGameOver,
  buildDynastyMemoryBlock,
  insertDecisionFactAlways,
  insertImpactFacts,
  requireKingAccess,
  retrieveKnowledgeFTS,
  upsertKnowledgeFTS,
  insertKnowledge,
  maybeInsertFact,
  pruneFacts
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

describe("Utility Functions - clamp", () => {
  it("return value within range", () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });

  it("clamp to minimum", () => {
    expect(clamp(-5, 0, 10)).toBe(0);
  });

  it("clamp to maximum", () => {
    expect(clamp(15, 0, 10)).toBe(10);
  });

  it("handle equal min and max", () => {
    expect(clamp(5, 5, 5)).toBe(5);
  });

  it("handle decimals", () => {
    expect(clamp(5.5, 0, 10)).toBe(5.5);
  });
});

describe("Utility Functions - weightedRandom", () => {
  it("select an item from the array", () => {
    const items = [["a", 1], ["b", 1], ["c", 1]];
    const result = weightedRandom(items);
    expect(["a", "b", "c"]).toContain(result);
  });

  it("return first item when all weights are zero", () => {
    const items = [["a", 0], ["b", 0], ["c", 0]];
    const result = weightedRandom(items);
    expect(result).toBe("a");
  });

  it("return first item when all weights are negative", () => {
    const items = [["a", -5], ["b", -10]];
    const result = weightedRandom(items);
    expect(result).toBe("a");
  });

  it("handle empty array", () => {
    const items = [];
    const result = weightedRandom(items);
    expect(result).toBe("court");
  });

  it("weights higher items more likely", () => {
    const items = [["a", 100], ["b", 0.01]];
    const counts = { a: 0, b: 0 };
    for (let i = 0; i < 100; i++) {
      const result = weightedRandom(items);
      counts[result]++;
    }
    expect(counts.a).toBeGreaterThan(counts.b);
  });

  it("handle item with undefined weight", () => {
    const items = [["a", undefined], ["b", 1]];
    const result = weightedRandom(items);
    expect(["a", "b"]).toContain(result);
  });

  it("handle decimal weights", () => {
    const items = [["a", 0.5], ["b", 0.3]];
    const result = weightedRandom(items);
    expect(["a", "b"]).toContain(result);
  });
});

describe("Utility Functions - normalizeTags", () => {
  it("normalize array of tags", () => {
    const tags = ["Event", "IMPORTANT", "Test"];
    const result = normalizeTags(tags);
    expect(result).toContain("event");
    expect(result).toContain("important");
    expect(result).toContain("test");
  });

  it("remove special characters", () => {
    const tags = ["my-tag", "my.tag", "my tag"];
    const result = normalizeTags(tags);
    expect(result.length).toBeGreaterThan(0);
  });

  it("remove duplicates", () => {
    const tags = ["event", "EVENT", "Event"];
    const result = normalizeTags(tags);
    expect(result.filter(t => t === "event").length).toBe(1);
  });

  it("ignores tags shorter than 2 chars", () => {
    const tags = ["a", "bb", "c"];
    const result = normalizeTags(tags);
    expect(result).not.toContain("a");
    expect(result).not.toContain("c");
    expect(result).toContain("bb");
  });

  it("limits to 12 tags", () => {
    const tags = Array.from({ length: 20 }, (_, i) => `tag${i}`);
    const result = normalizeTags(tags);
    expect(result.length).toBeLessThanOrEqual(12);
  });

  it("handle non-array input", () => {
    const result = normalizeTags("single tag");
    expect(Array.isArray(result)).toBe(true);
  });

  it("handle null/undefined", () => {
    expect(normalizeTags(null)).toEqual([]);
    expect(normalizeTags(undefined)).toEqual([]);
  });

  it("remove empty strings", () => {
    const tags = ["event", "", "important"];
    const result = normalizeTags(tags);
    expect(result.length).toBe(2);
  });

  it("handle tags with numbers", () => {
    const tags = ["event123"];
    const result = normalizeTags(tags);
    expect(result).toContain("event123");
  });
});

describe("Game Logic - getTheme", () => {
  it("return arc_progress when arc is active", () => {
    const metrics = { army: 150, economy: 150, loyalty: 150, diplomacy: 150 };
    const memory = {};
    const activeArc = { status: "active", kind: "rebellion" };
    const result = getTheme(metrics, memory, activeArc);
    expect(result).toBeDefined();
  });

  it("prioritize low metrics", () => {
    const metrics = { army: 50, economy: 150, loyalty: 150, diplomacy: 150 };
    const memory = {};
    const results = [];
    for (let i = 0; i < 50; i++) {
      results.push(getTheme(metrics, memory, null));
    }
    expect(results.includes("military")).toBe(true);
  });

  it("avoid recent theme", () => {
    const metrics = { army: 150, economy: 150, loyalty: 150, diplomacy: 150 };
    const memory = { recentThemes: ["court"] };
    const results = [];
    for (let i = 0; i < 50; i++) {
      results.push(getTheme(metrics, memory, null));
    }
    const courtCount = results.filter(t => t === "court").length;
    expect(courtCount).toBeLessThan(25);
  });

  it("handle missing activeArc", () => {
    const metrics = { army: 100, economy: 100, loyalty: 100, diplomacy: 100 };
    const memory = {};
    const result = getTheme(metrics, memory, null);
    expect(result).toBeDefined();
  });
});

describe("Game Logic - getIntentFromTheme", () => {
  it("return advance_arc_[kind] for arc_progress with active arc", () => {
    const metrics = { army: 100, economy: 100, loyalty: 100, diplomacy: 100 };
    const activeArc = { status: "active", kind: "rebellion" };
    const result = getIntentFromTheme("arc_progress", metrics, activeArc);
    expect(result).toBe("advance_arc_rebellion");
  });

  it("return advance_story_arc for arc_progress without kind", () => {
    const metrics = { army: 100, economy: 100, loyalty: 100, diplomacy: 100 };
    const result = getIntentFromTheme("arc_progress", metrics, {});
    expect(result).toBe("advance_story_arc");
  });

  it("return stabilize_army when army is low", () => {
    const metrics = { army: 100, economy: 150, loyalty: 150, diplomacy: 150 };
    expect(getIntentFromTheme("military", metrics, null)).toBe("stabilize_army");
  });

  it("return expand_military_power when army is high", () => {
    const metrics = { army: 150, economy: 150, loyalty: 150, diplomacy: 150 };
    expect(getIntentFromTheme("military", metrics, null)).toBe("expand_military_power");
  });

  it("handle all themes", () => {
    const metrics = { army: 50, economy: 50, loyalty: 50, diplomacy: 50 };
    const themes = ["military", "economy", "loyalty", "diplomacy", "intrigue", "external", "church", "peasantry", "court"];
    for (const theme of themes) {
      const result = getIntentFromTheme(theme, metrics, null);
      expect(typeof result).toBe("string");
    }
  });

  it("return correct intent for each low metric", () => {
    const baseMetrics = { army: 150, economy: 150, loyalty: 150, diplomacy: 150 };
    expect(getIntentFromTheme("economy", { ...baseMetrics, economy: 50 }, null)).toBe("raise_funds");
    expect(getIntentFromTheme("loyalty", { ...baseMetrics, loyalty: 50 }, null)).toBe("prevent_unrest");
    expect(getIntentFromTheme("diplomacy", { ...baseMetrics, diplomacy: 50 }, null)).toBe("avoid_war");
  });

  it("return correct intent for growth metrics", () => {
    const metrics = { army: 150, economy: 150, loyalty: 150, diplomacy: 150 };
    expect(getIntentFromTheme("economy", metrics, null)).toBe("invest_growth");
    expect(getIntentFromTheme("loyalty", metrics, null)).toBe("consolidate_rule");
    expect(getIntentFromTheme("diplomacy", metrics, null)).toBe("secure_alliance");
  });

  it("return correct intent for other themes", () => {
    expect(getIntentFromTheme("intrigue", {}, null)).toBe("uncover_plot");
    expect(getIntentFromTheme("external", {}, null)).toBe("manage_neighbors");
    expect(getIntentFromTheme("church", {}, null)).toBe("balance_faith_power");
    expect(getIntentFromTheme("peasantry", {}, null)).toBe("manage_hardship");
    expect(getIntentFromTheme("court", {}, null)).toBe("manage_court");
  });
});

describe("Knowledge Functions - mergeRetrieved", () => {
  it("merges core and situational knowledge", () => {
    const core = [
      { rowid: 1, text: "Knowledge 1", score: 0.5 },
      { rowid: 2, text: "Knowledge 2", score: 0.6 }
    ];
    const situational = [
      { rowid: 3, text: "Knowledge 3", score: 0.7 }
    ];
    const result = mergeRetrieved(core, situational);
    expect(result.length).toBe(3);
  });

  it("remove duplicates by rowid and text", () => {
    const core = [
      { rowid: 1, text: "Knowledge 1", score: 0.5 }
    ];
    const situational = [
      { rowid: 1, text: "Knowledge 1", score: 0.7 }
    ];
    const result = mergeRetrieved(core, situational);
    expect(result.length).toBe(1);
  });

  it("respects limit parameter", () => {
    const core = Array.from({ length: 10 }, (_, i) => ({
      rowid: i,
      text: `Knowledge ${i}`,
      score: 0.5
    }));
    const result = mergeRetrieved(core, [], 5);
    expect(result.length).toBe(5);
  });

  it("handle null inputs", () => {
    const result = mergeRetrieved(null, null);
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(0);
  });

  it("handle empty arrays", () => {
    const result = mergeRetrieved([], []);
    expect(result.length).toBe(0);
  });

  it("handle only core without situational", () => {
    const core = [{ rowid: 1, text: "K1", score: 0.5 }];
    const result = mergeRetrieved(core, null);
    expect(result.length).toBe(1);
  });

  it("handle only situational without core", () => {
    const situational = [{ rowid: 3, text: "K3", score: 0.7 }];
    const result = mergeRetrieved(null, situational);
    expect(result.length).toBe(1);
  });
});

describe("Knowledge Functions - selectAnchors", () => {
  it("select up to 4 anchors for normal game", () => {
    const retrieved = Array.from({ length: 10 }, (_, i) => ({
      rowid: i,
      text: `Knowledge ${i}`,
      score: 0.5 + i * 0.01,
      turn: 10 + i
    }));
    const result = selectAnchors(retrieved, { isFinale: false });
    expect(result.length).toBeLessThanOrEqual(4);
  });

  it("select up to 6 anchors for finale", () => {
    const retrieved = Array.from({ length: 10 }, (_, i) => ({
      rowid: i,
      text: `Knowledge ${i}`,
      score: 0.5 + i * 0.01,
      turn: 10 + i
    }));
    const result = selectAnchors(retrieved, { isFinale: true });
    expect(result.length).toBeLessThanOrEqual(6);
  });

  it("prioritize fresh knowledge", () => {
    const retrieved = [
      { rowid: 1, text: "Old", score: 0.1, turn: 1 },
      { rowid: 2, text: "New", score: 0.2, turn: 100 }
    ];
    const result = selectAnchors(retrieved, { isFinale: false });
    expect(result.length).toBeGreaterThan(0);
  });

  it("handle empty array", () => {
    const result = selectAnchors([]);
    expect(result).toEqual([]);
  });

  it("handle non-array input", () => {
    const result = selectAnchors(null);
    expect(Array.isArray(result)).toBe(true);
  });

  it("remove duplicates", () => {
    const retrieved = [
      { rowid: 1, text: "Knowledge 1", score: 0.5, turn: 10 },
      { rowid: 1, text: "Knowledge 1", score: 0.6, turn: 11 }
    ];
    const result = selectAnchors(retrieved);
    expect(result.length).toBeLessThanOrEqual(1);
  });
});

describe("Knowledge Functions - buildRetrievalQuery", () => {
  it("include intent and theme from planner", () => {
    const params = {
      kingName: "Arthur",
      metrics: { army: 100, economy: 100, diplomacy: 100, loyalty: 100 },
      planner: { intent: "expand_military", theme: "military" },
      worldRow: { memory: {} },
      activeArc: null
    };
    const result = buildRetrievalQuery(params);
    expect(result).toContain("expand_military");
    expect(result).toContain("military");
  });

  it("include active arc details", () => {
    const params = {
      kingName: "Arthur",
      metrics: { army: 100, economy: 100, diplomacy: 100, loyalty: 100 },
      planner: { intent: "advance_arc", theme: "arc_progress" },
      worldRow: { memory: {} },
      activeArc: { status: "active", kind: "rebellion", title: "Great Rebellion", stakes: "high" }
    };
    const result = buildRetrievalQuery(params);
    expect(result).toContain("rebellion");
  });

  it("add relevant keywords for low metrics", () => {
    const params = {
      kingName: "Arthur",
      metrics: { army: 50, economy: 50, diplomacy: 50, loyalty: 50 },
      planner: {},
      worldRow: { memory: {} },
      activeArc: null
    };
    const result = buildRetrievalQuery(params);
    expect(result).toMatch(/tax|grain|debt|garrison|envoy/i);
  });

  it("handle missing world memory", () => {
    const params = {
      kingName: "Arthur",
      metrics: { army: 100, economy: 100, diplomacy: 100, loyalty: 100 },
      planner: {},
      worldRow: {},
      activeArc: null
    };
    const result = buildRetrievalQuery(params);
    expect(typeof result).toBe("string");
  });

  it("return query with tags part", () => {
    const params = {
      kingName: "Arthur",
      metrics: { army: 100, economy: 100, diplomacy: 100, loyalty: 100 },
      planner: {},
      worldRow: { memory: {} },
      activeArc: null
    };
    const result = buildRetrievalQuery(params);
    expect(result).toContain("tags:");
  });

  it("include lastEventSummary from memory", () => {
    const params = {
      kingName: "Arthur",
      metrics: { army: 100, economy: 100, diplomacy: 100, loyalty: 100 },
      planner: {},
      worldRow: { memory: { lastEventSummary: "A great battle occurred" } },
      activeArc: null
    };
    const result = buildRetrievalQuery(params);
    expect(result).toContain("battle");
  });

  it("filter short words", () => {
    const params = {
      kingName: "a",
      metrics: { army: 100, economy: 100, diplomacy: 100, loyalty: 100 },
      planner: { intent: "a", theme: "bb" },
      worldRow: { memory: {} },
      activeArc: null
    };
    const result = buildRetrievalQuery(params);
    expect(result).toBeDefined();
  });
});

describe("Decision and Impact Functions", () => {
  it("insertDecisionFactAlways handle valid choice 0", () => {
    const params = {
      kingId: 1,
      turn: 5,
      theme: "military",
      card: { title: "Battle", choices: [{ text: "Attack" }, { text: "Retreat" }] },
      choiceIndex: 0
    };
    expect(() => insertDecisionFactAlways(params)).not.toThrow();
  });

  it("insertDecisionFactAlways handle valid choice 1", () => {
    const params = {
      kingId: 1,
      turn: 5,
      theme: "diplomacy",
      card: { title: "Treaty", choices: [{ text: "Sign" }, { text: "Reject" }] },
      choiceIndex: 1
    };
    expect(() => insertDecisionFactAlways(params)).not.toThrow();
  });

  it("insertDecisionFactAlways skip invalid choiceIndex", () => {
    const params = {
      kingId: 1,
      turn: 5,
      theme: "military",
      card: { title: "Battle", choices: [{ text: "Attack" }, { text: "Retreat" }] },
      choiceIndex: 2
    };
    expect(() => insertDecisionFactAlways(params)).not.toThrow();
  });

  it("insertDecisionFactAlways skip null card", () => {
    const params = {
      kingId: 1,
      turn: 5,
      theme: "military",
      card: null,
      choiceIndex: 0
    };
    expect(() => insertDecisionFactAlways(params)).not.toThrow();
  });

  it("insertDecisionFactAlways handle non-integer choiceIndex", () => {
    const params = {
      kingId: 1,
      turn: 5,
      theme: "military",
      card: { title: "Battle", choices: [{ text: "Attack" }, { text: "Retreat" }] },
      choiceIndex: "0"
    };
    expect(() => insertDecisionFactAlways(params)).not.toThrow();
  });

  it("insertImpactFacts handle significant positive impacts", () => {
    const params = {
      kingId: 1,
      turn: 5,
      theme: "military",
      effects: { army: 15, economy: 0, diplomacy: 0, loyalty: 0 }
    };
    expect(() => insertImpactFacts(params)).not.toThrow();
  });

  it("insertImpactFacts handle significant negative impacts", () => {
    const params = {
      kingId: 1,
      turn: 5,
      theme: "military",
      effects: { army: -15, economy: 0, diplomacy: 0, loyalty: 0 }
    };
    expect(() => insertImpactFacts(params)).not.toThrow();
  });

  it("insertImpactFacts handle exactly 10 impact", () => {
    const params = {
      kingId: 1,
      turn: 5,
      theme: "military",
      effects: { army: 10, economy: 0, diplomacy: 0, loyalty: 0 }
    };
    expect(() => insertImpactFacts(params)).not.toThrow();
  });

  it("insertImpactFacts skip minor impacts", () => {
    const params = {
      kingId: 1,
      turn: 5,
      theme: "military",
      effects: { army: 5, economy: 5, diplomacy: 5, loyalty: 5 }
    };
    expect(() => insertImpactFacts(params)).not.toThrow();
  });

  it("insertImpactFacts handle null effects", () => {
    const params = {
      kingId: 1,
      turn: 5,
      theme: "military",
      effects: null
    };
    expect(() => insertImpactFacts(params)).not.toThrow();
  });
});

describe("Game Logic - checkGameOver", () => {
  it("return null when all metrics are above 0", () => {
    const metrics = { army: 50, economy: 50, diplomacy: 50, loyalty: 50 };
    expect(checkGameOver(metrics)).toBeNull();
  });

  it("return game over when army is 0", () => {
    const metrics = { army: 0, economy: 50, diplomacy: 50, loyalty: 50 };
    const result = checkGameOver(metrics);
    expect(result.type).toBe("army");
    expect(result.text).toContain("army");
  });

  it("return game over when economy is 0", () => {
    const metrics = { army: 50, economy: 0, diplomacy: 50, loyalty: 50 };
    const result = checkGameOver(metrics);
    expect(result.type).toBe("economy");
  });

  it("return game over when diplomacy is 0", () => {
    const metrics = { army: 50, economy: 50, diplomacy: 0, loyalty: 50 };
    const result = checkGameOver(metrics);
    expect(result.type).toBe("diplomacy");
  });

  it("return game over when loyalty is 0", () => {
    const metrics = { army: 50, economy: 50, diplomacy: 50, loyalty: 0 };
    const result = checkGameOver(metrics);
    expect(result.type).toBe("loyalty");
  });

  it("return game over when metrics are negative", () => {
    const metrics = { army: -10, economy: 50, diplomacy: 50, loyalty: 50 };
    expect(checkGameOver(metrics)).not.toBeNull();
  });
});

describe("Game Logic - buildDynastyMemoryBlock", () => {
  it("return message for empty kings list", () => {
    const result = buildDynastyMemoryBlock([]);
    expect(result).toBe("No previous kings.");
  });

  it("format single king", () => {
    const kings = [{ name: "Arthur", turn: 50, description: "The legendary king" }];
    const result = buildDynastyMemoryBlock(kings);
    expect(result).toContain("Arthur");
    expect(result).toContain("50");
    expect(result).toContain("legendary");
  });

  it("format multiple kings with numbering", () => {
    const kings = [
      { name: "Arthur", turn: 50, description: "Legendary" },
      { name: "Merlin", turn: 30, description: "Wise" }
    ];
    const result = buildDynastyMemoryBlock(kings);
    expect(result).toContain("1.");
    expect(result).toContain("2.");
    expect(result).toContain("Arthur");
    expect(result).toContain("Merlin");
  });
});

describe("Middleware - requireKingAccess", () => {
  let mockReq, mockRes, mockNext;
  const { getKingRow } = require("../db");

  beforeEach(() => {
    jest.clearAllMocks();
    mockReq = {
      params: {},
      body: {},
      user: {}
    };
    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis()
    };
    mockNext = jest.fn();
  });

  it("return 400 for invalid kingId", () => {
    mockReq.params.kingId = "invalid";
    requireKingAccess(mockReq, mockRes, mockNext);
    expect(mockRes.status).toHaveBeenCalledWith(400);
  });

  it("return 404 when king not found", () => {
    mockReq.params.kingId = "999";
    getKingRow.mockReturnValue(null);
    requireKingAccess(mockReq, mockRes, mockNext);
    expect(mockRes.status).toHaveBeenCalledWith(404);
  });

  it("allow admin access", () => {
    mockReq.params.kingId = "1";
    mockReq.user = { role: "admin", id: 999 };
    getKingRow.mockReturnValue({ id: 1, user_id: 2 });
    requireKingAccess(mockReq, mockRes, mockNext);
    expect(mockNext).toHaveBeenCalled();
  });

  it("allow owner access", () => {
    mockReq.params.kingId = "1";
    mockReq.user = { role: "user", id: 2 };
    getKingRow.mockReturnValue({ id: 1, user_id: 2 });
    requireKingAccess(mockReq, mockRes, mockNext);
    expect(mockNext).toHaveBeenCalled();
  });

  it("deny non-owner access", () => {
    mockReq.params.kingId = "1";
    mockReq.user = { role: "user", id: 999 };
    getKingRow.mockReturnValue({ id: 1, user_id: 2 });
    requireKingAccess(mockReq, mockRes, mockNext);
    expect(mockRes.status).toHaveBeenCalledWith(403);
  });

  it("get kingId from body if not in params", () => {
    mockReq.body.kingId = "1";
    mockReq.user = { role: "admin" };
    getKingRow.mockReturnValue({ id: 1, user_id: 2 });
    requireKingAccess(mockReq, mockRes, mockNext);
    expect(mockNext).toHaveBeenCalled();
  });

  it("set king on request", () => {
    mockReq.params.kingId = "1";
    mockReq.user = { role: "admin" };
    const king = { id: 1, user_id: 2, name: "Arthur" };
    getKingRow.mockReturnValue(king);
    requireKingAccess(mockReq, mockRes, mockNext);
    expect(mockReq.king).toEqual(king);
  });
});

describe("Database Functions - retrieveKnowledgeFTS", () => {
  const { db } = require("../db");

  it("return empty array for empty query", () => {
    const result = retrieveKnowledgeFTS(db, { kingId: 1, query: "", topK: 10 });
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(0);
  });

  it("return empty array for null query", () => {
    const result = retrieveKnowledgeFTS(db, { kingId: 1, query: null, topK: 10 });
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(0);
  });

  it("return empty array for whitespace query", () => {
    const result = retrieveKnowledgeFTS(db, { kingId: 1, query: "   ", topK: 10 });
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(0);
  });

  it("handle database error with fallback", () => {
    const mockDb = {
      prepare: jest.fn(() => {
        throw new Error("FTS error");
      })
    };
    const result = retrieveKnowledgeFTS(mockDb, { kingId: 1, query: "rebellion OR fight", topK: 10 });
    expect(Array.isArray(result)).toBe(true);
  });

  it("return empty on double error", () => {
    const mockDb = {
      prepare: jest.fn(() => ({
        all: jest.fn(() => {
          throw new Error("Database error");
        })
      }))
    };
    const result = retrieveKnowledgeFTS(mockDb, { kingId: 1, query: "test", topK: 10 });
    expect(result).toEqual([]);
  });

  it("processes results correctly", () => {
    const mockDb = {
      prepare: jest.fn(() => ({
        all: jest.fn(() => [
          { rowid: 1, text: "Test knowledge", tags: "event fact", turn: 5, score: 0.8 }
        ])
      }))
    };
    const result = retrieveKnowledgeFTS(mockDb, { kingId: 1, query: "test", topK: 10 });
    expect(result.length).toBe(1);
    expect(result[0].rowid).toBe(1);
    expect(result[0].tags).toEqual(["event", "fact"]);
  });
});

describe("buildPlannerPacket integration", () => {
  it("return correct packet with activeArc", () => {
    const metrics = { army: 100, economy: 100, loyalty: 100, diplomacy: 100 };
    const worldRow = { memory: { recentThemes: [] } };
    const activeArc = { status: "active", kind: "rebellion", phase: "mid", stage: 2, tension: 5, expires_turn: 10 };
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

  it("return correct packet with no activeArc", () => {
    const metrics = { army: 150, economy: 150, loyalty: 150, diplomacy: 150 };
    const worldRow = { memory: { recentThemes: [] } };
    const packet = buildPlannerPacket(metrics, worldRow, null);
    expect(packet.theme).toBeDefined();
    expect(packet.intent).toBeDefined();
    expect(packet.arcDirective).toBeNull();
  });

  it("handle missing memory gracefully", () => {
    const metrics = { army: 150, economy: 150, loyalty: 150, diplomacy: 150 };
    const worldRow = {};
    const packet = buildPlannerPacket(metrics, worldRow, null);
    expect(packet.theme).toBeDefined();
    expect(packet.intent).toBeDefined();
  });

  it("create valid intent for all metric levels", () => {
    const testCases = [
      { army: 50, economy: 50, loyalty: 50, diplomacy: 50 },
      { army: 100, economy: 100, loyalty: 100, diplomacy: 100 },
      { army: 150, economy: 150, loyalty: 150, diplomacy: 150 }
    ];
    for (const metrics of testCases) {
      const packet = buildPlannerPacket(metrics, { memory: {} }, null);
      expect(packet.intent).toBeDefined();
      expect(typeof packet.intent).toBe("string");
    }
  });
});
