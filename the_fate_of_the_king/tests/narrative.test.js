process.env.DB_PATH = './test.db';

const Database = require('better-sqlite3');
const nlp = require('compromise');



// -------------------------- //
// -------- Constants ------- //
// -------------------------- //

// A set of common particles to avoid in tokenization. They did not provide valuable information for narrative testing.
const STOP_WORDS_2 = new Set([
  'in', 'of', 'is', 'at', 'to', 'be', 'we', 'my', 'by', 'if',
  'do', 'go', 'it', 'or', 'as', 'an', 'so', 'no', 'up', 'on',
  'he', 'me', 'us', 'am', 'wo', 'ye', 'th', 'he', 'hi', 'ha',
]);



// Synonym groups for arc kinds, used to expand token sets for better match in narrative tests. Imporove narrative results for reflected arc events.
const ARC_KIND_SYNONYMS = {
  rebellion: ['revolt', 'uprising', 'rebel', 'mutiny', 'insurgent', 'sedition', 'traitor', 'defiance',
    'rioter', 'rioters', 'mob', 'protest', 'dissent', 'agitator', 'militia', 'faction', 'insurrection',
    'subversion', 'insurgency', 'dissident', 'revolutionary', 'overthrow', 'usurper', 'coup',
    'rebellious', 'unrest', 'traitorous', 'separatist', 'agitators', 'resistance', 'defector', 'defectors'],
  war: ['battle', 'siege', 'conflict', 'assault', 'campaign', 'enemy', 'invade', 'soldier', 'front',
    'army', 'troops', 'warrior', 'attack', 'defense', 'skirmish', 'raid', 'garrison', 'commander',
    'cavalry', 'infantry', 'general', 'marshal', 'fortification', 'stronghold', 'conquest', 'victory',
    'hostile', 'hostilities', 'warfare', 'barracks', 'legion', 'archers', 'mercenary', 'fortress'],
  famine: ['hunger', 'starve', 'harvest', 'drought', 'bread', 'crops', 'food', 'grain', 'shortage',
    'ration', 'stockpile', 'supply', 'scarcity', 'price', 'market', 'store', 'feed', 'wheat',
    'starvation', 'famine', 'dearth', 'barren', 'withered', 'yield', 'granary', 'provisions',
    'blight', 'lean', 'malnutrition', 'forage', 'breadline', 'meager', 'hollow', 'cropfailure'],
  plague: ['disease', 'illness', 'sick', 'death', 'corpse', 'spread', 'pestilence', 'fever', 'quarantine',
    'dying', 'dead', 'infected', 'contagion', 'symptom', 'healer', 'medicine', 'outbreak', 'afflict',
    'plague', 'epidemic', 'physician', 'cure', 'malady', 'sickness', 'affliction', 'scourge',
    'infectious', 'contaminated', 'miasma', 'pallor', 'bedridden', 'quarantined', 'remedy', 'infect'],
  church: ['bishop', 'clergy', 'faith', 'heresy', 'priest', 'sermon', 'cardinal', 'pope', 'chapel',
    'monk', 'nun', 'abbey', 'cathedral', 'prayer', 'blessing', 'excommunicate', 'holy', 'divine',
    'religious', 'monastery', 'saint', 'sacred', 'spiritual', 'salvation', 'damnation', 'piety',
    'relic', 'pilgrim', 'pilgrimage', 'doctrine', 'canon', 'confession', 'anointed', 'worship'],
  intrigue: ['spy', 'conspiracy', 'plot', 'assassin', 'secret', 'betrayal', 'poison', 'scheme', 'dagger',
    'informant', 'mole', 'blackmail', 'bribe', 'corrupt', 'rumor', 'whisper', 'evidence', 'suspect',
    'treachery', 'sabotage', 'espionage', 'deception', 'sting', 'trap', 'ambush', 'subterfuge',
    'collusion', 'doublecross', 'forgery', 'forged', 'covert', 'leak', 'intercept', 'shadowy'],
  succession: ['heir', 'crown', 'throne', 'inherit', 'dynasty', 'claimant', 'regent', 'lineage', 'noble',
    'prince', 'princess', 'king', 'queen', 'royal', 'bloodline', 'legitimate', 'bastard', 'contest',
    'coronation', 'usurp', 'ascend', 'dynasty', 'succession', 'rightful', 'claim', 'legitimacy',
    'inheritance', 'abdicate', 'abdication', 'enthrone', 'enthronement', 'pretender', 'heiress', 'sovereign'],
  trade: ['merchant', 'coin', 'market', 'tax', 'guild', 'commerce', 'debt', 'caravan', 'tariff',
    'goods', 'route', 'profit', 'contract', 'negotiate', 'stockpile', 'import', 'export', 'price',
    'trader', 'commerce', 'business', 'transaction', 'deal', 'goods', 'commodity', 'monopoly',
    'tribute', 'levy', 'toll', 'shipment', 'barter', 'warehouse', 'embargo', 'customs'],
};



// Synonym groups for escalation detection and tension increase narrative validationin.
const ARC_ESCALATION_WORDS = [
  'mob', 'riot', 'rioters', 'uprising', 'revolt', 'fire', 'fires', 'burn', 'burning',
  'smash', 'sack', 'siege', 'assault', 'attack', 'blood', 'panic', 'chaos', 'collapse',
  'threat', 'threaten', 'urgent', 'violence', 'violent', 'starve', 'famine', 'shortage',
  'plague', 'outbreak', 'mutiny', 'war', 'battle', 'defiance', 'crisis', 'disaster', 'catastrophe',
  'desperate', 'critical', 'grave', 'dire', 'peril', 'ruin', 'destruction', 'devastated', 'slaughter',
  'massacre', 'uprising', 'rebellion', 'invasion', 'rampage', 'havoc', 'calamity', 'besieged',
  'torched', 'lynch', 'lynching', 'fracture', 'shatter', 'breakdown', 'onslaught', 'doom',
  'retaliation', 'retaliate', 'purge', 'crackdown', 'execute', 'execution', 'overrun', 'breach',
  'stormed', 'ravage', 'ravaged', 'worsening', 'spiral', 'spiraling', 'destabilize', 'destabilized',
];



