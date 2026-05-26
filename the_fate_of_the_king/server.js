require("dotenv").config();
const express = require("express");
const cors = require("cors");


// ------------------------------------ //
// ---------- Import schemas ---------- //
// ------------------------------------ //
const { CARD_SCHEMA } = require("./schema/card-schema.js");
const { KING_SCHEMA } = require("./schema/king-schema.js");



// --------------------------------------------- //
// ---------- Import module functions ---------- //
// --------------------------------------------- //
const { makeValidator,
  parseStrictJson,
  normalizeCard
} = require("./validator/validator.js");

const {
  buildPlannerPacket,
  retrieveKnowledgeFTS,
  mergeRetrieved,
  selectAnchors,
  buildRetrievalQuery,
  insertKnowledge,
  maybeInsertFact,
  insertDecisionFactAlways,
  insertImpactFacts,
  checkGameOver,
  buildDynastyMemoryBlock,
  requireKingAccess
} = require("./planner/planner.js");

const { createInitialWorldState, applyChoiceToMemory } = require("./world/world-state.js");
const {
  normalizeArcSeed,
  getDefaultArcSeed,
  createActiveArcFromSeed,
  advanceArcRow,
  ARC_LEN_MIN,
  ARC_LEN_MAX,
  ensureArcCadenceMemory,
  getArcGap,
  getArcLengthFromHistory,
  isArcStartEligible,
  enforceArcSeedTurns,
  getLongArcStakesHint
} = require("./world/arc-manager.js");

const {
  hashPassword,
  verifyPassword,
  signToken,
  authRequired,
  adminRequired
} = require("./auth.js");

const { db } = require("./db");

const {
  safeJsonParse,
  getKingRow,
  getMetrics,
  getWorldRow,
  saveWorldRow,
  getActiveArc,
  getRecentKingsForUser,
  getEventIdByTurn,
  getEventCardByTurn,
  getRecentEventSummaries,
  getRecentEventCards,
  insertEvent,
  updateEventChoice,
  initializeAdminUser
} = require("./db");

const { buildRepeatAvoidanceBlock, isNearDuplicateCard } = require("./helpers/card-repeat.js");



// --------------------------------------- //
// ---------- Express app setup ---------- //
// --------------------------------------- //
const app = express();
app.use(cors());
app.use(express.json());

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL_ID = process.env.MODEL_ID || "arcee-ai/trinity-large-preview:free";

const { callLLMJson, generateImage } = require("./llm");

const validateKing = makeValidator(KING_SCHEMA.schema);
const validateCard = makeValidator(CARD_SCHEMA.schema);



// --------------------------------------- //
// ---------- Utility functions ---------- //
// --------------------------------------- //

// Sleep function for retry logic
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function isRetryable(err) {
  const msg = String(err?.message || "");
  return (
    msg.includes("502") ||
    msg.includes("503") ||
    msg.includes("504") ||
    msg.includes("429") ||
    msg.includes("Provider returned error")
  );
}

// Clamp metric values between 0 and 300
function clampMetric(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(300, Math.round(n)));
}



// -------------------------------- //
// ---------- API routes ---------- //
// -------------------------------- //

// User registration route
app.post("/auth/register", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const validEmail = String(email || "").trim().toLowerCase();
    const validPassword = String(password || "");

    if (!validEmail || !validPassword || validPassword.length < 6) {
      return res.status(400).json({ error: "Email and password are required (password must be at least 6 characters)" });
    }

    const exists = db.prepare(`SELECT id FROM users WHERE email=?`).get(validEmail);
    if (exists) return res.status(409).json({ error: "Email is already registered" });

    const passwordHash = await hashPassword(validPassword);
    const info = db.prepare(`INSERT INTO users (email, password_hash, role) VALUES (?, ?, 'user')`).run(validEmail, passwordHash);

    const user = { id: info.lastInsertRowid, email: validEmail, role: "user" };
    const token = signToken(user);
    res.json({ token, user });
  } catch (err) {
    res.status(500).json({ error: "register failed", details: String(err?.message || err).slice(0, 1000) });
  }
});



// User login route
app.post("/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const validEmail = String(email || "").trim().toLowerCase();
    const validPassword = String(password || "");

    const u = db.prepare(`SELECT id, email, password_hash, role FROM users WHERE email=?`).get(validEmail);
    if (!u) return res.status(401).json({ error: "Invalid email or password" });

    const ok = await verifyPassword(validPassword, u.password_hash);
    if (!ok) return res.status(401).json({ error: "Invalid login or password" });

    const user = { id: u.id, email: u.email, role: u.role };
    const token = signToken(user);
    res.json({ token, user });
  } catch (err) {
    res.status(500).json({ error: "login failed", details: String(err?.message || err).slice(0, 1000) });
  }
});



