const { clamp, extractFirstJsonObject, parseStrictJson } = require("../validator/validator.js");

describe("validator utilities", () => {
  describe("clamp", () => {
    it("clamp within range", () => {
      expect(clamp(5, 1, 10)).toBe(5);
      expect(clamp(-5, 1, 10)).toBe(1);
      expect(clamp(15, 1, 10)).toBe(10);
    });
  });

  describe("extractFirstJsonObject", () => {
    it("extract first JSON object from string", () => {
      expect(extractFirstJsonObject("foo {\"a\":1} bar {\"b\":2}")).toBe("{\"a\":1}");
    });
    it("return null if object not found", () => {
      expect(extractFirstJsonObject("no braces here")).toBeNull();
    });
  });

  describe("parseStrictJson", () => {
    it("parse valid JSON", () => {
      expect(parseStrictJson('{"a":1}')).toEqual({a:1});
    });
    it("return null for invalid JSON", () => {
      expect(parseStrictJson('not json')).toBeNull();
    });
    it("extract and parse first object", () => {
      expect(parseStrictJson('foo {"a":2} bar')).toEqual({a:2});
    });
    it("return object if it is object", () => {
      expect(parseStrictJson({b:3})).toEqual({b:3});
    });
    it("return null for undefined", () => {
      expect(parseStrictJson(null)).toBeNull();
      expect(parseStrictJson(undefined)).toBeNull();
    });
  });
});
