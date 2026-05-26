// ----------------------------- //
// ---------- Planner ---------- //
// ----------------------------- //



// ----------------------------------------- //
// ---------- Utilities functions ---------- //
// ----------------------------------------- //
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

function normalizeTags(tags) {
  const arr = Array.isArray(tags) ? tags : [];
  const out = [];
  const seen = new Set();
  for (const t of arr) {
    const s = String(t || "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_-]+/gu, " ")
      .trim()
      .replace(/\s+/g, "_");
    if (!s || s.length < 2) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out.slice(0, 12);
}

// --------------------------------------- //
// ---------- Planner functions ---------- //
// --------------------------------------- //

// Get a theme based on current lowest metric, recent themes and active arc weights
function getTheme(metrics, memory, activeArc) {
  const w = [];
  if (activeArc?.status === "active") w.push(["arc_progress", 7]);

  if (metrics.army < 120) w.push(["military", 5]);
  if (metrics.economy < 120) w.push(["economy", 5]);
  if (metrics.loyalty < 120) w.push(["loyalty", 5]);
  if (metrics.diplomacy < 120) w.push(["diplomacy", 5]);

  w.push(["court", 2], ["intrigue", 2], ["external", 2], ["church", 1], ["peasantry", 1]);

  const last = memory?.recentThemes?.[0];
  if (last) {
    for (let i = 0; i < w.length; i++) {
      if (w[i][0] === last) w[i][1] = clamp(w[i][1] - 1, 0, 999);
    }
  }

  return weightedRandom(w);
}


// Get an intent string based on the selected theme
function getIntentFromTheme(theme, metrics, activeArc) {
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



// Generate the planner packet 
function buildPlannerPacket(metrics, worldRow, activeArcRow) {
  const memory = worldRow?.memory || {};
  const theme = getTheme(metrics, memory, activeArcRow);

  const arcDirective = activeArcRow
    ? {
        kind: activeArcRow.kind,
        phase: activeArcRow.phase,
        stage: activeArcRow.stage,
        tension: activeArcRow.tension,
        expiresTurn: activeArcRow.expires_turn
      }
    : null;

  return {
    theme,
    intent: getIntentFromTheme(theme, metrics, activeArcRow),
    arcDirective
  };
}



// Retrieve situational and core knowledge using the FTS5 with BM25 ranking
function retrieveKnowledgeFTS(db, { kingId, query, topK = 10 }) {
  const q = String(query || "").trim();
  if (!q) return [];
  try {
    const rows = db.prepare(`
      SELECT
        k.id AS rowid,
        k.text AS text,
        f.tags AS tags,
        k.turn AS turn,
        bm25(knowledge_fts, 1.0, 0.3) AS score
      FROM knowledge_fts f
      JOIN knowledge k ON k.id = f.rowid
      WHERE knowledge_fts MATCH ?
        AND k.king_id = ?
      ORDER BY score ASC
      LIMIT ?
    `).all(q, kingId, topK);

    return rows.map(r => ({
      rowid: r.rowid,
      text: r.text,
      tags: String(r.tags || "").split(" ").filter(Boolean),
      turn: r.turn,
      score: r.score
    }));
  } catch (e) {

    try {
      const fallback = q.split(/\s+OR\s+/).slice(0, 6).join(" ");
      const rows2 = db.prepare(`
        SELECT
          k.id AS rowid,
          k.text AS text,
          f.tags AS tags,
          k.turn AS turn,
          bm25(knowledge_fts, 1.0, 0.3) AS score
        FROM knowledge_fts f
        JOIN knowledge k ON k.id = f.rowid
        WHERE knowledge_fts MATCH ?
          AND k.king_id = ?
        ORDER BY score ASC
        LIMIT ?
      `).all(fallback, kingId, topK);

      return rows2.map(r => ({
        rowid: r.rowid,
        text: r.text,
        tags: String(r.tags || "").split(" ").filter(Boolean),
        turn: r.turn,
        score: r.score
      }));
    } catch {
      return [];
    }
  }
}



// Merge and remove duplicates of the core and situational retrieved knowledge
function mergeRetrieved(core, situational, limit = 12) {
  const out = [];
  const seen = new Set();
  for (const x of [...(core || []), ...(situational || [])]) {
    const rid = x.rowid ?? "";
    const key = `${rid}|${String(x.text || "").slice(0, 160)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(x);
    if (out.length >= limit) break;
  }
  return out;
}



// Select a subset of retrieved knowledge to use as anchors for the LLM, prioritizing freshness and relevance
function selectAnchors(retrieved, { isFinale = false } = {}) {
  const list = Array.isArray(retrieved) ? retrieved.slice() : [];
  if (list.length === 0) return [];

  const byFresh = [...list].sort((a, b) => (b.turn ?? 0) - (a.turn ?? 0));
  const byScore = [...list].sort((a, b) => (a.score ?? 0) - (b.score ?? 0));

  const picks = [];
  const seen = new Set();
  const want = isFinale ? 6 : 4;

  function take(arr, n) {
    for (const r of arr) {
      const key = `${r.rowid}|${String(r.text || "").slice(0, 80)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      picks.push(r);
      if (picks.length >= n) break;
    }
  }

  if (isFinale) {
    take(byFresh, Math.min(3, want));
    take(byScore, want);
  } else {
    take(byFresh, 2);
    take(byScore, want);
  }

  return picks.slice(0, want);
}



// Build the full BM25 query for retrieval based on current game context, metrics and active arcs
function buildRetrievalQuery({ kingName, metrics, planner, worldRow, activeArc }) {
  const parts = [];
  if (planner?.intent) parts.push(planner.intent);
  if (planner?.theme) parts.push(planner.theme);

  const mem = worldRow?.memory || {};
  if (mem.lastEventSummary) parts.push(mem.lastEventSummary);
  if (mem.lastChoiceSummary) parts.push(mem.lastChoiceSummary);

  if (kingName) parts.push(kingName);

  if (activeArc?.status === "active") {
    parts.push(activeArc.kind, activeArc.title);
    if (activeArc.stakes) parts.push(activeArc.stakes);
    if (activeArc.phase) parts.push(activeArc.phase);
    if (activeArc.trigger_metric) parts.push(activeArc.trigger_metric);
  }

  if (metrics.economy < 120) parts.push("tax", "grain", "debt", "market", "trade");
  if (metrics.loyalty < 120) parts.push("nobles", "riot", "uprising", "oath");
  if (metrics.army < 120) parts.push("garrison", "deserters", "fort", "border");
  if (metrics.diplomacy < 120) parts.push("envoy", "treaty", "hostage", "alliance");

  const uniq = [];
  const seen = new Set();
  for (const p of parts.join(" ").split(/\s+/).filter(Boolean)) {
    const w = p.replace(/[^\p{L}\p{N}_-]+/gu, "").toLowerCase();
    if (!w || w.length < 3) continue;
    if (seen.has(w)) continue;
    seen.add(w);
    uniq.push(w);
    if (uniq.length >= 16) break;
  }

  const base = uniq.join(" OR ");
  const tagsPart = ["tags:event", "tags:arc", "tags:fact", "tags:decision"].join(" OR ");
  return [tagsPart, base].filter(Boolean).join(" OR ");
}



const { db, getKingRow } = require("../db");
function upsertKnowledgeFTS({ rowid, kingId, turn, text, tags = [] }) {
  const normTags = normalizeTags(tags);
  db.prepare(`
    INSERT OR REPLACE INTO knowledge_fts (rowid, text, tags, king_id, turn)
    VALUES (?, ?, ?, ?, ?)
  `).run(rowid, String(text || ""), normTags.join(" "), kingId, turn);
}



function insertKnowledge({ kingId, kind, refTable = null, refId = null, turn, tags = [], text }) {
  const t = String(text || "").trim();
  if (!t) return null;

  const normTags = normalizeTags(tags);

  const info = db.prepare(`
    INSERT INTO knowledge (king_id, kind, ref_table, ref_id, turn, tags_json, text, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(kingId, kind, refTable, refId, turn, JSON.stringify(normTags), t);

  const rowid = info.lastInsertRowid;
  upsertKnowledgeFTS({ rowid, kingId, turn, text: t, tags: normTags });
  return rowid;
}



function pruneFacts(kingId, maxFacts = 80) {
  const ids = db.prepare(`
    SELECT id FROM knowledge
    WHERE king_id=? AND kind='fact'
    ORDER BY turn DESC, id DESC
    LIMIT ?
  `).all(kingId, maxFacts).map(r => r.id);

  if (ids.length < maxFacts) return;

  const keepMinId = Math.min(...ids);
  db.prepare(`
    DELETE FROM knowledge
    WHERE king_id=? AND kind='fact' AND id < ?
  `).run(kingId, keepMinId);

  db.prepare(`
    DELETE FROM knowledge_fts
    WHERE rowid IN (
      SELECT f.rowid FROM knowledge_fts f
      LEFT JOIN knowledge k ON k.id=f.rowid
      WHERE k.id IS NULL
    )
  `).run();
}



function maybeInsertFact({ kingId, turn, text, tags = [] }) {
  const t = String(text || "").trim();
  if (!t) return null;

  const exists = db.prepare(`
    SELECT 1 FROM knowledge
    WHERE king_id=? AND kind='fact' AND text=? AND turn >= ?
    LIMIT 1
  `).get(kingId, t, Math.max(0, turn - 6));
  if (exists) return null;

  const rowid = insertKnowledge({
    kingId,
    kind: "fact",
    turn,
    tags: ["fact", ...tags],
    text: t
  });

  pruneFacts(kingId, 80);
  return rowid;
}



function insertDecisionFactAlways({ kingId, turn, theme, card, choiceIndex }) {
  const ci = Number.isInteger(choiceIndex) ? choiceIndex : null;
  if (!(card && (ci === 0 || ci === 1))) return;

  const title = String(card.title || "").trim();
  const choiceText = String(card.choices?.[ci]?.text || "").trim();
  if (!choiceText) return;

  maybeInsertFact({
    kingId,
    turn,
    tags: [theme || "event", "decision"],
    text: `King's decision (${title || "event"}): ${choiceText}`
  });
}



function insertImpactFacts({ kingId, turn, theme, effects }) {
  const deltas = [
    ["army", effects?.army || 0, "army"],
    ["economy", effects?.economy || 0, "economy"],
    ["diplomacy", effects?.diplomacy || 0, "diplomacy"],
    ["loyalty", effects?.loyalty || 0, "loyalty"]
  ];
  for (const [k, d, label] of deltas) {
    if (Math.abs(d) >= 10) {
      const dir = d > 0 ? "↑" : "↓";
      maybeInsertFact({
        kingId,
        turn,
        tags: [theme || "event", "impact", label],
        text: `${label} ${dir} (${Math.abs(d)})`
      });
    }
  }
}



function checkGameOver(metrics) {
  if (metrics.army <= 0) return { type: "army", text: "The army has collapsed. The realm is defenseless." };
  if (metrics.economy <= 0) return { type: "economy", text: "The treasury is empty. The kingdom falls into ruin." };
  if (metrics.diplomacy <= 0) return { type: "diplomacy", text: "All alliances are broken. Enemies surround the throne." };
  if (metrics.loyalty <= 0) return { type: "loyalty", text: "The people have turned against their king." };
  return null;
}



// Generate a summary of previous kings and reigns for planner
function buildDynastyMemoryBlock(kings) {
  if (!kings.length) return "No previous kings.";
  return kings.map((k, i) => {
    return `${i + 1}. King ${k.name} (reign length: ${k.turn} turns) — ${k.description}`;
  }).join("\n");
}



function requireKingAccess(req, res, next) {
  const kingId = Number(req.params.kingId || req.body?.kingId);
  if (!Number.isFinite(kingId)) return res.status(400).json({ error: "Bad kingId" });

  const king = getKingRow(kingId);
  if (!king) return res.status(404).json({ error: "King not found" });

  if (req.user?.role === "admin") {
    req.king = king;
    return next();
  }

  if (king.user_id !== req.user.id) {
    return res.status(403).json({ error: "No access to this king" });
  }

  req.king = king;
  next();
}

module.exports = {
  buildPlannerPacket,
  retrieveKnowledgeFTS,
  mergeRetrieved,
  selectAnchors,
  buildRetrievalQuery,
  normalizeTags,
  insertKnowledge,
  maybeInsertFact,
  insertDecisionFactAlways,
  insertImpactFacts,
  checkGameOver,
  buildDynastyMemoryBlock,
  requireKingAccess,
  getTheme,
  getIntentFromTheme,
  weightedRandom,
  clamp
};