// Get current user info route
app.get("/me", authRequired, (req, res) => {
  res.json({ user: req.user });
});



// Get list of kings for the authenticated user
app.get("/kings", authRequired, (req, res) => {
  const rows = db.prepare(`
    SELECT k.id, k.name, k.age, k.created_at, k.reign_ended,
           ws.turn AS turn
    FROM kings k
    LEFT JOIN world_state ws ON ws.king_id = k.id
    WHERE k.user_id = ?
    ORDER BY k.id DESC
  `).all(req.user.id);

  const out = rows.map(row => {
    const activeArc = db.prepare(`SELECT title, status, phase FROM arcs WHERE king_id=? AND status='active' LIMIT 1`).get(row.id);
    const lastOutcome = db.prepare(`
      SELECT text, turn
      FROM knowledge
      WHERE king_id=? AND kind='arc_outcome'
      ORDER BY id DESC
      LIMIT 1
    `).get(row.id);

    return {
      kingId: row.id,
      name: row.name,
      age: row.age,
      createdAt: row.created_at,
      turn: row.turn ?? 0,
      reign_ended: row.reign_ended ?? 0,
      activeArc: activeArc ? { title: activeArc.title, status: activeArc.status, phase: activeArc.phase } : null,
      lastArcOutcome: lastOutcome ? { turn: lastOutcome.turn, text: lastOutcome.text } : null
    };
  });

  res.json({ kings: out });
});



// Get details of the king, metrics, turn based on kingId, with access control
app.get("/kings/:kingId", authRequired, requireKingAccess, (req, res) => {
  const kingId = Number(req.params.kingId);

  const king = getKingRow(kingId);
  if (!king) return res.status(404).json({ error: "Король не найден" });

  const metrics = getMetrics(kingId);
  const ws = getWorldRow(kingId);

  res.json({
    id: king.id,
    name: king.name,
    age: king.age,
    description: king.description,
    createdAt: king.created_at,
    metrics: metrics || { army: 150, economy: 150, diplomacy: 150, loyalty: 150 },
    turn: ws?.turn ?? 0
  });
});



// Get king history, including recent events and arc outcomes, with access control
app.get("/kings/:kingId/history", authRequired, requireKingAccess, (req, res) => {
  const kingId = Number(req.params.kingId);
  const king = req.king;

  const lastEvents = db.prepare(`
    SELECT turn, card_json, chosen_index
    FROM events
    WHERE king_id=? AND chosen_index IS NOT NULL
    ORDER BY turn DESC
    LIMIT 12
  `).all(kingId).map(row => {
    const card = safeJsonParse(row.card_json, null);
    return {
      turn: row.turn,
      title: String(card?.title || ""),
      choiceIndex: row.chosen_index,
      choiceText: String(card?.choices?.[row.chosen_index]?.text || "")
    };
  });

  const arcOutcomes = db.prepare(`
    SELECT turn, text
    FROM knowledge
    WHERE king_id=? AND kind='arc_outcome'
    ORDER BY id DESC
    LIMIT 10
  `).all(kingId);

  res.json({
    king: { id: king.id, name: king.name, age: king.age, description: king.description, createdAt: king.created_at },
    lastEvents,
    arcOutcomes
  });
});



