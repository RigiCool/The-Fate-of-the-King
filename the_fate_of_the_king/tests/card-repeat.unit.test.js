const {
  isNearDuplicateCard,
  buildRepeatAvoidanceBlock,
  buildFallbackCard
} = require("../helpers/card-repeat");

describe("card repeat helper", () => {
  test("detects duplicate title and description", () => {
    const recentCards = [
      {
        title: "The Silver Tax",
        description: "The royal coffers lie nearly empty, and the crown weighs a dangerous silver tax on merchants and nobles."
      }
    ];

    const duplicate = {
      title: "The Silver Tax",
      description: "The royal coffers lie nearly empty, and the crown weighs a dangerous silver tax on merchants and nobles."
    };

    expect(isNearDuplicateCard(duplicate, recentCards).duplicate).toBe(true);
  });

  test("generate hard anti-repeat prompt block from recent cards", () => {
    const block = buildRepeatAvoidanceBlock([
      { title: "The Silver Tax", description: "A grim levy on silver is proposed." }
    ]);

    expect(block).toContain("ANTI-REPEAT HARD CONSTRAINTS:");
    expect(block).toContain("The Silver Tax");
  });

  test("generate fallback card with constant title but description variation based on prompt context", () => {
    const card = buildFallbackCard("A rebellion threatens the border fort.", { attempt: 2 });

    expect(card.title).toBe("Fallback Card");
    expect(card.description).toContain("Recovery attempt 2");
    expect(card.description).toContain("rebellion threatens the border fort");
  });
});