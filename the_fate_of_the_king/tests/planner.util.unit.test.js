const { getTheme, getIntentFromTheme, weightedRandom } = require("../planner/planner.js");

describe("Planner utility functions", () => {
  describe("getTheme", () => {
    it("return arc_progress if activeArc is active", () => {
      const metrics = { army: 150, economy: 150, loyalty: 150, diplomacy: 150 };
      const memory = { recentThemes: [] };
      const activeArc = { status: "active" };
      jest.spyOn(Math, "random").mockReturnValue(0.01);
      expect(getTheme(metrics, memory, activeArc)).toBe("arc_progress");
      Math.random.mockRestore();
    });
    it("return a weighted theme based on low metrics", () => {
      const metrics = { army: 100, economy: 100, loyalty: 100, diplomacy: 100 };
      const memory = { recentThemes: [] };
      const activeArc = null;
      jest.spyOn(Math, "random").mockReturnValue(0.01);
      const theme = getTheme(metrics, memory, activeArc);
      expect(["military", "economy", "loyalty", "diplomacy"]).toContain(theme);
      Math.random.mockRestore();
    });
    it("penalize last theme", () => {
      const metrics = { army: 150, economy: 150, loyalty: 150, diplomacy: 150 };
      const memory = { recentThemes: ["court"] };
      const activeArc = null;
      jest.spyOn(Math, "random").mockReturnValue(0.99);
      expect(getTheme(metrics, memory, activeArc)).not.toBe("court");
      Math.random.mockRestore();
    });
  });

  describe("getIntentFromTheme", () => {
    it("return correct intent for each theme", () => {
      const metrics = { army: 100, economy: 100, loyalty: 100, diplomacy: 100 };
      const arc = { kind: "rebellion" };
      expect(getIntentFromTheme("arc_progress", metrics, arc)).toBe("advance_arc_rebellion");
      expect(getIntentFromTheme("military", metrics, null)).toBe("stabilize_army");
      expect(getIntentFromTheme("economy", { ...metrics, economy: 150 }, null)).toBe("invest_growth");
      expect(getIntentFromTheme("loyalty", { ...metrics, loyalty: 150 }, null)).toBe("consolidate_rule");
      expect(getIntentFromTheme("diplomacy", { ...metrics, diplomacy: 150 }, null)).toBe("secure_alliance");
      expect(getIntentFromTheme("intrigue", metrics, null)).toBe("uncover_plot");
      expect(getIntentFromTheme("external", metrics, null)).toBe("manage_neighbors");
      expect(getIntentFromTheme("church", metrics, null)).toBe("balance_faith_power");
      expect(getIntentFromTheme("peasantry", metrics, null)).toBe("manage_hardship");
      expect(getIntentFromTheme("court", metrics, null)).toBe("manage_court");
    });
  });

  describe("weightedRandom", () => {
    it("return first item if all weights are zero", () => {
      expect(weightedRandom([["a", 0], ["b", 0]])).toBe("a");
    });
    it("return last item if random is high", () => {
      jest.spyOn(Math, "random").mockReturnValue(0.99);
      expect(weightedRandom([["a", 1], ["b", 1]])).toBe("b");
      Math.random.mockRestore();
    });
    it("handle negative weights gracefully", () => {
      expect(weightedRandom([["a", -5], ["b", 0]])).toBe("a");
    });
  });
});