// Synonym groups for resolution detection and tension decrease narrative validation.
const ARC_RESOLUTION_WORDS = [
  'peace', 'truce', 'settle', 'settled', 'resolve', 'resolved', 'restore', 'restored',
  'order', 'calm', 'aftermath', 'alliance', 'ceasefire', 'victory', 'defeat', 'surrender',
  'collapse', 'ended', 'conclusion', 'treaty', 'agreement', 'reconcile', 'forgive',
  'peace', 'harmony', 'stability', 'balance', 'triumph', 'honor', 'justice', 'retribution',
  'redemption', 'atonement', 'closure', 'finality', 'settlement', 'arbitration', 'mediation',
  'accord', 'pardoned', 'pardon', 'unite', 'united', 'reunite', 'reunited', 'secured',
  'stabilized', 'stabilize', 'recovered', 'recovery', 'healed', 'healing', 'relief', 'relieved',
  'contained', 'containment', 'restraint', 'resolution', 'legitimized', 'enthroned', 'ratified', 'repaired',
];



// A set of role related words to identify character for narrative object validation.
const ROLE_WORD_SET = new Set([
  'king', 'queen', 'prince', 'princess', 'duke', 'duchess', 'count', 'countess',
  'lord', 'lady', 'sir', 'captain', 'general', 'marshal', 'bishop', 'abbot',
  'chancellor', 'regent', 'commander', 'baron', 'baroness',
  'archbishop', 'archdeacon', 'cardinal', 'priest', 'monk', 'nun', 'abbess', 'prior', 'friar',
  'steward', 'constable', 'chamberlain', 'seneschal', 'herald',
  'knight', 'squire', 'guard', 'watchman',
  'merchant', 'trader', 'guildmaster',
  'spy', 'messenger', 'envoy',
  'scribe', 'chronicler', 'bailiff', 'reeve',
  'farmer', 'servant', 'blacksmith', 'miller', 'baker', 'innkeeper',
  'healer', 'physician', 'alchemist', 'minstrel', 'jester', 'executioner',
  'sailor', 'admiral',
]);



// ---------------------------------- //
// -------- Utility functions ------- //
// ---------------------------------- //
function print(line = '') {
  process.stdout.write(`${line}\n`);
}



function formatScore(value, digits = 2) {
  return Number(value || 0).toFixed(digits);
}



function safeJsonParse(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}



// Tokenize text into normalized tokens with the filter of short words
function tokenize(text) {
  return normalizeText(text)
    .split(' ')
    .filter((token) => token.length >= 2 && !STOP_WORDS_2.has(token));
}



// Soft token overlap that considers synonyms and partial matches, returning a score between 0 and 1
function jaccardOverlap(aTokens, bTokens) {
  const firstSet = new Set(aTokens);
  const secondSet = new Set(bTokens);
  if (!firstSet.size || !secondSet.size) return 0;

  let intersection = 0;
  for (const token of firstSet) {
    if (secondSet.has(token)) intersection += 1;
  }

  const union = new Set([...firstSet, ...secondSet]).size || 1;
  return intersection / union;
}



// Adaptive token overlap that accounts for synonyms and partial matches, to detect semantic close tokens 
function softTokenOverlap(aTokens, bTokens) {
  const firstSet = new Set(aTokens);
  const secondSet = new Set(bTokens);
  if (!firstSet.size || !secondSet.size) return 0;

  let intersection = 0;
  for (const tokenA of firstSet) {
    const synonymGroupA = TOKEN_SYNONYM_GROUPS.get(tokenA);
    for (const tokenB of secondSet) {
      if (
        tokenA === tokenB ||
        (tokenA.length >= 3 && tokenB.length >= 3 &&
          (tokenA.startsWith(tokenB) || tokenB.startsWith(tokenA))) ||
        (synonymGroupA && synonymGroupA.has(tokenB))
      ) {
        intersection++;
        break;
      }
    }
  }

  const union = new Set([...firstSet, ...secondSet]).size || 1;
  return intersection / union;
}



// Expand arc tokens with synonyms for better narrative validation match.
function expandArcTokens(arc) {
  const base = tokenize(`${arc.title || ''} ${arc.stakes || ''}`);
  const kindSynonyms = ARC_KIND_SYNONYMS[arc.kind] || [];
  return [...new Set([...base, ...kindSynonyms])];
}



// Create a mapping of all tokens to their synonym groups for quick lookup in soft token overlap.
const TOKEN_SYNONYM_GROUPS = new Map();
for (const [kind, synonyms] of Object.entries(ARC_KIND_SYNONYMS)) {
  const group = new Set([kind, ...synonyms]);
  for (const token of group) {
    TOKEN_SYNONYM_GROUPS.set(token, group);
  }
}



// Group events by king
function groupByKing(rows) {
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.king_id)) map.set(row.king_id, []);
    map.get(row.king_id).push(row);
  }
  return map;
}



// Summarize an event by title, description and manual summary
function summarizeEvent(eventRow) {
  const manualSummary = String(eventRow.summary || '').trim();
  const title = String(eventRow.card?.title || '').trim();
  const description = String(eventRow.card?.description || '').trim();
  return [title, description, manualSummary].filter(Boolean).join(' ').trim();
}



