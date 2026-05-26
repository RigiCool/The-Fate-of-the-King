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
  } catch {
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

function mergeRetrieved(core, situational, limit = 16) {
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

    const st = Number(activeArc.stage || 0);
    if (st <= 1) parts.push("rumor", "pressure", "warning");
    else if (st === 2) parts.push("ultimatum", "deadline", "uprising", "siege");
    else parts.push("confrontation", "trial", "battle", "reckoning");
  }

  if (metrics.economy < 120) parts.push("tax", "grain", "debt", "market", "trade");
  if (metrics.loyalty < 120) parts.push("nobles", "riot", "uprising", "oath");
  if (metrics.army < 120) parts.push("garrison", "deserters", "fort", "border");
  if (metrics.diplomacy < 120) parts.push("envoy", "treaty", "hostage", "alliance");

  const tagHints = [];
  if (planner?.theme) tagHints.push(`tags:${String(planner.theme).toLowerCase().replace(/[^\w-]+/g, "")}`);
  if (activeArc?.kind) tagHints.push(`tags:${String(activeArc.kind).toLowerCase().replace(/[^\w-]+/g, "")}`);
  tagHints.push("tags:event", "tags:arc", "tags:fact", "tags:decision");

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
  const tagsPart = tagHints.filter(Boolean).join(" OR ");
  return [tagsPart, base].filter(Boolean).join(" OR ");
}

module.exports = {
  retrieveKnowledgeFTS,
  mergeRetrieved,
  selectAnchors,
  buildRetrievalQuery
};