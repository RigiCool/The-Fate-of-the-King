planner/index.js

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function weightedRandom(items) {
  const sum = items.reduce((acc, [, w]) => acc + Math.max(0, w), 0);
  if (sum <= 0) return items[0]?.[0] ?? "court";
  let r = Math.random() * sum;
  for (const [v, w] of items) {
    r -= Math.max(0, w);
    if (r <= 0) return v;
  }
  return items[items.length - 1]?.[0] ?? "court";
}

function pickTheme(metrics, worldMemory, activeArc) {
  const w = [];

  if (activeArc && activeArc.status === "active") {
    w.push(["arc_progress", 7]);
  }

  if (metrics.army < 120) w.push(["military", 5]);
  if (metrics.economy < 120) w.push(["economy", 5]);
  if (metrics.loyalty < 120) w.push(["loyalty", 5]);
  if (metrics.diplomacy < 120) w.push(["diplomacy", 5]);

  w.push(["court", 2], ["intrigue", 2], ["external", 2], ["church", 1], ["peasantry", 1]);

  const last = worldMemory?.recentThemes?.[0];
  if (last) {
    for (let i = 0; i < w.length; i++) {
      if (w[i][0] === last) w[i][1] = clamp(w[i][1] - 1, 0, 999);
    }
  }

  return weightedRandom(w);
}

function intentFromTheme(theme, metrics, activeArc) {
  switch (theme) {
    case "arc_progress":
      return activeArc?.kind ? `advance_arc_${activeArc.kind}` : "advance_story_arc";
    case "military":
      return metrics.army < 120 ? "stabilize_army" : "expand_military_power";
    case "economy":
      return metrics.economy < 120 ? "raise_funds" : "invest_growth";
    case "loyalty":
      return metrics.loyalty < 120 ? "prevent_unrest" : "consolidate_rule";
    case "diplomacy":
      return metrics.diplomacy < 120 ? "avoid_war" : "secure_alliance";
    case "intrigue":
      return "uncover_plot";
    case "external":
      return "manage_neighbors";
    case "church":
      return "balance_faith_power";
    case "peasantry":
      return "manage_hardship";
    case "court":
    default:
      return "manage_court";
  }
}

function buildPlannerPacket(metrics, worldRow, activeArcRow, factsRows) {
  const memory = worldRow?.memory || {};
  const theme = pickTheme(metrics, memory, activeArcRow);

  const mustUseFacts = (factsRows || [])
    .slice(-6)
    .map(f => f.text)
    .filter(Boolean);

  const arcHint = activeArcRow
    ? {
        title: activeArcRow.title,
        kind: activeArcRow.kind,
        phase: activeArcRow.phase,
        stage: activeArcRow.stage,
        tension: activeArcRow.tension,
        expiresTurn: activeArcRow.expires_turn
      }
    : null;

  return {
    theme,
    intent: intentFromTheme(theme, metrics, activeArcRow),
    difficulty: 1,
    arcHint,
    mustUseFacts
  };
}

module.exports = { buildPlannerPacket };