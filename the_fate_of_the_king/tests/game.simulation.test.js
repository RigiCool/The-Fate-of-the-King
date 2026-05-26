process.env.DB_PATH = './test.db';
require('dotenv').config();
const { db, getWorldRow, getMetrics, getActiveArc, getRecentEventSummaries, getRecentEventCards, getKingRow } = require('../db');
const { makeValidator, parseStrictJson, normalizeCard } = require('../validator/validator.js');
const { CARD_SCHEMA } = require('../schema/card-schema.js');
const { KING_SCHEMA } = require('../schema/king-schema.js');

const {
  insertKnowledge,
  mergeRetrieved,
  retrieveKnowledgeFTS,
  buildPlannerPacket,
  selectAnchors,
  buildRetrievalQuery
} = require('../planner/planner.js');
const {
  normalizeArcSeed,
  defaultArcSeed,
  ensureArcCadenceMemory,
  pickArcLengthFromHistory,
  enforceArcSeedTurns,
  longArcStakesHint,
  createActiveArcFromSeed,
  isArcStartEligible,
  advanceArcRow,
  ARC_LEN_MIN,
  ARC_LEN_MAX,
  pickArcGap
} = require('../world/arc-manager.js');
const { createInitialWorldState, applyChoiceToMemory } = require('../world/world-state.js');

function clampMetric(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(300, Math.round(n)));
}

const validateKing = makeValidator(KING_SCHEMA.schema);
const validateCard = makeValidator(CARD_SCHEMA.schema);