// Generate new king and initial world state, with access control
app.post("/kings/start", authRequired, async (req, res) => {
  try {

    const recentKings = getRecentKingsForUser(req.user.id, 5);
    const dynastyMemory = buildDynastyMemoryBlock(recentKings);

    // Structured system prompt for LLM
    const kingSystemPrompt = `
ROLE: You are a professional dark medieval narrative designer.

DESIGN RULES:
- Grounded medieval setting. No modern tech.
- Maintain internal world consistency.
- Avoid trivial flavor events
- Avoid repetition of previously used structures.
- The new king must feel historically distinct.
- Description 4 of 10
- Temperature 1
Return ONLY valid JSON.
    `.trim()

    // Structured user prompt for LLM, including recent kings for context
    const kingPrompt = `
RECENT KINGS (recent rulers):
${dynastyMemory}

TASK:
Create a NEW king for the next reign.

REQUIREMENTS:
- The name must be structurally and phonetically distinct from previous kings.
- The path to power must NOT mirror previous reigns.
- Avoid repeating rebellions, church dominance, heirless death, or civil war if already used.
- The story must feel politically grounded and organic.

Return fields:
- name
- age (number)
- description (short origin story)
      `.trim()

    const data = await callLLMJson(
      {
        model: MODEL_ID,
        messages: [
          {
            role: "system",
            content: kingSystemPrompt
          },
          {
            role: "user",
            content: kingPrompt
          }
        ]
      },
      KING_SCHEMA
    );

    console.log(kingPrompt)

    const content = data.choices?.[0]?.message?.content;
    const king = parseStrictJson(content);

    if (!king) {
      return res.status(500).json({ error: "Failed to create king: Invalid JSON" });
    }

    const new_king = {
      name: String(king.name || "").trim(),
      age: parseInt(king.age, 10),
      description: String(king.description || "").trim()
    };

    // King validation
    const v = validateKing(new_king);
    if (!v.ok) {
      return res.status(500).json({ error: "King failed validation", details: v.errors });
    }

    const result = db.prepare(`
      INSERT INTO kings (user_id, name, age, description)
      VALUES (?, ?, ?, ?)
    `).run(req.user.id, new_king.name, new_king.age, new_king.description);

    const kingId = result.lastInsertRowid;

    db.prepare(`
      INSERT INTO metrics (king_id, army, economy, diplomacy, loyalty)
      VALUES (?, 150, 150, 150, 150)
    `).run(kingId);

    const worldState = createInitialWorldState(new_king);
    worldState.memory = ensureArcCadenceMemory(worldState.memory || {});
    worldState.memory.kingName = new_king.name;
    worldState.memory.finalePendingTurn = null;
    worldState.memory.lastFinaleArcId = null;
    worldState.memory.lastFinaleKey = null;
    if (worldState.memory.pendingArcResolution === undefined)
      worldState.memory.pendingArcResolution = null;

    saveWorldRow(kingId, {
      turn: worldState.turn,
      memory: worldState.memory,
      constraints: worldState.constraints
    });

    insertKnowledge({
      kingId,
      kind: "fact",
      turn: 0,
      tags: ["king", "origin"],
      text: `King ${new_king.name}: ${new_king.description}`
    });

    res.json({
      id: kingId,
      ...new_king,
      metrics: { army: 150, economy: 150, diplomacy: 150, loyalty: 150 }
    });

  } catch (err) {
    res.status(500).json({
      error: "Failed to create king",
      details: String(err?.message || err).slice(0, 1200)
    });
  }
});