// Character name normalization
function normalizeCharacterName(rawName) {
  const tokens = normalizeText(rawName).split(' ').filter(Boolean);
  const nonRole = tokens.filter((t) => !ROLE_WORD_SET.has(t));
  return nonRole[nonRole.length - 1] || null;
}



// Extract character entities 
function extractCharacterEntities(text) {
  const source = String(text || '');
  if (!source) return [];

  const entities = new Set();
  const doc = nlp(source);

  const addNormalizedTokens = (value) => {
    const tokens = normalizeText(value)
      .split(' ')
      .filter((token) => token.length >= 2 && !STOP_WORDS_2.has(token));
    for (const token of tokens) entities.add(token);
  };

  for (const name of doc.people().out('array')) {
    const normalized = normalizeCharacterName(name);
    if (normalized) entities.add(normalized);
  }

  for (const place of doc.places().out('array')) addNormalizedTokens(place);
  for (const org of doc.organizations().out('array')) addNormalizedTokens(org);

  const titledNameRegex = /\b(?:King|Queen|Prince|Princess|Duke|Duchess|Count|Countess|Lord|Lady|Sir|Captain|General|Marshal|Bishop|Abbot|Chancellor|Regent|Commander|Baron|Baroness|Archbishop|Archdeacon|Cardinal|Priest|Monk|Nun|Abbess|Prior|Friar|Steward|Constable|Chamberlain|Seneschal|Herald|Knight|Squire|Guard|Watchman|Merchant|Trader|Guildmaster|Spy|Messenger|Envoy|Scribe|Chronicler|Bailiff|Reeve|Farmer|Servant|Blacksmith|Miller|Baker|Innkeeper|Healer|Physician|Alchemist|Minstrel|Jester|Executioner|Sailor|Admiral)\.?\s+([A-Z][a-zA-Z'\-]+(?:\s+[A-Z][a-zA-Z'\-]+){0,2})\b/g;
  for (const match of source.matchAll(titledNameRegex)) {
    const normalized = normalizeCharacterName(match[1]);
    if (normalized) entities.add(normalized);
  }

  const standaloneRoleRegex = /\b(King|Queen|Prince|Princess|Duke|Duchess|Count|Countess|Lord|Lady|Sir|Captain|General|Marshal|Bishop|Abbot|Chancellor|Regent|Commander|Baron|Baroness|Archbishop|Archdeacon|Cardinal|Priest|Monk|Nun|Abbess|Prior|Friar|Steward|Constable|Chamberlain|Seneschal|Herald|Knight|Squire|Guard|Watchman|Merchant|Trader|Guildmaster|Spy|Messenger|Envoy|Scribe|Chronicler|Bailiff|Reeve|Farmer|Servant|Blacksmith|Miller|Baker|Innkeeper|Healer|Physician|Alchemist|Minstrel|Jester|Executioner|Sailor|Admiral)(?!\.?\s+[A-Z][a-zA-Z])/g;
  for (const match of source.matchAll(standaloneRoleRegex)) {
    entities.add(match[1].toLowerCase());
  }

  return [...entities];
}



// ------------------------------------ //
// -------- Data Load Functions ------- //
// ------------------------------------ //
function loadEvents(db) {
  return db
    .prepare(`
      SELECT id, king_id, turn, card_json, summary, chosen_index, effects_json
      FROM events
      ORDER BY king_id ASC, turn ASC, id ASC
    `)
    .all()
    .map((row) => ({
      ...row,
      card: safeJsonParse(row.card_json, {}),
      effects: safeJsonParse(row.effects_json, {})
    }));
}




function loadArcs(db) {
  return db
    .prepare(`
      SELECT id, king_id, kind, status, title, stakes, created_turn, expires_turn
      FROM arcs
      ORDER BY king_id ASC, id ASC
    `)
    .all();
}




function loadKnowledge(db) {
  return db
    .prepare(`
      SELECT id, king_id, turn, kind, tags_json, text
      FROM knowledge
      ORDER BY king_id ASC, turn ASC
    `)
    .all()
    .map((row) => ({
      ...row,
      tags: safeJsonParse(row.tags_json, [])
    }));
}




function loadWorldStates(db) {
  return db
    .prepare(`
      SELECT king_id, turn, memory_json, constraints_json
      FROM world_state
    `)
    .all()
    .map((row) => ({
      king_id: row.king_id,
      turn: row.turn,
      memory: safeJsonParse(row.memory_json, {}),
      constraints: safeJsonParse(row.constraints_json, {})
    }));
}



// -------------------------------------- //
// -------- Arc Utility Functions ------- //
// -------------------------------------- //
function buildGlobalIDF(events) {
  const eventLength = events.length || 1;
  const df = new Map();
  for (const event of events) {
    for (const token of new Set(tokenize(summarizeEvent(event)))) {
      df.set(token, (df.get(token) || 0) + 1);
    }
  }
  return (token) => Math.log(1 + eventLength / (df.get(token) || 1));
}

function softTokenMatch(aToken, bToken) {
  const synonymGroupA = TOKEN_SYNONYM_GROUPS.get(aToken);
  return (
    aToken === bToken ||
    (aToken.length >= 3 && bToken.length >= 3 &&
      (aToken.startsWith(bToken) || bToken.startsWith(aToken))) ||
    (synonymGroupA && synonymGroupA.has(bToken))
  );
}