function randomChoice(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

describe('Full Game Simulation (50 queries, persistent test.db, full logic)', () => {
  let kingId;
  let worldState;
  let metrics;
  let memory;
  let constraints;

  beforeAll(() => {
    const king = { name: 'SimKing', age: 40, description: 'desc' };
    const v = validateKing(king);
    expect(v.ok).toBe(true);
    kingId = Date.now() + Math.floor(Math.random() * 1000000);
    const uniqueEmail = `sim_${kingId}@test`;
    db.prepare('INSERT INTO users (id,email,password_hash) VALUES (?,?,?)').run(kingId, uniqueEmail, 'h');
    db.prepare('INSERT INTO kings (id,user_id,name,age,description) VALUES (?,?,?,?,?)').run(kingId, kingId, king.name, king.age, king.description);
    db.prepare('INSERT INTO metrics (king_id, army, economy, loyalty, diplomacy) VALUES (?,?,?,?,?)').run(kingId, 150, 150, 150, 150);
    worldState = createInitialWorldState(king);
    memory = ensureArcCadenceMemory(worldState.memory || {});
    memory.kingName = king.name;
    if (memory.finalePendingTurn === undefined) memory.finalePendingTurn = null;
    if (memory.lastFinaleArcId === undefined) memory.lastFinaleArcId = null;
    if (memory.lastFinaleKey === undefined) memory.lastFinaleKey = null;
    constraints = worldState.constraints;
    db.prepare('INSERT INTO world_state (king_id, turn, memory_json, constraints_json) VALUES (?,?,?,?)').run(kingId, 0, JSON.stringify(memory), JSON.stringify(constraints));
    metrics = { army: 150, economy: 150, loyalty: 150, diplomacy: 150 };
    insertKnowledge({
      kingId,
      kind: 'fact',
      turn: 0,
      tags: ['king', 'origin'],
      text: `King ${king.name}: ${king.description}`
    });
  });

  test('simulate 50 game queries with full server logic', async () => {
    let gameOver = false;
    for (let i = 0; i < 50 && !gameOver; i++) {
      const worldRow = getWorldRow(kingId);
      const turn = worldRow ? worldRow.turn : i;

      memory = worldRow ? worldRow.memory : memory;
      constraints = worldRow ? worldRow.constraints : constraints;
      metrics = getMetrics(kingId);

      let activeArc = getActiveArc(kingId);

      console.log("activeArc", activeArc);
      memory = ensureArcCadenceMemory(memory);

      const kingRow = getKingRow(kingId);
      const kingName = kingRow?.name ? String(kingRow.name) : "SimKing";
      const plannerPacket = buildPlannerPacket(metrics, { turn, memory, constraints }, activeArc);
      const pending = memory?.pendingArcResolution || null;
      const pendingArcId = pending?.arcId ?? null;
      const lastFinaleArcId = memory?.lastFinaleArcId ?? null;
      
      const pendingKey =
        pending && (pendingArcId == null)
          ? `${String(pending.title || "")}|${String(pending.kind || "")}|${String(pending.outcome || "")}`.slice(0, 220)
          : null;
      
          const isFinale =
        (!!pending && pendingArcId != null && pendingArcId !== lastFinaleArcId) ||
        (!!pendingKey && memory.lastFinaleKey !== pendingKey);
      
      console.log(`Turn ${turn}: isFinale=${isFinale}, pendingArcId=${pendingArcId}, lastFinaleArcId=${lastFinaleArcId}, pendingKey=${pendingKey}, lastFinaleKey=${memory.lastFinaleKey}`);
      
      const arcStartEligible = !activeArc && !isFinale && isArcStartEligible({ memory, currentTurn: turn + 1 });

      if (isFinale) {
        memory.pendingArcResolution = null;
        memory.finalePendingTurn = turn + 1;
        if (pendingArcId != null) memory.lastFinaleArcId = pendingArcId;
        if (pendingKey) memory.lastFinaleKey = pendingKey;
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
        const situationalQuery = buildRetrievalQuery ? buildRetrievalQuery({ kingName, metrics, planner: plannerPacket, worldRow: { turn, memory, constraints }, activeArc }) : '';
        const core = retrieveKnowledgeFTS(db, { kingId, query: coreQuery, topK: 6 });
        const situational = situationalQuery ? retrieveKnowledgeFTS(db, { kingId, query: situationalQuery, topK: 14 }) : [];
        retrieved = mergeRetrieved(core, situational, 16);
      }

      const anchorItems = selectAnchors(retrieved, { isFinale });
      const anchors = anchorItems.map(r => `- (turn ${r.turn}) ${String(r.text || '').trim()}`).join("\n") || "- (none)";

      let recentSummaries = [];
      let antiRepeatSection = "- (none)";
      
      if (!activeArc && !isFinale) {
        recentSummaries = getRecentEventSummaries(kingId, 4);
        antiRepeatSection = recentSummaries.length ? recentSummaries.join("\n") : "- (none)";
      }
      
      const antiRepeatBlock = (!activeArc && !isFinale) ? `Anti-repeat (DO NOT repeat these recent situations):\n${antiRepeatSection}\n` : "";
      const recentCards = getRecentEventCards(kingId, 5);

      let arcPacing = null;
      
      if (activeArc && activeArc.status === "active") {
        const totalTurns = Math.max(1, (activeArc.expires_turn - activeArc.created_turn));
        const progressTurns = Math.max(0, turn + 1 - activeArc.created_turn);
        const remainingTurns = Math.max(0, activeArc.expires_turn - (turn + 1));
        arcPacing = { totalTurns, progressTurns, remainingTurns, isLongArc: totalTurns >= 6 };
      }

      let directive;
      
      if (isFinale) {
        directive = {
          mode: "arc_resolution",
          arc: pending,
          note: "EPILOGUE: Must explicitly close the arc. No new conflict. No new arc seed. Choices ceremonial (zero effects)."
        };
      } else {
        directive = {
          mode: "normal",
          theme: plannerPacket.theme,
          intent: plannerPacket.intent,
          arcDirective: plannerPacket.arcDirective,
          arcStartEligible
        };
      }

      const userPrompt = `GAME: The Fate of the King\n\nMETRICS (0..300, higher is better):\n${JSON.stringify(metrics)}\n\nDIRECTIVE:\n${JSON.stringify(directive)}\n\nACTIVE ARC PACING:\n${JSON.stringify(arcPacing)}\n\nANTI-REPETITION RULES:\n${antiRepeatBlock}\nBACKGROUND KNOWLEDGE:\n${anchors}\n\nTASK:\n- Generate ONE event card with:\n  - title\n  - description\n  - 2 choices\n  - each choice has:\n      - text\n      - effects (integer changes -20..20)\n\nMODE RULES:\n- If ACTIVE arc exists: escalate or reveal new development.\n- If NO active arc:\n    - If arcStartEligible=false: generate standalone side quest.\n    - If arcStartEligible=true: you should include \"arc\" seed.\n\nLONG ARC RULE (totalTurns >= 6):\n- Include investigation, mystery, hidden motive, suspect, or treasure trail progression.`.trim();
      const systemPrompt = `ROLE: You are a professional dark medieval narrative designer.\n\nDESIGN RULES:\n- Grounded medieval setting. No modern tech.\n- Maintain internal world consistency.\n- Create tension and meaningful trade-offs.\n- Avoid trivial flavor events\n- Avoid repetition of previously used structures.\n- Ensure narrative forward motion.\n- Escalate active arcs.\n- Description 4 of 10\n- Temperature 1\n\nMULTI-STEP INTERNAL REASONING (do internally, do NOT reveal):\n1. Identify current world pressure (political, economic, religious, military, personal).\n2. Connect it to active arc or world state.\n3. Create escalating development.\n4. Design 2 asymmetric choices.\n\nMODE RULES:\n- Long arcs (>=6 turns): include investigation or clue progression.\n- Effects: integers [-20..20].\n- Tone: dark, medieval, politically and morally complex.\n- Output: ONLY Valid JSON matching schema.`.trim();
      
      const { card, validation } = await require('./safe-generate-card.js').generateCard(userPrompt, {
        systemPrompt,
        recentCards,
        maxAttempts: 3
      });
      
      expect(card).toBeDefined();
      
      if (!validation.ok) {
        console.error('Card validation failed:', validation.errors);
        console.error('Card object:', JSON.stringify(card, null, 2));
      }
      
      expect(validation.ok).toBe(true);
      const normCard = normalizeCard(card);
      
      expect(validateCard(normCard).ok).toBe(true);
      const simChoiceIdx = Math.floor(Math.random() * 2);
      const simChoice = normCard.choices[simChoiceIdx];

      const supposedTurn = (turn ?? 0) + 1;
      const isFinaleChoice = Number.isInteger(memory?.finalePendingTurn) && memory.finalePendingTurn === supposedTurn;
      
      const simEff = isFinaleChoice
        ? { army: 0, economy: 0, loyalty: 0, diplomacy: 0 }
        : (simChoice.effects || {});

      let newWorld = applyChoiceToMemory({ turn, memory, constraints }, normCard, simChoiceIdx, plannerPacket.theme);
      newWorld.memory = ensureArcCadenceMemory(newWorld.memory);

      if (isFinaleChoice) {
        newWorld.memory.finalePendingTurn = null;
        newWorld.memory.pendingArcResolution = null;
        const gap = Number.isInteger(newWorld.memory.pendingNextArcGap)
          ? newWorld.memory.pendingNextArcGap
          : pickArcGap();
        newWorld.memory.pendingNextArcGap = null;
        newWorld.memory.nextArcStartTurn = (newWorld.turn ?? 0) + gap;
      }

      db.prepare('UPDATE world_state SET turn=?, memory_json=?, constraints_json=? WHERE king_id=?')
        .run(newWorld.turn, JSON.stringify(newWorld.memory), JSON.stringify(newWorld.constraints), kingId);

      for (const key of ['army', 'economy', 'loyalty', 'diplomacy']) {
        if (typeof simEff[key] === 'number') {
          metrics[key] = clampMetric(metrics[key] + simEff[key]);
        }
      }
      
      db.prepare('UPDATE metrics SET army=?, economy=?, loyalty=?, diplomacy=? WHERE king_id=?')
        .run(metrics.army, metrics.economy, metrics.loyalty, metrics.diplomacy, kingId);

      db.prepare('INSERT INTO events (king_id, turn, card_json, chosen_index, effects_json, summary, background_knowledge, anti_repeat, arc_pacing) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(
          kingId,
          newWorld.turn,
          JSON.stringify(normCard),
          simChoiceIdx,
          JSON.stringify(simEff),
          '',
          anchors,
          (!activeArc && !isFinale) ? antiRepeatBlock : null,
          arcPacing ? JSON.stringify(arcPacing) : null
        );

      insertKnowledge({
        kingId,
        kind: 'event',
        refTable: 'events',
        refId: null,
        turn: newWorld.turn,
        tags: [plannerPacket.theme || 'event', 'event'],
        text: `Turn ${newWorld.turn}. ${normCard.title} — ${normCard.description}. Choice: "${normCard.choices[simChoiceIdx].text}".`
      });

      activeArc = db.prepare("SELECT * FROM arcs WHERE king_id=? AND status='active' LIMIT 1").get(kingId) || null;
      
      if (activeArc) {

        const eff = simEff;
        const updatedMetrics = {
          army: metrics.army,
          economy: metrics.economy,
          loyalty: metrics.loyalty,
          diplomacy: metrics.diplomacy
        };
        const advanced = advanceArcRow(activeArc, eff, updatedMetrics, newWorld.turn);
        db.prepare('UPDATE arcs SET status=?, phase=?, stage=?, tension=?, ended_turn=?, outcome_text=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
          .run(advanced.status, advanced.phase, advanced.stage, advanced.tension, advanced.ended_turn, advanced.outcome_text || '', activeArc.id);
        if (advanced.status !== 'active') {
          const arcLen = Math.max(ARC_LEN_MIN, Math.min(ARC_LEN_MAX, (advanced.ended_turn - advanced.created_turn + 1)));
          let w2 = db.prepare('SELECT turn, memory_json, constraints_json FROM world_state WHERE king_id=?').get(kingId);
          w2.memory = ensureArcCadenceMemory(JSON.parse(w2.memory_json));
          w2.memory.lastArc = {
            title: advanced.title,
            kind: advanced.kind,
            status: advanced.status,
            endedTurn: advanced.ended_turn,
            outcome: advanced.outcome_text,
            length: arcLen
          };
          w2.memory.arcLengthHistory = [...(w2.memory.arcLengthHistory || []), arcLen].slice(-10);
          w2.memory.pendingArcResolution = {
            arcId: activeArc.id,
            title: advanced.title,
            kind: advanced.kind,
            outcome: advanced.outcome_text
          };
          w2.memory.pendingNextArcGap = pickArcGap();
          db.prepare('UPDATE world_state SET turn=?, memory_json=?, constraints_json=? WHERE king_id=?')
            .run(w2.turn, JSON.stringify(w2.memory), w2.constraints_json, kingId);
          insertKnowledge({
            kingId,
            kind: 'arc_outcome',
            refTable: 'arcs',
            refId: activeArc.id,
            turn: newWorld.turn,
            tags: ['arc', advanced.kind, 'outcome', advanced.status],
            text: `Resolved arc "${advanced.title}": ${advanced.outcome_text}`
          });
        }
      }
      
      activeArc = db.prepare("SELECT * FROM arcs WHERE king_id=? AND status='active' LIMIT 1").get(kingId) || null;

      if (!activeArc && !isFinaleChoice) {
        const eligibleNow = isArcStartEligible({ memory: newWorld.memory, currentTurn: newWorld.turn });
        if (eligibleNow) {
          const lastArc = newWorld?.memory?.lastArc || null;
          const rawSeed = normalizeArcSeed(normCard.arc) || defaultArcSeed(metrics);
          const pickedLen = pickArcLengthFromHistory(newWorld.memory.arcLengthHistory);
          const seed = enforceArcSeedTurns(rawSeed, pickedLen);
          if (pickedLen >= 6) seed.stakes = longArcStakesHint(seed.stakes);

          const newArc = createActiveArcFromSeed(seed, newWorld.turn);
          const sameKey =
            lastArc &&
            String(lastArc.title || '').trim().toLowerCase() === String(newArc.title || '').trim().toLowerCase() &&
            String(lastArc.kind || '').trim().toLowerCase() === String(newArc.kind || '').trim().toLowerCase();

          if (!sameKey) {
            const info = db.prepare(`INSERT INTO arcs (king_id, title, kind, trigger_metric, stakes, status, phase, stage, tension, created_turn, expires_turn, ended_turn, outcome_text, updated_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`).run(
              kingId, newArc.title, newArc.kind, newArc.trigger_metric, newArc.stakes, newArc.status, newArc.phase, newArc.stage, newArc.tension, newArc.created_turn, newArc.expires_turn, null, ''
            );
            newWorld.memory.nextArcStartTurn = (newWorld.turn ?? 0) + 9999;
            const startTags = ['arc', newArc.kind, 'start', `len_${pickedLen}`];
            if (pickedLen >= 6) startTags.push('mystery', 'investigation', 'treasure');
            insertKnowledge({
              kingId,
              kind: 'fact',
              refTable: 'arcs',
              refId: info.lastInsertRowid,
              turn: newWorld.turn,
              tags: startTags,
              text: `Started arc "${newArc.title}" (${newArc.kind}, ${pickedLen} turns). Stakes: ${newArc.stakes}`
            });
          } else {
            newWorld.memory.nextArcStartTurn = (newWorld.turn ?? 0) + 3;
          }

          db.prepare('UPDATE world_state SET turn=?, memory_json=?, constraints_json=? WHERE king_id=?')
            .run(newWorld.turn, JSON.stringify(newWorld.memory), JSON.stringify(newWorld.constraints), kingId);
        }
      }

      if (metrics.army <= 0 || metrics.economy <= 0 || metrics.loyalty <= 0 || metrics.diplomacy <= 0) {
        gameOver = true;

        db.prepare('UPDATE kings SET reign_ended = 1 WHERE id = ?').run(kingId);
        newWorld.memory.gameOver = true;
        newWorld.memory.gameOverReason = 'A metric reached zero.';
        db.prepare('UPDATE world_state SET turn=?, memory_json=?, constraints_json=? WHERE king_id=?')
          .run(newWorld.turn, JSON.stringify(newWorld.memory), JSON.stringify(newWorld.constraints), kingId);
        insertKnowledge({
          kingId,
          kind: 'fact',
          turn: newWorld.turn,
          tags: ['game_over'],
          text: `Game Over: A metric reached zero.`
        });
      }

      if (!Array.isArray(newWorld.memory.recentThemes)) newWorld.memory.recentThemes = [];
      
      newWorld.memory.recentThemes.unshift(plannerPacket.theme);
      newWorld.memory.recentThemes = newWorld.memory.recentThemes.slice(0, 10);
    }

    const count = db.prepare('SELECT COUNT(*) as cnt FROM events WHERE king_id=?').get(kingId).cnt;
    expect(count).toBeGreaterThanOrEqual(1);
    expect(count).toBeLessThanOrEqual(50);
  }, 1800000);
});