// Generate event card for the turn, with access control, and save it to the database
app.post("/kings/:kingId/get-card", authRequired, requireKingAccess, async (req, res) => {
  try {
    const kingId = Number(req.params.kingId);

    const metrics = getMetrics(kingId);
    if (!metrics) return res.status(404).json({ error: "No metrics found" });

    const kingRow = getKingRow(kingId);
    const kingName = kingRow?.name ? String(kingRow.name) : "";

    let worldRow = getWorldRow(kingId);

    // Game over flag
    const isGameOver = worldRow?.memory?.gameOver || false;

    // Verify world state and necessary memory structure
    if (!worldRow) {
      const memory = ensureArcCadenceMemory({
        recentThemes: [],
        lastEventSummary: "",
        lastChoiceSummary: "",
        lastArc: null,
        pendingArcResolution: null,
        finalePendingTurn: null,
        lastFinaleArcId: null,
        lastFinaleKey: null,
        kingName
      });

      saveWorldRow(kingId, {
        turn: 0,
        memory,
        constraints: { tone: "dark medieval", noModern: true }
      });
      worldRow = getWorldRow(kingId);
    } else {
      worldRow.memory = ensureArcCadenceMemory(worldRow.memory || {});
      if (!worldRow.memory.kingName && kingName) worldRow.memory.kingName = kingName;

      if (worldRow.memory.finalePendingTurn === undefined) worldRow.memory.finalePendingTurn = null;
      if (worldRow.memory.lastFinaleArcId === undefined) worldRow.memory.lastFinaleArcId = null;
      if (worldRow.memory.lastFinaleKey === undefined) worldRow.memory.lastFinaleKey = null;
      if (worldRow.memory.pendingArcResolution && worldRow.memory.pendingArcResolution.arcId === undefined) {
        worldRow.memory.pendingArcResolution.arcId = null;
      }
    }

    // Game planner packer preparation
    const nextTurn = (worldRow.turn ?? 0) + 1;

    const existingCard = getEventCardByTurn(kingId, nextTurn);
    if (existingCard) {
      return res.json({ ...existingCard, turn: nextTurn, planner: { reused: true } });
    }

    const activeArc = getActiveArc(kingId);
    const planner = buildPlannerPacket(metrics, worldRow, activeArc);
    const recentCards = getRecentEventCards(kingId, 5);

    const pending = worldRow.memory?.pendingArcResolution || null;
    const pendingArcId = pending?.arcId ?? null;
    const lastFinaleArcId = worldRow.memory?.lastFinaleArcId ?? null;

    const pendingKey =
      pending && (pendingArcId == null)
        ? `${String(pending.title || "")}|${String(pending.kind || "")}|${String(pending.outcome || "")}`.slice(0, 220)
        : null;

    const isFinale =
      (!!pending && pendingArcId != null && pendingArcId !== lastFinaleArcId) ||
      (!!pendingKey && worldRow.memory.lastFinaleKey !== pendingKey);

    const arcStartEligible = !activeArc && !isFinale &&
      isArcStartEligible({ memory: worldRow.memory, currentTurn: nextTurn });

    let recentSummaries = [];
    let recentBlock = "- (none)";

    if (!activeArc && !isFinale) {
      recentSummaries = getRecentEventSummaries(kingId, 4);
      recentBlock = recentSummaries.length ? recentSummaries.join("\n") : "- (none)";
    }

    let retrieved = [];

    if (isFinale) {
      const coreQuery = `tags:king OR tags:origin`;
      const titlePart = String(pending?.title || "").replace(/[^\p{L}\p{N}_-]+/gu, " ").trim();
      const situationalQuery = ["tags:arc", "tags:outcome", "tags:start", "tags:event", titlePart].filter(Boolean).join(" OR ");

      const core = retrieveKnowledgeFTS(db, { kingId, query: coreQuery, topK: 3 });
      const situational = retrieveKnowledgeFTS(db, { kingId, query: situationalQuery, topK: 16 });
      retrieved = mergeRetrieved(core, situational, 16);
    } else {
      const coreQuery = `tags:king OR tags:origin OR tags:arc OR tags:fact OR tags:decision`;
      const situationalQuery = buildRetrievalQuery({ kingName, metrics, planner, worldRow, activeArc });

      const core = retrieveKnowledgeFTS(db, { kingId, query: coreQuery, topK: 6 });
      const situational = retrieveKnowledgeFTS(db, { kingId, query: situationalQuery, topK: 14 });
      retrieved = mergeRetrieved(core, situational, 16);
    }

    const anchorItems = selectAnchors(retrieved, { isFinale });
    const anchors =
      anchorItems.map(r => `- (turn ${r.turn}) ${String(r.text || "").trim()}`).join("\n") || "- (none)";

    let arcPacing = null;

    if (activeArc?.status === "active") {
      const totalTurns = Math.max(1, (activeArc.expires_turn - activeArc.created_turn));
      const progressTurns = Math.max(0, nextTurn - activeArc.created_turn);
      const remainingTurns = Math.max(0, activeArc.expires_turn - nextTurn);
      arcPacing = { totalTurns, progressTurns, remainingTurns, isLongArc: totalTurns >= 6 };
    }

    const directive = isFinale
      ? { mode: "arc_resolution", arc: pending, note: "EPILOGUE: Must explicitly close the arc. No new conflict. No new arc seed. Choices ceremonial (zero effects)." }
      : { mode: "normal", theme: planner.theme, intent: planner.intent, arcDirective: planner.arcDirective, arcStartEligible };

    const finaleChoiceA = "Accept the outcome and continue the reign.";
    const finaleChoiceB = "Secure the outcome and continue the reign.";

    const antiRepeatSection = (!activeArc && !isFinale)
      ? `Anti-repeat (DO NOT repeat these recent situations):\n${recentBlock}\n`
      : "";


    let gameOverSection = "";
    let prompt = "";

    // User and system prompt construction for LLM, based on game mode (normal or game over)
    // Normal mode: Generate a new event card based on current world state, active arc and recent events
    // Game over mode: Generate a final epilogue card that reflects the game over reason
    if (isGameOver) {
      gameOverSection = `
GAME OVER STATE:
Game Over Reason: ${worldRow.memory?.gameOverReason || "Unknown"}
`
      prompt = `
GAME: The Fate of the King
${gameOverSection}

METRICS (0..300, higher is better):
${JSON.stringify(metrics)}

BACKGROUND KNOWLEDGE:
${anchors}

TASK:
- Generate final tragic epilogue narrative.
- No new conflicts.
- Close story emotionally and historically.
- Choices must be ceremonial only.

OUTPUT: 
- ONLY Valid JSON matching schema.
`.trim();

    }
    else {
      prompt = `
GAME: The Fate of the King
${gameOverSection}
METRICS (0..300, higher is better):
${JSON.stringify(metrics)}

DIRECTIVE:
${JSON.stringify(directive)}

ACTIVE ARC PACING:
${JSON.stringify(arcPacing)}

ANTI-REPETITION RULES:
${antiRepeatSection}

BACKGROUND KNOWLEDGE:
${anchors}



TASK:
Generate ONE event card with:
- title
- description
- 2 choices
- each choice has:
    - text
    - effects (integer changes -20..20)

MODE RULES:
- If ACTIVE arc exists: escalate or reveal new development.
- If NO active arc:
    - If arcStartEligible=false: generate standalone side quest.
    - If arcStartEligible=true: you MAY include "arc" seed.

LONG ARC RULE (totalTurns >= 6):
- Include investigation, mystery, hidden motive, suspect, or treasure trail progression.
`.trim();
    }
    const antiRepeatHardBlock = buildRepeatAvoidanceBlock(recentCards);
    if (antiRepeatHardBlock) {
      prompt = `${prompt}\n\n${antiRepeatHardBlock}`;
    }
    const system_prompt = `
ROLE: You are a professional dark medieval narrative designer.

DESIGN RULES:
- Grounded medieval setting. No modern tech.
- Maintain internal world consistency.
- Create tension and meaningful trade-offs.
- Avoid trivial flavor events
- Avoid repetition of previously used structures.
- Ensure narrative forward motion.
- Escalate active arcs.
- Description 4 of 10
- Temperature 1

MULTI-STEP INTERNAL REASONING (do internally, do NOT reveal):
1. Identify current world pressure (political, economic, religious, military, personal).
2. Connect it to active arc or world state.
3. Create escalating development.
4. Design 2 asymmetric choices.

MODE RULES:
- Long arcs (>=6 turns): include investigation or clue progression.
- Effects: integers [-20..20].
- Tone: dark, medieval, politically and morally complex.
- Output: ONLY Valid JSON matching schema.
`.trim();

    let card = null;
    let lastCardError = null;
    const gameOverChoice = "Finish your reign and retire.";

    // Retry LLM generation if validation fails or if the card is event repetition
    for (let attempt = 1; attempt <= 3; attempt++) {
      const retryBlock = attempt > 1
        ? `\n\nRETRY CONSTRAINTS:\n- The previous draft was invalid or too similar to a recent event.\n- Use a different title.\n- Use a different opening sentence.\n- If ACTIVE arc exists: Continue the story and conflict that was in the final stages of the background knowledge.`
        : "";
      const label = `LLM generation king=${kingId} turn=${nextTurn} attempt=${attempt} ${Date.now()}`;
      console.time(label);

      let data;

      try {
        data = await callLLMJson(
          {
            model: MODEL_ID,
            messages: [
              { role: "system", content: system_prompt },
              { role: "user", content: `${prompt}${retryBlock}` }
            ]
          },
          CARD_SCHEMA
        );
      } finally {
        console.timeEnd(label);
      }

      console.log(prompt);

      const content = data.choices?.[0]?.message?.content;

      if (!content) {
        lastCardError = "Empty LLM response";
        continue;
      }

      let draft = normalizeCard(parseStrictJson(content));

      // Finale adjustments and checks
      if (isFinale) {

        const t = String(draft.title || "").trim();

        if (!/^Epilogue:|^Finale:/i.test(t)) {
          draft.title = `Epilogue: ${t || (pending?.title ? pending.title : "Finale of the arc")}`.slice(0, 120);
        }

        draft.choices = [
          { text: finaleChoiceA, effects: { army: 0, economy: 0, loyalty: 0, diplomacy: 0 } },
          { text: finaleChoiceB, effects: { army: 0, economy: 0, loyalty: 0, diplomacy: 0 } }
        ];

        if (draft.arc) delete draft.arc;

        const draftDescription = String(draft.description || "").trim();
        const has1 = draftDescription.includes("Arc concluded:");
        const has2 = draftDescription.includes("Price:");
        const has3 = draftDescription.includes("Now:");

        if (!(has1 && has2 && has3)) {
          const outcome = String(pending?.outcome || "").trim();
          const patch = [
            has1 ? null : `Arc concluded: ${outcome || "the crisis had a clear resolution."}`,
            has2 ? null : `Price: the decision left a mark on the people and treasury.`,
            has3 ? null : `Now: the king continues to rule in a new order of things.`
          ].filter(Boolean).join("\n");
          draft.description = `${draftDescription}\n\n${patch}`.trim().slice(0, 800);
        }

      } else if (!arcStartEligible && draft.arc) {
        delete draft.arc;
      }

      if (isGameOver) {
        draft.choices = [
          { text: gameOverChoice, effects: { army: 0, economy: 0, loyalty: 0, diplomacy: 0 } },
          { text: gameOverChoice, effects: { army: 0, economy: 0, loyalty: 0, diplomacy: 0 } }
        ];
      }

      const validatedDraft = validateCard(draft);

      if (!validatedDraft.ok) {
        lastCardError = validatedDraft.errors;
        continue;
      }

      const duplicateCheck = isNearDuplicateCard(draft, recentCards);

      if (duplicateCheck.duplicate) {
        lastCardError = duplicateCheck.reason;
        continue;
      }

      card = draft;
      break;
    }

    if (!card) {
      return res.status(500).json({ error: "Failed to generate distinct card", details: lastCardError });
    }

    try {
      card.image = await generateImage(`${card.title}. Medieval illustration, dark, dramatic, cinematic.`);
    } catch {
      card.image = null;
    }

    insertEvent({ kingId, turn: nextTurn, card });

    if (isFinale) {
      const worldRow = getWorldRow(kingId);
      worldRow.memory = ensureArcCadenceMemory(worldRow.memory || {});
      worldRow.memory.pendingArcResolution = null;
      worldRow.memory.finalePendingTurn = nextTurn;

      if (pendingArcId != null) worldRow.memory.lastFinaleArcId = pendingArcId;
      if (pendingKey) worldRow.memory.lastFinaleKey = pendingKey;

      saveWorldRow(kingId, { turn: worldRow.turn, memory: worldRow.memory, constraints: worldRow.constraints });
    }

    res.json({
      ...card,
      turn: nextTurn,
      planner: { theme: planner.theme, intent: planner.intent, mode: directive.mode, arcStartEligible }
    });

  } catch (err) {
    res.status(500).json({ error: "Failed to generate card", details: String(err?.message || err).slice(0, 1400) });
  }
});