function weightedTokenOverlap(aTokens, bTokens, idf) {
  const aSet = [...new Set(aTokens)];
  const bSet = [...new Set(bTokens)];
  if (!aSet.length || !bSet.length) return 0;

  let coveredWeight = 0;
  let totalWeight = 0;

  for (const tokenA of aSet) {
    const weight = (0.5 * idf(tokenA)) + 0.5;
    totalWeight += weight;
    for (const tokenB of bSet) {
      if (softTokenMatch(tokenA, tokenB)) {
        coveredWeight += weight;
        break;
      }
    }
  }

  return totalWeight > 0 ? coveredWeight / totalWeight : 0;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function escalationOverlap(escalationWords, tokens) {
  const set = new Set(tokens);
  let count = 0;
  for (const word of escalationWords) {
    if (set.has(word)) count++;
  }
  return clamp01(count / 4);
}

function eventEffectTension(event) {
  const effects = event.effects && typeof event.effects === 'object' ? event.effects : {};
  const economy = Number(effects.economy) || 0;
  const loyalty = Number(effects.loyalty) || 0;
  const diplomacy = Number(effects.diplomacy) || 0;
  const army = Number(effects.army) || 0;

  const negativePressure =
    Math.max(0, -economy) +
    Math.max(0, -loyalty) +
    Math.max(0, -diplomacy) +
    Math.max(0, -army);

  const volatility =
    Math.abs(economy) +
    Math.abs(loyalty) +
    Math.abs(diplomacy) +
    Math.abs(army);

  return clamp01(Math.sqrt((0.75 * negativePressure + 0.25 * volatility) / 20));
}

function eventTensionScore(event, arcTokens, idf) {
  const eventTokens = tokenize(summarizeEvent(event));
  if (!eventTokens.length) return eventEffectTension(event);

  const lexicalEscalation = escalationOverlap(ARC_ESCALATION_WORDS, eventTokens);
  const arcEscalation = weightedTokenOverlap(arcTokens, eventTokens, idf);
  const effectEscalation = eventEffectTension(event);

  return clamp01(
    (0.6 * effectEscalation) +
    (0.25 * lexicalEscalation) +
    (0.15 * arcEscalation)
  );
}



// -------------------------------------------- //
// -------- Narrative Testing Functions ------- //
// -------------------------------------------- //

// Test measures the system for repeated identical narrative events.
// Each event summary is compared with all others. The ratio of unique summaries is calculated. 
function calculateRepetition(summaries) {
  if (!summaries.length) return 0;
  const uniqueCount = new Set(summaries).size;
  return 1 - uniqueCount / summaries.length;
}



// The test measures the ratio of unique events to the total number.
// This is the reverse value according to the previous test. 
function calculateDiversity(summaries) {
  if (!summaries.length) return 0;
  const uniqueCount = new Set(summaries).size;
  return uniqueCount / summaries.length;
}



// The test measures unequal shared vocabulary across full reign.
// This identifies that each reign has own vocabulary that is used during card generation. 
// Tokens are weighted based on IDF to discount common words such as king, lord, court, reign. 
function calculateKingVocabularyConsistency(eventsByKing) {
  const tokenKingCount = new Map();
  for (const [, rows] of eventsByKing) {
    const kingVocab = new Set();
    for (const row of rows) {
      for (const token of tokenize(summarizeEvent(row))) kingVocab.add(token);
    }
    for (const token of kingVocab) {
      tokenKingCount.set(token, (tokenKingCount.get(token) || 0) + 1);
    }
  }

  const totalKings = eventsByKing.size || 1;
  const idf = (token) => Math.log(1 + totalKings / (tokenKingCount.get(token) || 1));

  const kingScores = [];

  for (const [, rows] of eventsByKing) {
    if (rows.length < 2) continue;

    const eventTokenSets = rows.map((row) => new Set(tokenize(summarizeEvent(row))));

    const tokenEventCount = new Map();
    for (const tokenSet of eventTokenSets) {
      for (const token of tokenSet) {
        tokenEventCount.set(token, (tokenEventCount.get(token) || 0) + 1);
      }
    }

    const sharedTokens = new Set(
      [...tokenEventCount.entries()]
        .filter(([, count]) => count >= 2)
        .map(([token]) => token)
    );

    const eventScores = eventTokenSets.map((tokenSet) => {
      if (!tokenSet.size) return 0;
      let weightedShared = 0;
      let weightedTotal = 0;
      for (const token of tokenSet) {
        const weight = idf(token);
        weightedTotal += weight;
        if (sharedTokens.has(token)) weightedShared += weight;
      }
      return weightedTotal > 0 ? weightedShared / weightedTotal : 0;
    });

    kingScores.push(eventScores.reduce((a, b) => a + b, 0) / eventScores.length);
  }

  if (!kingScores.length) return 0;
  return kingScores.reduce((a, b) => a + b, 0) / kingScores.length;
}



// The test checks events correspond to one theme.
// Arc tokens which includes arc stakes, title, kind tokens expanded with dictionary predefined synonyms.
// This token collection is used to compare event tokens with arc tokens. 
function calculateArcNarrativeAlignment(events, arcs, idf) {
  if (!arcs.length || !events.length) return 0;

  const scores = [];

  for (const arc of arcs) {
    const arcTokens = [...new Set(expandArcTokens(arc))];
    if (!arcTokens.length) continue;

    const expiresAt = arc.expires_turn != null ? arc.expires_turn : Infinity;
    const arcEvents = events.filter(
      (event) =>
        event.king_id === arc.king_id &&
        event.turn >= arc.created_turn &&
        event.turn <= expiresAt
    );

    if (!arcEvents.length) continue;

    const alignmentScores = arcEvents.map((event) => {
      const eventTokens = [...new Set(tokenize(summarizeEvent(event)))];
      if (!eventTokens.length) return 0;

      let coveredWeight = 0;
      let totalWeight = 0;
      for (const arcToken of arcTokens) {
        const weight = idf(arcToken);
        totalWeight += weight;
        const synonymGroup = TOKEN_SYNONYM_GROUPS.get(arcToken);
        for (const evToken of eventTokens) {
          if (
            arcToken === evToken ||
            (arcToken.length >= 3 && evToken.length >= 3 &&
              (arcToken.startsWith(evToken) || evToken.startsWith(arcToken))) ||
            (synonymGroup && synonymGroup.has(evToken))
          ) {
            coveredWeight += weight;
            break;
          }
        }
      }
      const recall = totalWeight > 0 ? coveredWeight / totalWeight : 0;

      let arcMatchedEvTokens = 0;
      for (const evToken of eventTokens) {
        const synonymGroupEv = TOKEN_SYNONYM_GROUPS.get(evToken);
        for (const arcToken of arcTokens) {
          if (
            evToken === arcToken ||
            (evToken.length >= 3 && arcToken.length >= 3 &&
              (evToken.startsWith(arcToken) || arcToken.startsWith(evToken))) ||
            (synonymGroupEv && synonymGroupEv.has(arcToken))
          ) {
            arcMatchedEvTokens++;
            break;
          }
        }
      }
      const precision = Math.min((arcMatchedEvTokens / eventTokens.length) * 4, 1.0);

      return 0.75 * recall + 0.25 * precision;
    });

    const arcAvg = alignmentScores.reduce((a, b) => a + b, 0) / alignmentScores.length;
    scores.push(arcAvg);
  }

  if (!scores.length) return 0;
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}



// The test ensures events inside an arc respond to previous arc events.
// The method uses a sliding window over previous arc events. Window accumulates events up to 5 event limits
function calculateArcNarrativeCausality(events, arcs, idf) {
  const WINDOW = 5;
  if (!arcs.length || !events.length) return 0;

  const arcScores = [];

  for (const arc of arcs) {
    const expiresAt = arc.expires_turn != null ? arc.expires_turn : Infinity;
    const arcEvents = events
      .filter(
        (event) =>
          event.king_id === arc.king_id &&
          event.turn >= arc.created_turn &&
          event.turn <= expiresAt
      )
      .sort((a, b) => (a.turn - b.turn) || (a.id - b.id));

    if (arcEvents.length < 2) continue;

    let score = 0;
    let steps = 0;

    for (let i = 1; i < arcEvents.length; i++) {
      const start = Math.max(0, i - WINDOW);
      const contextTokens = [];
      for (let j = start; j < i; j++) {
        contextTokens.push(...tokenize(summarizeEvent(arcEvents[j])));
      }

      const currentTokens = tokenize(summarizeEvent(arcEvents[i]));
      if (!contextTokens.length || !currentTokens.length) continue;

      score += weightedTokenOverlap(currentTokens, contextTokens, idf);
      steps += 1;
    }

    if (steps > 0) arcScores.push(score / steps);
  }

  if (!arcScores.length) return 0;
  return arcScores.reduce((a, b) => a + b, 0) / arcScores.length;
}



// The arc escalation test measures narrative tension increase across the arc.
// Function analyzes each arc independently and selects events of this arc. 
// Lexical escalation parameter is calculated based on event tokens which are validated for the existence of crisis arc words such as riot, attack, collapse.
// Arc crisis words are collected in predefined vocabulary.
// Arc coherence is calculated based on arc and event tokens by weighted token overlap. 
function calculateArcEscalation(events, arcs, idf) {
  if (!arcs.length || !events.length) return 0;

  const arcScores = [];

  for (const arc of arcs) {
    const expiresAt = arc.expires_turn != null ? arc.expires_turn : Infinity;
    const arcEvents = events
      .filter(
        (event) =>
          event.king_id === arc.king_id &&
          event.turn >= arc.created_turn &&
          event.turn <= expiresAt
      )
      .sort((a, b) => (a.turn - b.turn) || (a.id - b.id));

    if (arcEvents.length < 2) continue;

    const arcTokens = expandArcTokens(arc);
    const tensions = arcEvents.map((event) => eventTensionScore(event, arcTokens, idf));

    let weightedTrend = 0;
    let weightTotal = 0;

    for (let i = 1; i < arcEvents.length; i++) {
      const turnGap = Math.max(1, arcEvents[i].turn - arcEvents[i - 1].turn);
      const deltaPerTurn = (tensions[i] - tensions[i - 1]) / turnGap;

      const stepScore =
        deltaPerTurn >= 0.01 ? 1 :
          deltaPerTurn >= -0.01 ? 0.6 :
            0;

      const weight = 1 / turnGap;
      weightedTrend += stepScore * weight;
      weightTotal += weight;
    }

    const trendScore = weightTotal > 0 ? weightedTrend / weightTotal : 0;
    const buildupScore = clamp01(0.5 + (tensions[tensions.length - 1] - tensions[0]));
    arcScores.push((0.75 * trendScore) + (0.25 * buildupScore));
  }

  if (!arcScores.length) return 0;
  return arcScores.reduce((a, b) => a + b, 0) / arcScores.length;
}



// The test measures the final event card and resolution consistency. The final event and arc are tokenized.
// The thematic consistency between arc and event is evaluated by weighted soft token overlap.
function calculateArcResolutionConsistency(events, arcs, idf) {
  if (!arcs.length || !events.length) return 0;

  const scores = [];

  for (const arc of arcs) {
    if (arc.status !== 'resolved' && arc.status !== 'failed') continue;

    const expiresAt = arc.expires_turn != null ? arc.expires_turn : Infinity;
    const arcEvents = events
      .filter(
        (event) =>
          event.king_id === arc.king_id &&
          event.turn >= arc.created_turn &&
          event.turn <= expiresAt
      )
      .sort((a, b) => (a.turn - b.turn) || (a.id - b.id));

    if (!arcEvents.length) continue;

    const finaleEvent = arcEvents[arcEvents.length - 1];
    const arcTokens = expandArcTokens(arc);
    const finaleTokens = tokenize(summarizeEvent(finaleEvent));

    if (!finaleTokens.length) continue;

    const arcCoverage = weightedTokenOverlap(arcTokens, finaleTokens, idf);
    const resolutionCoverage = escalationOverlap(ARC_RESOLUTION_WORDS, finaleTokens);
    const thematicScore = (0.5 * arcCoverage) + (0.5 * resolutionCoverage * arcCoverage);

    const finaleEffects = finaleEvent.effects && typeof finaleEvent.effects === 'object' ? finaleEvent.effects : {};
    let effectScore;

    if (arc.status === 'resolved') {
      const finaleEconomyUp = finaleEffects.economy > 0 ? 1 : finaleEffects.economy === 0 ? 0.5 : 0;
      const finaleLoyaltyUp = finaleEffects.loyalty > 0 ? 1 : finaleEffects.loyalty === 0 ? 0.5 : 0;
      const finaleArmyUp = finaleEffects.army > 0 ? 1 : finaleEffects.army === 0 ? 0.5 : 0;
      const finaleDiplomacyUp = finaleEffects.diplomacy > 0 ? 1 : finaleEffects.diplomacy === 0 ? 0.5 : 0;
      effectScore = (finaleEconomyUp + finaleLoyaltyUp + finaleArmyUp + finaleDiplomacyUp) / 4;
    } else {
      const finaleEconomyDown = finaleEffects.economy < 0 ? 1 : finaleEffects.economy === 0 ? 0.5 : 0;
      const finaleLoyaltyDown = finaleEffects.loyalty < 0 ? 1 : finaleEffects.loyalty === 0 ? 0.5 : 0;
      const finaleArmyDown = finaleEffects.army < 0 ? 1 : finaleEffects.army === 0 ? 0.5 : 0;
      const finaleDiplomacyDown = finaleEffects.diplomacy < 0 ? 1 : finaleEffects.diplomacy === 0 ? 0.5 : 0;
      effectScore = (finaleEconomyDown + finaleLoyaltyDown + finaleArmyDown + finaleDiplomacyDown) / 4;
    }

    const score = 0.65 * thematicScore + 0.35 * effectScore;
    scores.push(score);
  }

  if (!scores.length) return 0;
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}



// Test measures events reference to the recent narrative context. 
// Each event is compared to the previous 5 turns.
// It includes events and knowledge entries comparison. 
function calculateNarrativeSimilarity(events, knowledge) {
  const WINDOW = 5;

  const knowledgeByKing = new Map();
  for (const entry of knowledge) {
    if (!knowledgeByKing.has(entry.king_id)) knowledgeByKing.set(entry.king_id, []);
    knowledgeByKing.get(entry.king_id).push(entry);
  }

  const eventsByKingMap = new Map();
  for (const event of events) {
    if (!eventsByKingMap.has(event.king_id)) eventsByKingMap.set(event.king_id, []);
    eventsByKingMap.get(event.king_id).push(event);
  }

  const scores = [];
  for (const event of events) {
    const windowMin = event.turn - WINDOW;
    const windowMax = event.turn - 1;

    const recentEvents = (eventsByKingMap.get(event.king_id) || []).filter(
      (other) => other.turn >= windowMin && other.turn <= windowMax
    );
    const recentKnowledge = (knowledgeByKing.get(event.king_id) || []).filter(
      (k) => k.turn >= windowMin && k.turn <= windowMax
    );

    if (!recentEvents.length && !recentKnowledge.length) continue;

    const contextTokens = [];
    for (const prev of recentEvents) {
      contextTokens.push(...tokenize(summarizeEvent(prev)));
    }
    for (const k of recentKnowledge) {
      contextTokens.push(...tokenize(k.text));
    }

    if (!contextTokens.length) continue;

    const eventTokens = tokenize(summarizeEvent(event));
    if (!eventTokens.length) continue;

    scores.push(softTokenOverlap(eventTokens, contextTokens));
  }

  if (!scores.length) return 0;
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}



//The test measures that events share king and reign themes.
// The method identifies tokens that appear in 20%-80% of events.
// These tokens are considered thematic keywords. Each event is evaluated for coverage of themes. 
function calculateGlobalCoherence(eventsByKing) {
  const kingScores = [];

  for (const [, rows] of eventsByKing) {
    if (rows.length < 3) continue;

    const totalEvents = rows.length;
    const tokenEventCount = new Map();

    for (const row of rows) {
      const eventTokens = new Set(tokenize(summarizeEvent(row)));
      for (const token of eventTokens) {
        tokenEventCount.set(token, (tokenEventCount.get(token) || 0) + 1);
      }
    }

    const minCount = Math.max(2, Math.ceil(totalEvents * 0.20));
    const maxCount = Math.ceil(totalEvents * 0.80);

    const thematicTokens = new Set(
      [...tokenEventCount.entries()]
        .filter(([, count]) => count >= minCount && count <= maxCount)
        .map(([token]) => token)
    );

    if (!thematicTokens.size) continue;

    const eventScores = rows.map((row) => {
      const eventTokens = new Set(tokenize(summarizeEvent(row)));
      let hits = 0;
      for (const token of thematicTokens) {
        if (eventTokens.has(token)) hits++;
      }
      return hits / thematicTokens.size;
    });

    kingScores.push(eventScores.reduce((a, b) => a + b, 0) / eventScores.length);
  }

  if (!kingScores.length) return 0;
  return kingScores.reduce((a, b) => a + b, 0) / kingScores.length;
}



// The test checks narrative characters reappear across the reign. 
// The method extracts characters and heroes using NLP and dictionary of roles.
// Entities counted per king with requirements.
// Requirements consist of entities must appear in 2 events or more and must less than 35% percent of king reigns. 
function calculateCharacterConsistency(eventsByKing) {
  const totalKings = eventsByKing.size || 1;

  const eventEntitiesByKing = new Map();
  const kingEntityVocab = new Map();

  for (const [kingId, rows] of eventsByKing) {
    const perEvent = rows.map((row) => new Set(extractCharacterEntities(summarizeEvent(row))));
    eventEntitiesByKing.set(kingId, perEvent);

    const vocab = new Set();
    for (const set of perEvent) {
      for (const entity of set) vocab.add(entity);
    }
    kingEntityVocab.set(kingId, vocab);
  }

  const entityKingCount = new Map();
  for (const [, vocab] of kingEntityVocab) {
    for (const entity of vocab) {
      entityKingCount.set(entity, (entityKingCount.get(entity) || 0) + 1);
    }
  }

  const kingScores = [];

  for (const [kingId, rows] of eventsByKing) {
    if (rows.length < 3) continue;

    const eventEntitySets = eventEntitiesByKing.get(kingId) || [];

    const entityEventCount = new Map();
    for (const entitySet of eventEntitySets) {
      for (const entity of entitySet) {
        entityEventCount.set(entity, (entityEventCount.get(entity) || 0) + 1);
      }
    }

    const recurringEntities = new Set(
      [...entityEventCount.entries()]
        .filter(([entity, count]) =>
          count >= 2 && (entityKingCount.get(entity) || 0) / totalKings <= 0.35
        )
        .map(([entity]) => entity)
    );

    if (!recurringEntities.size) {
      kingScores.push(0);
      continue;
    }

    const eventScores = eventEntitySets.map((entitySet) =>
      [...recurringEntities].some((entity) => entitySet.has(entity)) ? 1 : 0
    );

    kingScores.push(eventScores.reduce((a, b) => a + b, 0) / eventScores.length);
  }

  if (!kingScores.length) return 0;
  return kingScores.reduce((a, b) => a + b, 0) / kingScores.length;
}



// The test ensures that the knowledge and world state base reflect actual events. The test validation includes:
// Knowledge coverage - events should have a knowledge entry recorded within turns. 
// World state coverage - the world's recent themes in world state memory should include tokens and themes from the last event.
function calculateKnowledgeWorldConsistency(events, knowledge, worldStates) {
  const knowledgeTurnsByKing = new Map();
  for (const entry of knowledge) {
    if (!knowledgeTurnsByKing.has(entry.king_id)) knowledgeTurnsByKing.set(entry.king_id, new Set());
    knowledgeTurnsByKing.get(entry.king_id).add(entry.turn);
  }

  let coveredEvents = 0;
  for (const event of events) {
    const turns = knowledgeTurnsByKing.get(event.king_id) || new Set();
    if ([-3, -2, -1, 0, 1, 2, 3].some((offset) => turns.has(event.turn + offset))) coveredEvents++;
  }
  const coverageScore = events.length ? coveredEvents / events.length : 0;

  const eventsByKingMap = new Map();
  for (const event of events) {
    if (!eventsByKingMap.has(event.king_id)) eventsByKingMap.set(event.king_id, []);
    eventsByKingMap.get(event.king_id).push(event);
  }

  const themeScores = [];
  for (const ws of worldStates) {
    const themes = Array.isArray(ws.memory?.recentThemes) ? ws.memory.recentThemes : [];
    if (!themes.length) continue;

    const recentEvents = (eventsByKingMap.get(ws.king_id) || []).slice(-6);
    if (!recentEvents.length) continue;

    const recentTokens = new Set();
    for (const event of recentEvents) {
      for (const token of tokenize(summarizeEvent(event))) recentTokens.add(token);
    }

    const themeTokens = new Set(themes.flatMap((t) => tokenize(String(t || ''))));
    if (!themeTokens.size) continue;

    let hits = 0;
    for (const token of themeTokens) {
      if (recentTokens.has(token)) hits++;
    }
    themeScores.push(hits / themeTokens.size);
  }

  const themeScore = themeScores.length
    ? themeScores.reduce((a, b) => a + b, 0) / themeScores.length
    : 0;

  return (coverageScore + themeScore) / 2;
}



// The narrative entropy test measures the lexical diversity of events.
// The score is based on Shannon entropy, which evaluates the uncertainty of a probability distribution. 
// Entropy is the average amount of information in a message. 
function calculateNarrativeEntropy(eventsByKing) {
  const kingEntropies = [];

  for (const [, rows] of eventsByKing) {
    if (rows.length < 5) continue;

    const tokenFreq = new Map();
    let totalTokens = 0;

    for (const row of rows) {
      for (const token of tokenize(summarizeEvent(row))) {
        tokenFreq.set(token, (tokenFreq.get(token) || 0) + 1);
        totalTokens++;
      }
    }

    if (!totalTokens || tokenFreq.size < 2) continue;

    let entropy = 0;
    for (const count of tokenFreq.values()) {
      const p = count / totalTokens;
      entropy -= p * Math.log2(p);
    }

    kingEntropies.push(entropy / Math.log2(tokenFreq.size));
  }

  if (!kingEntropies.length) return 0;
  return kingEntropies.reduce((a, b) => a + b, 0) / kingEntropies.length;
}



// The local event coherence test measures the density of a theme inside the event block.
// Block contains 5 sequential event validation.
// The method contains a sliding window of 5 events and counts tokens shared between multiple events. 
function calculateEventCoherence(eventsByKing, windowSize = 5) {
  const windowScores = [];

  for (const [, rows] of eventsByKing) {
    if (rows.length < windowSize) continue;

    for (let i = 0; i <= rows.length - windowSize; i++) {
      const windowRows = rows.slice(i, i + windowSize);
      const tokenCount = new Map();

      for (const row of windowRows) {
        for (const token of new Set(tokenize(summarizeEvent(row)))) {
          tokenCount.set(token, (tokenCount.get(token) || 0) + 1);
        }
      }

      const totalUnique = tokenCount.size;
      if (!totalUnique) continue;

      const sharedCount = [...tokenCount.values()].filter((c) => c >= 2).length;
      windowScores.push(sharedCount / totalUnique);
    }
  }

  if (!windowScores.length) return 0;
  return windowScores.reduce((a, b) => a + b, 0) / windowScores.length;
}



// The test calculates the ratio of the resolved arc to the total arcs.
function calculateArcCompletion(arcs) {
  if (!arcs.length) return 0;
  const completed = arcs.filter((arc) => arc.status === 'resolved' || arc.status === 'failed').length;
  return completed / arcs.length;
}



// This test measures the average magnitude of gameplay changes per event. In the other words, metric volatility.
// It collects the event effects from the dataset and calculates an average of the metric absolute values
function calculateMetricVolatility(events) {
  const keys = ['army', 'economy', 'loyalty', 'diplomacy'];
  const changes = [];

  for (const event of events) {
    const effects = event.effects && typeof event.effects === 'object' ? event.effects : {};
    let absChange = 0;
    for (const key of keys) {
      const val = Number(effects[key]);
      absChange += Number.isFinite(val) ? Math.abs(val) : 0;
    }
    changes.push(absChange);
  }

  if (!changes.length) return 0;
  return changes.reduce((acc, n) => acc + n, 0) / changes.length;
}



// ------------------------------------------ //
// ----------- Narrative Testing ------------ //
// ------------------------------------------ //

describe('Narrative Testing', () => {
  test('analyze generated narrative quality based on test database', () => {
    const db = new Database('./test.db', { readonly: true });

    const events = loadEvents(db);
    const arcs = loadArcs(db);
    const knowledge = loadKnowledge(db);
    const worldStates = loadWorldStates(db);
    const eventsByKing = groupByKing(events);

    const summaries = events.map((row) => summarizeEvent(row));
    const uniqueSummaries = new Set(summaries).size;

    const idf = buildGlobalIDF(events);

    const repetitionScore = calculateRepetition(summaries);
    const diversityScore = calculateDiversity(summaries);
    const kingCohesion = calculateKingVocabularyConsistency(eventsByKing);
    const arcAlignment = calculateArcNarrativeAlignment(events, arcs, idf);
    const arcInternalCausality = calculateArcNarrativeCausality(events, arcs, idf);
    const arcEscalation = calculateArcEscalation(events, arcs, idf);
    const arcResolutionConsistency = calculateArcResolutionConsistency(events, arcs, idf);
    const arcCompletionRate = calculateArcCompletion(arcs);
    const metricVolatility = calculateMetricVolatility(events);
    const narrativeRecurrence = calculateNarrativeSimilarity(events, knowledge);
    const globalCoherence = calculateGlobalCoherence(eventsByKing);
    const characterConsistency = calculateCharacterConsistency(eventsByKing);
    const knowledgeWorldConsistency = calculateKnowledgeWorldConsistency(events, knowledge, worldStates);
    const narrativeEntropy = calculateNarrativeEntropy(eventsByKing);
    const localCoherence = calculateEventCoherence(eventsByKing);

    print();
    print('Narrative Analysis Report');
    print();
    print(`Kings analyzed:  ${eventsByKing.size}   |   Total cards: ${events.length}   |   Unique summaries: ${uniqueSummaries}`);
    print();
    print('-- Variety & Repetition --');
    print(`Repetition score:              ${formatScore(repetitionScore)}   (0 = no repeats)`);
    print(`Narrative diversity:           ${formatScore(diversityScore)}   (1 = fully unique)`);
    print(`Narrative entropy:             ${formatScore(narrativeEntropy)}   (0.80–0.95 is healthy)`);
    print();
    print('-- Coherence & Integrity --');
    print(`Narrative Similarity:          ${formatScore(narrativeRecurrence)}   (events grounded in prior knowledge)`);
    print(`Global coherence:              ${formatScore(globalCoherence)}   (events cover king-level themes)`);
    print(`King vocabulary consistency:   ${formatScore(kingCohesion)}   (shared vocabulary across full reign)`);
    print(`Event coherence:               ${formatScore(localCoherence)}   (shared tokens in 5-event windows)`);
    print();
    print('-- Character & World --');
    print(`Character consistency:         ${formatScore(characterConsistency)}   (recurring specific entities per king)`);
    print(`Knowledge/world consistency:   ${formatScore(knowledgeWorldConsistency)}   (facts recorded + themes match events)`);
    print();
    print('-- Arc Structure --');
    print(`Arc narrative alignment:       ${formatScore(arcAlignment)}   (events reference their arc theme)`);
    print(`Arc narrative causality:       ${formatScore(arcInternalCausality)}   (each event reflects recent arc context)`);
    print(`Arc escalation:                ${formatScore(arcEscalation)}   (difficulty/danger rises across arc turns)`);
    print(`Arc resolution consistency:    ${formatScore(arcResolutionConsistency)}   (finale references theme + stabilizes)`);
    print(`Arc completion rate:           ${formatScore(arcCompletionRate)}   (resolved+failed / total)`);
    print();
    print('-- Pacing --');
    print(`Metric volatility:             ${formatScore(metricVolatility, 1)}    (avg abs effect sum per turn)`);

    db.close();

    expect(events.length).toBeGreaterThan(20);
  });
});
