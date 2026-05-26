const { normalizeTags } = require("../planner/planner.js");

describe("normalize tags", () => {
  it("empty array return for non-array input", () => {
    expect(normalizeTags(null)).toEqual([]);
    expect(normalizeTags(undefined)).toEqual([]);
    expect(normalizeTags(123)).toEqual([]);
  });
  
  it("duplicates deletion, trim, and normalize", () => {
    expect(normalizeTags(["Tag!", "tag", "  tag  ", "t@#2", "t@#2"]))
      .toEqual(["tag", "t_2"]);
  });
  
  it("short/empty tags filter", () => {
    expect(normalizeTags(["a", "b", "ok", "good_tag"]))
      .toEqual(["ok", "good_tag"]);
  });
  
  it("limit tags amount to 12 tags", () => {
    const tags = Array.from({length: 20}, (_, i) => `tag${i}`);
    expect(normalizeTags(tags).length).toBe(12);
  
  });

});