// Apply choice effects to metrics and world state, with access control
app.post("/kings/:kingId/apply-choice", authRequired, requireKingAccess, (req, res) => {
  const kingId = Number(req.params.kingId);
  const { effects, choiceIndex, card, theme } = req.body || {};

  if (!effects) return res.status(400).json({ error: "Need effects" });

  try {

    const metrics = getMetrics(kingId);
    if (!metrics) return res.status(404).json({ error: "No metrics found" });

    let worldRow = getWorldRow(kingId);
    if (!worldRow) return res.status(500).json({ error: "world_state not found" });

    worldRow.memory = ensureArcCadenceMemory(worldRow.memory || {});

    // Validate choice index and card structure
    const ci = Number.isInteger(choiceIndex) ? choiceIndex : null;
    if (!(card && (ci === 0 || ci === 1))) return res.status(400).json({ error: "Need card and choiceIndex 0/1" });

    const supposedTurn = (worldRow.turn ?? 0) + 1;

    // Verify arc finale choice and enforce zero effects if it's a finale choice
    const isFinaleChoice =
      Number.isInteger(worldRow.memory?.finalePendingTurn) &&
      worldRow.memory.finalePendingTurn === supposedTurn;

    const eff = isFinaleChoice
      ? { army: 0, economy: 0, diplomacy: 0, loyalty: 0 }
      : {
        army: Number(effects.army) || 0,
        economy: Number(effects.economy) || 0,
        diplomacy: Number(effects.diplomacy) || 0,
        loyalty: Number(effects.loyalty) || 0
      };

    // Update metrics with choice effects
    const updated = {
      army: clampMetric(metrics.army + (eff.army || 0)),
      economy: clampMetric(metrics.economy + (eff.economy || 0)),
      diplomacy: clampMetric(metrics.diplomacy + (eff.diplomacy || 0)),
      loyalty: clampMetric(metrics.loyalty + (eff.loyalty || 0))
    };

    db.prepare(`UPDATE metrics SET army=?, economy=?, diplomacy=?, loyalty=? WHERE king_id=?`)
      .run(updated.army, updated.economy, updated.diplomacy, updated.loyalty, kingId);

    const mergedWorld = applyChoiceToMemory(worldRow, card, ci, theme);
    mergedWorld.memory = ensureArcCadenceMemory(mergedWorld.memory || {});

    // Set the next arc start turn
    if (isFinaleChoice) {

      mergedWorld.memory.finalePendingTurn = null;
      mergedWorld.memory.pendingArcResolution = null;

      const gap = Number.isInteger(mergedWorld.memory.pendingNextArcGap)
        ? mergedWorld.memory.pendingNextArcGap
        : pickArcGap();

      mergedWorld.memory.pendingNextArcGap = null;
      mergedWorld.memory.nextArcStartTurn = (mergedWorld.turn ?? 0) + gap;
    }

    saveWorldRow(kingId, { turn: mergedWorld.turn, memory: mergedWorld.memory, constraints: worldRow.constraints });

    updateEventChoice({
      kingId,
      turn: mergedWorld.turn,
      choiceIndex: ci,
      effects: eff,
      summary: `Choice: ${String(card.choices?.[ci]?.text || "").slice(0, 240)}`
    });

    const eventId = getEventIdByTurn(kingId, mergedWorld.turn);

    insertKnowledge({
      kingId,
      kind: "event",
      refTable: "events",
      refId: eventId,
      turn: mergedWorld.turn,
      tags: [theme || "event", "event"],
      text:
        `Turn ${mergedWorld.turn}. ${String(card.title || "").trim()} — ${String(card.description || "").trim().slice(0, 220)}. ` +
        `Choice: "${String(card.choices?.[ci]?.text || "").trim().slice(0, 200)}".`
    });

    if (!isFinaleChoice) {
      insertDecisionFactAlways({ kingId, turn: mergedWorld.turn, theme, card, choiceIndex: ci });
      insertImpactFacts({ kingId, turn: mergedWorld.turn, theme, effects: eff });
    }

    const gameOver = checkGameOver(updated);

    // Game over: update world state, mark reign ended, update active arc and insert game over fact
    if (gameOver) {

      const finalTurn = mergedWorld.turn;

      db.prepare(`
        UPDATE kings
        SET reign_ended = 1
        WHERE id = ?
      `).run(kingId);

      const activeArc = getActiveArc(kingId);

      if (activeArc) {
        db.prepare(`
          UPDATE arcs
          SET status='failed',
              phase='end',
              ended_turn=?,
              outcome_text=?,
              updated_at=CURRENT_TIMESTAMP
          WHERE id=?
        `).run(finalTurn, gameOver.text, activeArc.id);
      }

      mergedWorld.memory.gameOver = true;
      mergedWorld.memory.gameOverReason = gameOver.text;
      mergedWorld.memory.gameOverTurn = finalTurn;

      saveWorldRow(kingId, {
        turn: finalTurn,
        memory: mergedWorld.memory,
        constraints: worldRow.constraints
      });

      insertKnowledge({
        kingId,
        kind: "fact",
        turn: finalTurn,
        tags: ["game_over"],
        text: `Game Over: ${gameOver.text}`
      });

      return res.json({
        ...updated,
        gameOver: true
      });
    }

    let activeArc = getActiveArc(kingId);

    if (activeArc) {
      const advanced = advanceArcRow(activeArc, eff, updated, mergedWorld.turn);

      db.prepare(`
        UPDATE arcs
        SET status=?, phase=?, stage=?, tension=?, ended_turn=?, outcome_text=?, updated_at=CURRENT_TIMESTAMP
        WHERE id=?
      `).run(
        advanced.status,
        advanced.phase,
        advanced.stage,
        advanced.tension,
        advanced.ended_turn,
        advanced.outcome_text || "",
        activeArc.id
      );

      if (advanced.status !== "active") {

        const arcLen = Math.max(ARC_LEN_MIN, Math.min(ARC_LEN_MAX, (advanced.ended_turn - advanced.created_turn + 1)));

        const worldRow = getWorldRow(kingId);
        worldRow.memory = ensureArcCadenceMemory(worldRow.memory || {});

        worldRow.memory.lastArc = {
          title: advanced.title,
          kind: advanced.kind,
          status: advanced.status,
          endedTurn: advanced.ended_turn,
          outcome: advanced.outcome_text,
          length: arcLen
        };

        worldRow.memory.arcLengthHistory = [...(worldRow.memory.arcLengthHistory || []), arcLen].slice(-10);

        worldRow.memory.pendingArcResolution = {
          arcId: activeArc.id,
          title: advanced.title,
          kind: advanced.kind,
          outcome: advanced.outcome_text
        };

        worldRow.memory.pendingNextArcGap = pickArcGap();

        saveWorldRow(kingId, { turn: worldRow.turn, memory: worldRow.memory, constraints: worldRow.constraints });

        insertKnowledge({
          kingId,
          kind: "arc_outcome",
          refTable: "arcs",
          refId: activeArc.id,
          turn: mergedWorld.turn,
          tags: ["arc", advanced.kind, "outcome", advanced.status],
          text: `Resolved arc "${advanced.title}": ${advanced.outcome_text}`
        });
      }
    }

    // Verify new arc start, generate new arc and update world state 
    activeArc = getActiveArc(kingId);
    const eligibleNow = !activeArc && !isFinaleChoice &&
      isArcStartEligible({ memory: mergedWorld.memory, currentTurn: mergedWorld.turn });

    if (!activeArc && !isFinaleChoice && eligibleNow) {

      const worldRowNow = getWorldRow(kingId);
      worldRowNow.memory = ensureArcCadenceMemory(worldRowNow.memory || {});
      const lastArc = worldRowNow?.memory?.lastArc || null;

      const rawSeed = normalizeArcSeed(card.arc) || defaultArcSeed(updated);
      const pickedLen = pickArcLengthFromHistory(wNow.memory.arcLengthHistory);
      const seed = enforceArcSeedTurns(rawSeed, pickedLen);

      if (pickedLen >= 6) seed.stakes = longArcStakesHint(seed.stakes);

      const newArc = createActiveArcFromSeed(seed, mergedWorld.turn);

      const sameKey =
        lastArc &&
        String(lastArc.title || "").trim().toLowerCase() === String(newArc.title || "").trim().toLowerCase() &&
        String(lastArc.kind || "").trim().toLowerCase() === String(newArc.kind || "").trim().toLowerCase();

      if (!sameKey) {
        const info = db.prepare(`
          INSERT INTO arcs (
            king_id, title, kind, trigger_metric, stakes,
            status, phase, stage, tension,
            created_turn, expires_turn, ended_turn, outcome_text, updated_at, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, '', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `).run(
          kingId,
          newArc.title,
          newArc.kind,
          newArc.trigger_metric,
          newArc.stakes,
          newArc.status,
          newArc.phase,
          newArc.stage,
          newArc.tension,
          newArc.created_turn,
          newArc.expires_turn
        );

        mergedWorld.memory.nextArcStartTurn = (mergedWorld.turn ?? 0) + 9999;

        const startTags = ["arc", newArc.kind, "start", `len_${pickedLen}`];
        if (pickedLen >= 6) startTags.push("mystery", "investigation", "treasure");

        insertKnowledge({
          kingId,
          kind: "fact",
          refTable: "arcs",
          refId: info.lastInsertRowid,
          turn: mergedWorld.turn,
          tags: startTags,
          text: `Started arc "${newArc.title}" (${newArc.kind}, ${pickedLen} turns). Stakes: ${newArc.stakes}`
        });

        saveWorldRow(kingId, { turn: mergedWorld.turn, memory: mergedWorld.memory, constraints: worldRow.constraints });
      } else {

        mergedWorld.memory.nextArcStartTurn = (mergedWorld.turn ?? 0) + 3;
        saveWorldRow(kingId, { turn: mergedWorld.turn, memory: mergedWorld.memory, constraints: worldRow.constraints });
      
      }
    }

    res.json(updated);

  } catch (err) {

    res.status(500).json({ error: "Failed to apply choice", details: String(err?.message || err).slice(0, 1400) });
 
  }
});



// Admin route to update king metrics, with access control
app.patch("/admin/kings/:kingId/metrics", authRequired, adminRequired, (req, res) => {

  //console.log("Test")

  const kingId = Number(req.params.kingId);

  if (!Number.isFinite(kingId)) return res.status(400).json({ error: "Bad kingId" });

  const { army, economy, diplomacy, loyalty } = req.body || {};
  const current = getMetrics(kingId);
  
  if (!current) return res.status(404).json({ error: "No metrics found" });

  const updated = {
    army: clampMetric(army ?? current.army),
    economy: clampMetric(economy ?? current.economy),
    diplomacy: clampMetric(diplomacy ?? current.diplomacy),
    loyalty: clampMetric(loyalty ?? current.loyalty)
  };

  db.prepare(`UPDATE metrics SET army=?, economy=?, diplomacy=?, loyalty=? WHERE king_id=?`)
    .run(updated.army, updated.economy, updated.diplomacy, updated.loyalty, kingId);

  res.json({ ok: true, kingId, metrics: updated });
});



// Start the server and initialize admin user
const PORT = process.env.PORT || 3000;

(async () => {
  try {
    // Initialize admin user if not exists
    await initializeAdminUser(hashPassword);
  } catch (err) {
    console.error("Failed to initialize admin user:", err);
  }

  app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));
})();