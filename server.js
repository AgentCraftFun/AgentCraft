// ============================================================================
// AGENTCRAFT SERVER - Phase 1: Foundation (Config, Noise, Terrain)
// ============================================================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const TICK_RATE = 20;
const SAVE_INTERVAL = 30000;
const BROADCAST_INTERVAL = 100;
const VOLUME = process.env.RAILWAY_VOLUME_MOUNT_PATH || '.';
const STATE_FILE = path.join(VOLUME, 'gamestate.json');
const WORLD_WIDTH = 200;
const WORLD_HEIGHT = 200;
const TILE_SIZE = 16;

// ---- Seeded Random & Noise ----
function seededRandom(seed) {
  let s = seed;
  return function() {
    s = (s * 16807 + 0) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function hashCell(x, y, seed) {
  let h = seed;
  h = ((h << 5) - h + x) | 0;
  h = ((h << 5) - h + y) | 0;
  h = ((h << 5) - h + x * 31) | 0;
  h = ((h << 5) - h + y * 17) | 0;
  return ((h & 0x7fffffff) % 10000) / 10000;
}

// Simplex-like noise using permutation table
const PERM = new Uint8Array(512);
(function initPerm() {
  const rng = seededRandom(42);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  for (let i = 0; i < 512; i++) PERM[i] = p[i & 255];
})();

function grad2d(hash, x, y) {
  const h = hash & 3;
  return (h & 1 ? x : -x) + (h & 2 ? y : -y);
}

function noise2d(x, y) {
  const X = Math.floor(x) & 255, Y = Math.floor(y) & 255;
  const xf = x - Math.floor(x), yf = y - Math.floor(y);
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = PERM[X] + Y, b = PERM[X + 1] + Y;
  return 0.5 + 0.5 * (
    grad2d(PERM[a], xf, yf) * (1 - u) * (1 - v) +
    grad2d(PERM[b], xf - 1, yf) * u * (1 - v) +
    grad2d(PERM[a + 1], xf, yf - 1) * (1 - u) * v +
    grad2d(PERM[b + 1], xf - 1, yf - 1) * u * v
  );
}

function fbm(x, y, octaves, lacunarity, gain) {
  let sum = 0, amp = 1, freq = 1, max = 0;
  for (let i = 0; i < octaves; i++) {
    sum += noise2d(x * freq, y * freq) * amp;
    max += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / max;
}

// ---- Terrain Generation ----
function getBiome(elevation, moisture) {
  if (elevation < 0.22) return 'deep_water';
  if (elevation < 0.30) return 'shallow_water';
  if (elevation < 0.33) return 'beach';
  if (elevation > 0.85) return 'snow';
  if (elevation > 0.75) return 'mountain';
  if (elevation > 0.65) return 'mountain_base';
  if (moisture < 0.25 && elevation < 0.55) return 'desert';
  if (moisture > 0.7 && elevation < 0.4) return 'swamp';
  if (moisture > 0.6) return 'dense_forest';
  if (moisture > 0.4) return 'forest';
  return 'grass';
}

function generateTerrain() {
  const terrain = [];
  for (let y = 0; y < WORLD_HEIGHT; y++) {
    terrain[y] = [];
    for (let x = 0; x < WORLD_WIDTH; x++) {
      const nx = x / WORLD_WIDTH, ny = y / WORLD_HEIGHT;
      const elevation = fbm(nx * 4 + 0.5, ny * 4 + 0.5, 6, 2.0, 0.5);
      const moisture = fbm(nx * 3 + 10.7, ny * 3 + 10.7, 5, 2.0, 0.5);
      const biome = getBiome(elevation, moisture);
      const h = hashCell(x, y, 42);
      let hasTree = false, treeType = 'oak', hasRock = false;
      if (biome === 'dense_forest') hasTree = h < 0.8;
      else if (biome === 'forest') hasTree = h < 0.6;
      else if (biome === 'grass') hasTree = h < 0.1;
      else if (biome === 'mountain_base') hasTree = h < 0.2;
      else if (biome === 'swamp') hasTree = h < 0.3;
      if (hasTree) {
        const h2 = hashCell(x + 1000, y + 1000, 42);
        treeType = h2 < 0.5 ? 'oak' : h2 < 0.8 ? 'pine' : 'birch';
        if (biome === 'mountain_base') treeType = 'pine';
        if (biome === 'swamp') treeType = 'oak';
      }
      if (biome === 'mountain') hasRock = h < 0.5;
      else if (biome === 'mountain_base') hasRock = hashCell(x + 500, y + 500, 42) < 0.3;
      else if (biome === 'grass') hasRock = hashCell(x + 500, y + 500, 42) < 0.05;
      terrain[y][x] = { type: biome, elevation, moisture, hasTree, treeType, hasRock, stump: false, stumpTimer: 0 };
    }
  }
  return terrain;
}

// ---- Game State ----
let gameState = {
  terrain: [],
  agents: [],
  buildings: [],
  settlements: [],
  animals: [],
  clans: [],
  day: 1,
  timeOfDay: 0.25,
  era: 'wood',
  tickCount: 0,
  recentEvents: [],
  warLog: [],
  spectatorCount: 0,
  activeEvent: null,
  activeEventTimer: 0
};

// ---- Save / Load ----
function saveState() {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const data = {
      agents: gameState.agents,
      buildings: gameState.buildings,
      settlements: gameState.settlements,
      animals: gameState.animals,
      clans: gameState.clans,
      day: gameState.day,
      timeOfDay: gameState.timeOfDay,
      era: gameState.era,
      tickCount: gameState.tickCount,
      recentEvents: gameState.recentEvents,
      warLog: gameState.warLog,
      terrainMods: getTerrainMods()
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(data));
  } catch (e) { console.error('Save error:', e.message); }
}

function getTerrainMods() {
  const mods = [];
  for (let y = 0; y < WORLD_HEIGHT; y++) {
    for (let x = 0; x < WORLD_WIDTH; x++) {
      const cell = gameState.terrain[y][x];
      if (cell.stump || !cell.hasTree && wasOriginallyTree(x, y) || cell.hasRock !== originalHasRock(x, y)) {
        mods.push({ x, y, hasTree: cell.hasTree, hasRock: cell.hasRock, stump: cell.stump, stumpTimer: cell.stumpTimer });
      }
    }
  }
  return mods;
}

function wasOriginallyTree(x, y) {
  const biome = gameState.terrain[y][x].type;
  const h = hashCell(x, y, 42);
  if (biome === 'dense_forest') return h < 0.8;
  if (biome === 'forest') return h < 0.6;
  if (biome === 'grass') return h < 0.1;
  if (biome === 'mountain_base') return h < 0.2;
  if (biome === 'swamp') return h < 0.3;
  return false;
}

function originalHasRock(x, y) {
  const biome = gameState.terrain[y][x].type;
  const h = hashCell(x, y, 42);
  if (biome === 'mountain') return h < 0.5;
  if (biome === 'mountain_base') return hashCell(x + 500, y + 500, 42) < 0.3;
  if (biome === 'grass') return hashCell(x + 500, y + 500, 42) < 0.05;
  return false;
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (data.agents) gameState.agents = data.agents;
      if (data.buildings) gameState.buildings = data.buildings;
      if (data.settlements) gameState.settlements = data.settlements;
      if (data.animals) gameState.animals = data.animals;
      if (data.clans) gameState.clans = data.clans;
      if (data.day) gameState.day = data.day;
      if (data.timeOfDay !== undefined) gameState.timeOfDay = data.timeOfDay;
      if (data.era) gameState.era = data.era;
      if (data.tickCount) gameState.tickCount = data.tickCount;
      if (data.recentEvents) gameState.recentEvents = data.recentEvents;
      if (data.warLog) gameState.warLog = data.warLog;
      if (data.terrainMods) {
        for (const mod of data.terrainMods) {
          if (gameState.terrain[mod.y] && gameState.terrain[mod.y][mod.x]) {
            gameState.terrain[mod.y][mod.x].hasTree = mod.hasTree;
            gameState.terrain[mod.y][mod.x].hasRock = mod.hasRock;
            gameState.terrain[mod.y][mod.x].stump = mod.stump;
            gameState.terrain[mod.y][mod.x].stumpTimer = mod.stumpTimer;
          }
        }
      }
      console.log('Loaded saved state');
      return true;
    }
  } catch (e) { console.error('Load error:', e.message); }
  return false;
}

// ---- Event Logging ----
function addEvent(text) {
  gameState.recentEvents.unshift({ text, tick: gameState.tickCount, time: Date.now() });
  if (gameState.recentEvents.length > 50) gameState.recentEvents.pop();
}

// ============================================================================
// Phase 2: Agents — Spawning, Movement, AI
// ============================================================================

const AGENT_TEMPLATES = [
  { name: 'Aldric', race: 'human', personality: 'analyst' },
  { name: 'Bomrik', race: 'dwarf', personality: 'optimist' },
  { name: 'Faelith', race: 'elf', personality: 'dreamer' },
  { name: 'Grimshaw', race: 'human', personality: 'overachiever' },
  { name: 'Grukk', race: 'orc', personality: 'aggressive' },
  { name: 'Sylara', race: 'elf', personality: 'chaotic' },
  { name: 'Thorin', race: 'dwarf', personality: 'grinder' },
  { name: 'Zog', race: 'orc', personality: 'lazy' }
];

function createAgent(template, x, y) {
  return {
    name: template.name,
    race: template.race,
    personality: template.personality,
    x: x * TILE_SIZE + TILE_SIZE / 2,
    y: y * TILE_SIZE + TILE_SIZE / 2,
    targetX: null, targetY: null,
    currentTask: 'idle',
    taskTimer: 0,
    taskTarget: null,
    facing: 'right',
    inventory: { wood: 0, stone: 0, gold: 0, food: 5 },
    totalGathered: 0,
    energy: 100,
    hunger: 0,
    morale: 80,
    health: 100,
    clan: null,
    relationships: {},
    settlementId: null,
    buildCooldown: 0,
    combatCooldown: 0,
    kills: 0,
    buildingsBuilt: 0,
    isPlayerDeployed: false,
    deployedBy: null,
    knockedOut: false,
    knockedOutTimer: 0,
    animFrame: 0,
    socialTarget: null,
    fleeDirection: null,
    wanderCooldown: 0,
    spawnX: x * TILE_SIZE + TILE_SIZE / 2,
    spawnY: y * TILE_SIZE + TILE_SIZE / 2,
    speedBoostTimer: 0
  };
}

function findValidSpawn(terrain, rng) {
  const validTypes = ['grass', 'forest'];
  for (let attempts = 0; attempts < 500; attempts++) {
    const x = Math.floor(rng() * (WORLD_WIDTH - 40)) + 20;
    const y = Math.floor(rng() * (WORLD_HEIGHT - 40)) + 20;
    if (validTypes.includes(terrain[y][x].type)) return { x, y };
  }
  return { x: 100, y: 100 };
}

function spawnInitialAgents() {
  const rng = seededRandom(123);
  for (const tmpl of AGENT_TEMPLATES) {
    const pos = findValidSpawn(gameState.terrain, rng);
    gameState.agents.push(createAgent(tmpl, pos.x, pos.y));
  }
}

function getSpeedMultiplier(agent) {
  let mult = 1.0;
  if (agent.personality === 'lazy') mult *= 0.7;
  else if (agent.personality === 'grinder') mult *= 1.15;
  else if (agent.personality === 'aggressive') mult *= 1.3;
  if (agent.currentTask === 'explore') mult *= 1.4;
  else if (agent.currentTask === 'flee') mult *= 2.0;
  else if (['chop', 'mine', 'forage', 'build'].includes(agent.currentTask)) mult *= 0.1;
  if (agent.energy < 30) mult *= 0.6;
  if (agent.speedBoostTimer > 0) mult *= 2.0;
  return mult;
}

function moveAgent(agent) {
  if (agent.knockedOut || agent.targetX === null || agent.targetY === null) return;
  const dx = agent.targetX - agent.x;
  const dy = agent.targetY - agent.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < 5) {
    agent.x = agent.targetX;
    agent.y = agent.targetY;
    agent.targetX = null;
    agent.targetY = null;
    return;
  }
  const baseSpeed = 1.2;
  const speed = baseSpeed * getSpeedMultiplier(agent);
  const moveX = (dx / dist) * speed;
  const moveY = (dy / dist) * speed;
  agent.x += moveX;
  agent.y += moveY;
  agent.facing = moveX >= 0 ? 'right' : 'left';
  // Clamp to world bounds
  agent.x = Math.max(TILE_SIZE, Math.min(WORLD_WIDTH * TILE_SIZE - TILE_SIZE, agent.x));
  agent.y = Math.max(TILE_SIZE, Math.min(WORLD_HEIGHT * TILE_SIZE - TILE_SIZE, agent.y));
}

function isWalkable(px, py) {
  const gx = Math.floor(px / TILE_SIZE);
  const gy = Math.floor(py / TILE_SIZE);
  if (gx < 0 || gx >= WORLD_WIDTH || gy < 0 || gy >= WORLD_HEIGHT) return false;
  const t = gameState.terrain[gy][gx].type;
  return !['deep_water', 'shallow_water', 'mountain', 'snow'].includes(t);
}

function findNearestResource(agent, type) {
  const gx = Math.floor(agent.x / TILE_SIZE);
  const gy = Math.floor(agent.y / TILE_SIZE);
  let best = null, bestDist = Infinity;
  const searchRadius = 25;
  for (let dy = -searchRadius; dy <= searchRadius; dy++) {
    for (let dx = -searchRadius; dx <= searchRadius; dx++) {
      const nx = gx + dx, ny = gy + dy;
      if (nx < 0 || nx >= WORLD_WIDTH || ny < 0 || ny >= WORLD_HEIGHT) continue;
      const cell = gameState.terrain[ny][nx];
      if (type === 'tree' && cell.hasTree && !cell.stump) {
        const d = dx * dx + dy * dy;
        if (d < bestDist) { bestDist = d; best = { x: nx, y: ny }; }
      } else if (type === 'rock' && cell.hasRock) {
        const d = dx * dx + dy * dy;
        if (d < bestDist) { bestDist = d; best = { x: nx, y: ny }; }
      } else if (type === 'forage' && (cell.type === 'forest' || cell.type === 'dense_forest' || cell.type === 'grass') && !cell.hasTree && !cell.hasRock) {
        const d = dx * dx + dy * dy;
        if (d < bestDist) { bestDist = d; best = { x: nx, y: ny }; }
      }
    }
  }
  return best;
}

function findNearbyAgent(agent, maxDist) {
  let best = null, bestDist = maxDist * maxDist;
  for (const other of gameState.agents) {
    if (other.name === agent.name || other.knockedOut) continue;
    const dx = other.x - agent.x, dy = other.y - agent.y;
    const d = dx * dx + dy * dy;
    if (d < bestDist) { bestDist = d; best = other; }
  }
  return best;
}

function getGatherBonus(agent) {
  if (agent.personality === 'analyst') return 1.2;
  if (agent.personality === 'grinder') return 1.3;
  if (agent.personality === 'lazy') return 0.7;
  if (agent.personality === 'dreamer') return 0.8;
  return 1.0;
}

function agentAI(agent) {
  if (agent.knockedOut) {
    agent.knockedOutTimer--;
    if (agent.knockedOutTimer <= 0) {
      agent.knockedOut = false;
      agent.health = 50;
      agent.energy = 50;
      // Respawn at settlement or spawn point
      const home = agent.settlementId ? gameState.settlements.find(s => s.id === agent.settlementId) : null;
      if (home) {
        agent.x = home.centerX * TILE_SIZE;
        agent.y = home.centerY * TILE_SIZE;
      } else {
        agent.x = agent.spawnX;
        agent.y = agent.spawnY;
      }
      agent.targetX = null;
      agent.targetY = null;
      agent.currentTask = 'idle';
      addEvent(agent.name + ' recovered!');
    }
    return;
  }

  // Update hunger and energy
  agent.hunger = Math.min(100, agent.hunger + 0.008);
  if (agent.currentTask !== 'rest' && agent.currentTask !== 'idle') {
    agent.energy = Math.max(0, agent.energy - 0.015);
  }
  if (agent.hunger > 60) agent.energy = Math.max(0, agent.energy - 0.01);

  // Morale effects
  if (agent.clan) agent.morale = Math.min(100, agent.morale + 0.002);
  if (agent.hunger > 70) agent.morale = Math.max(0, agent.morale - 0.005);

  // Night behavior
  const isNight = gameState.timeOfDay > 0.8 || gameState.timeOfDay < 0.2;
  if (isNight && agent.personality !== 'grinder' && agent.personality !== 'overachiever') {
    if (agent.currentTask === 'idle' && agent.energy < 80) {
      agent.currentTask = 'rest';
      agent.taskTimer = 120;
      return;
    }
  }

  // Decrement cooldowns
  if (agent.buildCooldown > 0) agent.buildCooldown--;
  if (agent.combatCooldown > 0) agent.combatCooldown--;

  // If still moving to target, wait
  if (agent.targetX !== null && agent.targetY !== null) return;

  // Currently working on a task with timer
  if (agent.taskTimer > 0) {
    agent.taskTimer--;
    agent.animFrame++;
    if (agent.taskTimer <= 0) {
      completeTask(agent);
    }
    return;
  }

  // ---- TASK SELECTION ----

  // 1. SURVIVAL
  if (agent.health < 20) {
    agent.currentTask = 'rest';
    agent.taskTimer = 120;
    agent.energy = Math.min(100, agent.energy + 40);
    return;
  }
  if (agent.hunger > 70) {
    if (agent.inventory.food > 0) {
      agent.inventory.food--;
      agent.hunger = Math.max(0, agent.hunger - 30);
      agent.health = Math.min(100, agent.health + 5);
      return;
    }
    const forage = findNearestResource(agent, 'forage');
    if (forage) {
      agent.currentTask = 'forage';
      agent.taskTarget = forage;
      agent.targetX = forage.x * TILE_SIZE + TILE_SIZE / 2;
      agent.targetY = forage.y * TILE_SIZE + TILE_SIZE / 2;
      agent.taskTimer = 0; // will set when arrived
      return;
    }
  }
  if (agent.energy < 15) {
    agent.currentTask = 'rest';
    agent.taskTimer = 60;
    return;
  }

  // 2. COMBAT (handled in combat system)
  if (shouldFight(agent)) return;

  // 3. GATHERING
  if (agent.inventory.wood < 20) {
    const tree = findNearestResource(agent, 'tree');
    if (tree) {
      agent.currentTask = 'chop';
      agent.taskTarget = tree;
      agent.targetX = tree.x * TILE_SIZE + TILE_SIZE / 2;
      agent.targetY = tree.y * TILE_SIZE + TILE_SIZE / 2;
      return;
    }
  }
  if (agent.inventory.food < 3) {
    const forage = findNearestResource(agent, 'forage');
    if (forage) {
      agent.currentTask = 'forage';
      agent.taskTarget = forage;
      agent.targetX = forage.x * TILE_SIZE + TILE_SIZE / 2;
      agent.targetY = forage.y * TILE_SIZE + TILE_SIZE / 2;
      return;
    }
  }
  if (agent.inventory.stone < 10 && ['stone', 'iron', 'gold'].includes(gameState.era)) {
    const rock = findNearestResource(agent, 'rock');
    if (rock) {
      agent.currentTask = 'mine';
      agent.taskTarget = rock;
      agent.targetX = rock.x * TILE_SIZE + TILE_SIZE / 2;
      agent.targetY = rock.y * TILE_SIZE + TILE_SIZE / 2;
      return;
    }
  }

  // 4. BUILDING
  if (agent.totalGathered > 30 && agent.buildCooldown <= 0) {
    const buildResult = tryStartBuilding(agent);
    if (buildResult) return;
  }

  // 5. SOCIAL
  if (Math.random() < 0.15) {
    const nearby = findNearbyAgent(agent, 200);
    if (nearby) {
      agent.currentTask = 'socialize';
      agent.socialTarget = nearby.name;
      agent.targetX = nearby.x;
      agent.targetY = nearby.y;
      return;
    }
  }

  // 6. EXPLORE
  agent.currentTask = 'explore';
  const homeSettlement = agent.settlementId ? gameState.settlements.find(s => s.id === agent.settlementId) : null;
  const cx = homeSettlement ? homeSettlement.centerX * TILE_SIZE : agent.spawnX;
  const cy = homeSettlement ? homeSettlement.centerY * TILE_SIZE : agent.spawnY;
  const wanderRadius = homeSettlement ? 200 : 300;
  for (let attempts = 0; attempts < 10; attempts++) {
    const tx = cx + (Math.random() - 0.5) * wanderRadius * 2;
    const ty = cy + (Math.random() - 0.5) * wanderRadius * 2;
    if (isWalkable(tx, ty)) {
      agent.targetX = tx;
      agent.targetY = ty;
      return;
    }
  }
  agent.currentTask = 'idle';
}

function completeTask(agent) {
  const bonus = getGatherBonus(agent);
  switch (agent.currentTask) {
    case 'chop':
      if (agent.taskTarget) {
        const t = agent.taskTarget;
        if (gameState.terrain[t.y] && gameState.terrain[t.y][t.x] && gameState.terrain[t.y][t.x].hasTree) {
          gameState.terrain[t.y][t.x].hasTree = false;
          gameState.terrain[t.y][t.x].stump = true;
          gameState.terrain[t.y][t.x].stumpTimer = 6000; // 5 min regrow
          const amount = Math.round(5 * bonus);
          agent.inventory.wood += amount;
          agent.totalGathered += amount;
          addEvent(agent.name + ' chopped a ' + gameState.terrain[t.y][t.x].treeType + ' tree (+' + amount + ' wood)');
        }
      }
      break;
    case 'mine':
      if (agent.taskTarget) {
        const t = agent.taskTarget;
        if (gameState.terrain[t.y] && gameState.terrain[t.y][t.x] && gameState.terrain[t.y][t.x].hasRock) {
          gameState.terrain[t.y][t.x].hasRock = false;
          const isGold = gameState.era === 'gold' && Math.random() < 0.2;
          if (isGold) {
            const amount = Math.round(2 * bonus);
            agent.inventory.gold += amount;
            agent.totalGathered += amount;
            addEvent(agent.name + ' found gold! (+' + amount + ' gold)');
          } else {
            const amount = Math.round(3 * bonus);
            agent.inventory.stone += amount;
            agent.totalGathered += amount;
            addEvent(agent.name + ' mined stone (+' + amount + ' stone)');
          }
        }
      }
      break;
    case 'forage':
      const foodAmount = Math.round(3 * bonus);
      agent.inventory.food += foodAmount;
      agent.totalGathered += foodAmount;
      agent.hunger = Math.max(0, agent.hunger - 20);
      break;
    case 'rest':
      agent.energy = Math.min(100, agent.energy + 40);
      agent.health = Math.min(100, agent.health + 10);
      break;
    case 'build':
      // Building completion is handled by the gameTick progress loop
      break;
    case 'socialize':
      if (agent.socialTarget) {
        const other = gameState.agents.find(a => a.name === agent.socialTarget);
        if (other) {
          const gain = 5 + Math.floor(Math.random() * 11);
          if (!agent.relationships[other.name]) agent.relationships[other.name] = 0;
          if (!other.relationships[agent.name]) other.relationships[agent.name] = 0;
          agent.relationships[other.name] = Math.min(100, agent.relationships[other.name] + gain);
          other.relationships[agent.name] = Math.min(100, other.relationships[agent.name] + gain);
          agent.morale = Math.min(100, agent.morale + 3);
          other.morale = Math.min(100, other.morale + 3);
          checkClanFormation(agent, other);
        }
      }
      break;
  }
  agent.currentTask = 'idle';
  agent.taskTarget = null;
  agent.socialTarget = null;
}

// When agent arrives at target and has no timer set yet, start the work timer
function onAgentArrived(agent) {
  switch (agent.currentTask) {
    case 'chop': agent.taskTimer = 100; break; // 5 sec
    case 'mine': agent.taskTimer = 160; break; // 8 sec
    case 'forage': agent.taskTimer = 60; break; // 3 sec
    case 'socialize': agent.taskTimer = 200; break; // 10 sec
    case 'build':
      // Don't use timer; gameTick handles building progress via bld.progress
      agent.taskTimer = 999999;
      break;
  }
}

// ============================================================================
// Phase 3: Building & Settlements
// ============================================================================

const BUILDING_DEFS = {
  wood: [
    { type: 'Campfire', category: 'civic', cost: { wood: 5 }, time: 100, maxPer: 1 },
    { type: 'Wood Hut', category: 'residential', cost: { wood: 15 }, time: 300, maxPer: 3 },
    { type: 'Log Cabin', category: 'residential', cost: { wood: 25 }, time: 400, maxPer: 2 },
    { type: 'Farm', category: 'agricultural', cost: { wood: 20 }, time: 400, maxPer: 2 },
    { type: 'Lumber Mill', category: 'industrial', cost: { wood: 30 }, time: 500, maxPer: 1 }
  ],
  stone: [
    { type: 'Stone House', category: 'residential', cost: { stone: 15, wood: 5 }, time: 400, maxPer: 3 },
    { type: 'Blacksmith', category: 'industrial', cost: { stone: 20 }, time: 500, maxPer: 1 },
    { type: 'Watchtower', category: 'military', cost: { stone: 25 }, time: 600, maxPer: 2 },
    { type: 'Well', category: 'civic', cost: { stone: 10 }, time: 200, maxPer: 1 },
    { type: 'Quarry', category: 'industrial', cost: { stone: 15, wood: 10 }, time: 500, maxPer: 1 }
  ],
  iron: [
    { type: 'Barracks', category: 'military', cost: { stone: 30, wood: 10 }, time: 600, maxPer: 1 },
    { type: 'Brewery', category: 'industrial', cost: { stone: 20, wood: 15 }, time: 500, maxPer: 1 },
    { type: 'Granary', category: 'agricultural', cost: { stone: 20, wood: 10 }, time: 400, maxPer: 1 },
    { type: 'Stone Wall', category: 'military', cost: { stone: 10 }, time: 200, maxPer: 8 }
  ],
  gold: [
    { type: 'Town Hall', category: 'civic', cost: { stone: 30, gold: 20 }, time: 900, maxPer: 1 },
    { type: 'Church', category: 'civic', cost: { stone: 25, gold: 10 }, time: 800, maxPer: 1 },
    { type: 'Market', category: 'civic', cost: { stone: 20, gold: 15 }, time: 700, maxPer: 1 },
    { type: 'Library', category: 'civic', cost: { stone: 20, gold: 10 }, time: 600, maxPer: 1 }
  ]
};

const ERA_ORDER = ['wood', 'stone', 'iron', 'gold'];
const ZONE_RANGES = {
  civic: { min: 1, max: 3 },
  residential: { min: 4, max: 7 },
  industrial: { min: 5, max: 8 },
  agricultural: { min: 7, max: 10 },
  military: { min: 6, max: 9 },
  decorative: { min: 3, max: 6 }
};

const SETTLEMENT_PREFIXES = ['Oak', 'Iron', 'Stone', 'River', 'Shadow', 'Golden', 'Frost', 'Dawn', 'Storm', 'Silver', 'Ember', 'Moon', 'Copper', 'Maple', 'Cedar'];
const SETTLEMENT_SUFFIXES = ['wood', 'ridge', 'vale', ' Haven', ' Keep', 'ford', 'dale', ' Falls', 'holm', ' Crossing', 'bury', ' Heights', 'ton', 'field', ' Glen'];

function generateSettlementName() {
  const prefix = SETTLEMENT_PREFIXES[Math.floor(Math.random() * SETTLEMENT_PREFIXES.length)];
  const suffix = SETTLEMENT_SUFFIXES[Math.floor(Math.random() * SETTLEMENT_SUFFIXES.length)];
  return prefix + suffix;
}

function getAvailableBuildings() {
  let available = [...BUILDING_DEFS.wood];
  const eraIdx = ERA_ORDER.indexOf(gameState.era);
  if (eraIdx >= 1) available = available.concat(BUILDING_DEFS.stone);
  if (eraIdx >= 2) available = available.concat(BUILDING_DEFS.iron);
  if (eraIdx >= 3) available = available.concat(BUILDING_DEFS.gold);
  return available;
}

function canAfford(agent, cost) {
  for (const [res, amt] of Object.entries(cost)) {
    if ((agent.inventory[res] || 0) < amt) return false;
  }
  return true;
}

function payResources(agent, cost) {
  for (const [res, amt] of Object.entries(cost)) {
    agent.inventory[res] -= amt;
  }
}

function countBuildingTypeInSettlement(type, settlementId) {
  return gameState.buildings.filter(b => b.settlementId === settlementId && b.type === type).length;
}

function findBuildSpot(agent, category, settlementId) {
  const settlement = gameState.settlements.find(s => s.id === settlementId);
  if (!settlement) return null;
  const cx = settlement.centerX, cy = settlement.centerY;
  const zone = ZONE_RANGES[category] || { min: 3, max: 7 };

  for (let radius = zone.min; radius <= zone.max; radius++) {
    for (let angle = 0; angle < 12; angle++) {
      const a = (angle / 12) * Math.PI * 2;
      const tx = Math.round(cx + Math.cos(a) * radius);
      const ty = Math.round(cy + Math.sin(a) * radius);
      if (tx < 1 || tx >= WORLD_WIDTH - 1 || ty < 1 || ty >= WORLD_HEIGHT - 1) continue;
      const cell = gameState.terrain[ty][tx];
      if (['deep_water', 'shallow_water', 'mountain', 'snow'].includes(cell.type)) continue;
      // Check minimum distance from other buildings
      let tooClose = false;
      for (const b of gameState.buildings) {
        const d = Math.abs(b.x - tx) + Math.abs(b.y - ty);
        if (d < 4) { tooClose = true; break; }
      }
      if (tooClose) continue;
      return { x: tx, y: ty };
    }
  }
  return null;
}

function clearTreesAroundBuilding(gx, gy) {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const nx = gx + dx, ny = gy + dy;
      if (nx >= 0 && nx < WORLD_WIDTH && ny >= 0 && ny < WORLD_HEIGHT) {
        gameState.terrain[ny][nx].hasTree = false;
        gameState.terrain[ny][nx].stump = false;
      }
    }
  }
}

function clearTreesAroundSettlement(cx, cy) {
  for (let dy = -6; dy <= 6; dy++) {
    for (let dx = -6; dx <= 6; dx++) {
      if (dx * dx + dy * dy > 36) continue;
      const nx = cx + dx, ny = cy + dy;
      if (nx >= 0 && nx < WORLD_WIDTH && ny >= 0 && ny < WORLD_HEIGHT) {
        gameState.terrain[ny][nx].hasTree = false;
        gameState.terrain[ny][nx].stump = false;
      }
    }
  }
}

function addBuilding(type, category, x, y, builder, settlementId, constructionTime, era) {
  // Check for duplicates
  for (const b of gameState.buildings) {
    if (b.type === type && Math.abs(b.x - x) < 3 && Math.abs(b.y - y) < 3) return null;
  }
  const building = {
    id: 'bld_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
    type, category, x, y,
    builder,
    settlementId,
    complete: false,
    progress: 0,
    constructionTime,
    era
  };
  gameState.buildings.push(building);
  clearTreesAroundBuilding(x, y);
  addEvent(builder + ' started building a ' + type);
  return building;
}

function tryStartBuilding(agent) {
  const available = getAvailableBuildings();
  // Find or create settlement
  let settlementId = agent.settlementId;
  if (!settlementId) {
    // Find nearest settlement or create one
    let nearest = null, nearestDist = Infinity;
    for (const s of gameState.settlements) {
      const dx = s.centerX * TILE_SIZE - agent.x;
      const dy = s.centerY * TILE_SIZE - agent.y;
      const d = dx * dx + dy * dy;
      if (d < nearestDist && d < 500 * 500) { nearestDist = d; nearest = s; }
    }
    if (nearest) {
      settlementId = nearest.id;
      agent.settlementId = settlementId;
    }
  }

  // Shuffle available buildings to add variety
  const shuffled = available.slice().sort(() => Math.random() - 0.5);

  for (const def of shuffled) {
    if (!canAfford(agent, def.cost)) continue;
    if (settlementId) {
      const count = countBuildingTypeInSettlement(def.type, settlementId);
      if (count >= def.maxPer) continue;
    }

    // Find a spot
    let spot = null;
    if (settlementId) {
      spot = findBuildSpot(agent, def.category, settlementId);
    }
    if (!spot) {
      // Start a new settlement near agent
      const gx = Math.floor(agent.x / TILE_SIZE);
      const gy = Math.floor(agent.y / TILE_SIZE);
      // Find a valid spot nearby
      for (let r = 2; r < 10; r++) {
        for (let angle = 0; angle < 8; angle++) {
          const a = (angle / 8) * Math.PI * 2;
          const tx = Math.round(gx + Math.cos(a) * r);
          const ty = Math.round(gy + Math.sin(a) * r);
          if (tx < 1 || tx >= WORLD_WIDTH - 1 || ty < 1 || ty >= WORLD_HEIGHT - 1) continue;
          const cell = gameState.terrain[ty][tx];
          if (['deep_water', 'shallow_water', 'mountain', 'snow', 'desert'].includes(cell.type)) continue;
          spot = { x: tx, y: ty };
          break;
        }
        if (spot) break;
      }
    }
    if (!spot) continue;

    payResources(agent, def.cost);
    const speedMult = agent.personality === 'overachiever' ? 0.7 : 1.0;
    const bld = addBuilding(def.type, def.category, spot.x, spot.y, agent.name, settlementId, Math.round(def.time * speedMult), gameState.era);
    if (bld) {
      agent.currentTask = 'build';
      agent.taskTarget = bld.id;
      agent.targetX = spot.x * TILE_SIZE + TILE_SIZE / 2;
      agent.targetY = spot.y * TILE_SIZE + TILE_SIZE / 2;
      return true;
    }
  }
  return false;
}

function updateSettlements() {
  // Check for new settlement formation: 2+ completed buildings within 8 cells
  const completed = gameState.buildings.filter(b => b.complete);
  const unassigned = completed.filter(b => !b.settlementId);

  for (const b of unassigned) {
    // Find nearby completed buildings
    let nearbySettlement = null;
    for (const s of gameState.settlements) {
      const dx = s.centerX - b.x, dy = s.centerY - b.y;
      if (Math.abs(dx) <= 10 && Math.abs(dy) <= 10) {
        nearbySettlement = s;
        break;
      }
    }
    if (nearbySettlement) {
      b.settlementId = nearbySettlement.id;
      // Recalculate center
      const sBuildings = gameState.buildings.filter(bb => bb.settlementId === nearbySettlement.id);
      nearbySettlement.centerX = Math.round(sBuildings.reduce((s, bb) => s + bb.x, 0) / sBuildings.length);
      nearbySettlement.centerY = Math.round(sBuildings.reduce((s, bb) => s + bb.y, 0) / sBuildings.length);
      nearbySettlement.buildingCount = sBuildings.length;
      updateSettlementPhase(nearbySettlement);
      continue;
    }

    // Check if there's another unassigned building nearby to form a settlement
    for (const b2 of unassigned) {
      if (b2 === b || b2.settlementId) continue;
      const dx = b.x - b2.x, dy = b.y - b2.y;
      if (Math.abs(dx) <= 8 && Math.abs(dy) <= 8) {
        const id = 'stl_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
        const name = generateSettlementName();
        const cx = Math.round((b.x + b2.x) / 2);
        const cy = Math.round((b.y + b2.y) / 2);
        const settlement = {
          id, name,
          centerX: cx, centerY: cy,
          buildingCount: 2,
          phase: 'camp',
          foundedDay: gameState.day
        };
        gameState.settlements.push(settlement);
        b.settlementId = id;
        b2.settlementId = id;
        clearTreesAroundSettlement(cx, cy);
        addEvent('New settlement founded: ' + name + '!');
        // Assign nearby agents
        for (const agent of gameState.agents) {
          if (!agent.settlementId) {
            const adx = agent.x - cx * TILE_SIZE;
            const ady = agent.y - cy * TILE_SIZE;
            if (adx * adx + ady * ady < 500 * 500) {
              agent.settlementId = id;
            }
          }
        }
        break;
      }
    }
  }
}

function updateSettlementPhase(settlement) {
  const count = settlement.buildingCount || 0;
  if (count >= 21) settlement.phase = 'city';
  else if (count >= 13) settlement.phase = 'town';
  else if (count >= 6) settlement.phase = 'village';
  else settlement.phase = 'camp';
}

function updateEra() {
  const totalComplete = gameState.buildings.filter(b => b.complete).length;
  if (totalComplete >= 36) gameState.era = 'gold';
  else if (totalComplete >= 21) gameState.era = 'iron';
  else if (totalComplete >= 9) gameState.era = 'stone';
  else gameState.era = 'wood';
}

// ============================================================================
// Phase 4: Life — Animals, Day/Night, Resource Regen, World Events
// ============================================================================

function spawnAnimals() {
  const rng = seededRandom(777);
  // Deer - groups of 2-4 on grass/forest
  for (let i = 0; i < 6; i++) {
    const pos = findValidSpawn(gameState.terrain, rng);
    const groupSize = 2 + Math.floor(rng() * 3);
    for (let j = 0; j < groupSize; j++) {
      gameState.animals.push({
        type: 'deer', x: pos.x * TILE_SIZE + j * 20, y: pos.y * TILE_SIZE + j * 10,
        targetX: null, targetY: null, fleeing: false, fleeTimer: 0, wanderTimer: 0
      });
    }
  }
  // Rabbits - near forest edges
  for (let i = 0; i < 8; i++) {
    const pos = findValidSpawn(gameState.terrain, rng);
    gameState.animals.push({
      type: 'rabbit', x: pos.x * TILE_SIZE, y: pos.y * TILE_SIZE,
      targetX: null, targetY: null, fleeing: false, fleeTimer: 0, wanderTimer: 0
    });
  }
  // Wolves - dense forest, rare
  for (let i = 0; i < 3; i++) {
    for (let attempts = 0; attempts < 100; attempts++) {
      const x = Math.floor(rng() * WORLD_WIDTH);
      const y = Math.floor(rng() * WORLD_HEIGHT);
      if (gameState.terrain[y][x].type === 'dense_forest') {
        gameState.animals.push({
          type: 'wolf', x: x * TILE_SIZE, y: y * TILE_SIZE,
          targetX: null, targetY: null, fleeing: false, fleeTimer: 0, wanderTimer: 0
        });
        break;
      }
    }
  }
}

function updateAnimals() {
  for (const animal of gameState.animals) {
    // Check for nearby agents (flee)
    if (animal.type !== 'wolf') {
      let threatDist = animal.type === 'rabbit' ? 120 : 180;
      let nearestAgent = null, minD = threatDist * threatDist;
      for (const agent of gameState.agents) {
        if (agent.knockedOut) continue;
        const dx = agent.x - animal.x, dy = agent.y - animal.y;
        const d = dx * dx + dy * dy;
        if (d < minD) { minD = d; nearestAgent = agent; }
      }
      if (nearestAgent && !animal.fleeing) {
        animal.fleeing = true;
        animal.fleeTimer = 60;
        const dx = animal.x - nearestAgent.x, dy = animal.y - nearestAgent.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        animal.targetX = animal.x + (dx / dist) * 200;
        animal.targetY = animal.y + (dy / dist) * 200;
        // Clamp
        animal.targetX = Math.max(TILE_SIZE, Math.min((WORLD_WIDTH - 1) * TILE_SIZE, animal.targetX));
        animal.targetY = Math.max(TILE_SIZE, Math.min((WORLD_HEIGHT - 1) * TILE_SIZE, animal.targetY));
      }
    }

    if (animal.fleeing) {
      animal.fleeTimer--;
      if (animal.fleeTimer <= 0) {
        animal.fleeing = false;
        animal.targetX = null;
        animal.targetY = null;
      }
    }

    // Chickens stay near farms
    if (animal.type === 'chicken') {
      if (!animal.fleeing && animal.wanderTimer <= 0) {
        animal.wanderTimer = 40 + Math.floor(Math.random() * 60);
        if (animal.homeX !== undefined) {
          animal.targetX = animal.homeX + (Math.random() - 0.5) * 3 * TILE_SIZE;
          animal.targetY = animal.homeY + (Math.random() - 0.5) * 3 * TILE_SIZE;
        }
      }
    }

    // Wander
    if (!animal.fleeing && animal.wanderTimer <= 0) {
      animal.wanderTimer = 60 + Math.floor(Math.random() * 120);
      animal.targetX = animal.x + (Math.random() - 0.5) * 150;
      animal.targetY = animal.y + (Math.random() - 0.5) * 150;
      animal.targetX = Math.max(TILE_SIZE, Math.min((WORLD_WIDTH - 1) * TILE_SIZE, animal.targetX));
      animal.targetY = Math.max(TILE_SIZE, Math.min((WORLD_HEIGHT - 1) * TILE_SIZE, animal.targetY));
    }
    if (animal.wanderTimer > 0) animal.wanderTimer--;

    // Move toward target
    if (animal.targetX !== null && animal.targetY !== null) {
      const dx = animal.targetX - animal.x, dy = animal.targetY - animal.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 3) {
        animal.targetX = null;
        animal.targetY = null;
      } else {
        const speed = animal.fleeing ? 1.5 : (animal.type === 'rabbit' ? 0.8 : 0.5);
        animal.x += (dx / dist) * Math.min(speed, 1.5);
        animal.y += (dy / dist) * Math.min(speed, 1.5);
      }
    }

    // NaN protection
    if (isNaN(animal.x) || isNaN(animal.y)) {
      const pos = findValidSpawn(gameState.terrain, Math.random);
      animal.x = pos.x * TILE_SIZE;
      animal.y = pos.y * TILE_SIZE;
    }
  }

  // Spawn chickens near completed farms
  const farms = gameState.buildings.filter(b => b.type === 'Farm' && b.complete);
  for (const farm of farms) {
    const nearbyChickens = gameState.animals.filter(a =>
      a.type === 'chicken' && Math.abs(a.x - farm.x * TILE_SIZE) < 60 && Math.abs(a.y - farm.y * TILE_SIZE) < 60
    );
    if (nearbyChickens.length < 3) {
      gameState.animals.push({
        type: 'chicken',
        x: farm.x * TILE_SIZE + (Math.random() - 0.5) * 40,
        y: farm.y * TILE_SIZE + (Math.random() - 0.5) * 40,
        homeX: farm.x * TILE_SIZE, homeY: farm.y * TILE_SIZE,
        targetX: null, targetY: null, fleeing: false, fleeTimer: 0, wanderTimer: 0
      });
    }
  }
}

// Day/Night cycle: 5 minutes real time = 1 full cycle
function updateDayNight() {
  gameState.timeOfDay += 1 / (TICK_RATE * 300); // 300 seconds = 5 min
  if (gameState.timeOfDay >= 1.0) {
    gameState.timeOfDay -= 1.0;
    gameState.day++;
  }
}

// Resource regeneration
function updateResources() {
  // Only check a subset each tick for performance
  const checkCount = 200;
  for (let i = 0; i < checkCount; i++) {
    const x = Math.floor(Math.random() * WORLD_WIDTH);
    const y = Math.floor(Math.random() * WORLD_HEIGHT);
    const cell = gameState.terrain[y][x];
    if (cell.stump) {
      cell.stumpTimer--;
      if (cell.stumpTimer <= 0) {
        cell.stump = false;
        cell.hasTree = true;
      }
    }
    // Rock respawn (rare)
    if (!cell.hasRock && (cell.type === 'mountain' || cell.type === 'mountain_base')) {
      if (Math.random() < 0.0001) cell.hasRock = true;
    }
  }
}

// World Events
const WORLD_EVENTS = [
  { name: 'Wandering Merchant', duration: 600, effect: 'merchant',
    apply() { addEvent('A wandering merchant has appeared!'); },
    unapply() { addEvent('The merchant has moved on.'); }
  },
  { name: 'Bountiful Harvest', duration: 2400, effect: 'harvest',
    apply() { addEvent('Bountiful Harvest! Farms produce more food.'); },
    unapply() { addEvent('The harvest bounty has ended.'); }
  },
  { name: 'Strong Winds', duration: 1200, effect: 'wind',
    apply() { addEvent('Strong winds blow through the land! Trees chop faster.'); },
    unapply() { addEvent('The winds have calmed.'); }
  },
  { name: 'Gold Rush', duration: 1800, effect: 'goldrush',
    apply() {
      // Spawn gold in mountain area
      for (let i = 0; i < 10; i++) {
        const x = Math.floor(Math.random() * WORLD_WIDTH);
        const y = Math.floor(Math.random() * WORLD_HEIGHT);
        if (gameState.terrain[y][x].type === 'mountain_base' || gameState.terrain[y][x].type === 'mountain') {
          gameState.terrain[y][x].hasRock = true;
        }
      }
      addEvent('Gold Rush! New gold veins discovered in the mountains!');
    },
    unapply() { addEvent('The gold rush has ended.'); }
  },
  { name: 'Thunderstorm', duration: 1200, effect: 'storm',
    apply() { addEvent('A thunderstorm rolls in! Agents seek shelter.'); },
    unapply() { addEvent('The storm has passed.'); }
  },
  { name: 'Territorial Dispute', duration: 100, effect: 'dispute',
    apply() {
      if (gameState.clans.length >= 2) {
        const c1 = gameState.clans[Math.floor(Math.random() * gameState.clans.length)];
        let c2 = gameState.clans[Math.floor(Math.random() * gameState.clans.length)];
        if (c1.id !== c2.id) {
          if (!c1.tensions) c1.tensions = {};
          c1.tensions[c2.id] = (c1.tensions[c2.id] || 0) + 20;
          addEvent('Territorial dispute between ' + c1.name + ' and ' + c2.name + '!');
        }
      } else {
        addEvent('A border dispute erupts between agents!');
      }
    },
    unapply() {}
  },
  { name: 'Meteor Strike', duration: 100, effect: 'meteor',
    apply() {
      const x = 20 + Math.floor(Math.random() * (WORLD_WIDTH - 40));
      const y = 20 + Math.floor(Math.random() * (WORLD_HEIGHT - 40));
      for (let dy = -3; dy <= 3; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
          if (dx * dx + dy * dy > 9) continue;
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && nx < WORLD_WIDTH && ny >= 0 && ny < WORLD_HEIGHT) {
            gameState.terrain[ny][nx].hasTree = false;
            gameState.terrain[ny][nx].stump = false;
            if (Math.random() < 0.3) gameState.terrain[ny][nx].hasRock = true;
          }
        }
      }
      addEvent('A meteor struck the land! Resources scattered in the crater.');
    },
    unapply() {}
  },
  { name: 'Dragon Sighting', duration: 600, effect: 'dragon',
    apply() {
      addEvent('A dragon has been spotted! All flee in terror!');
      for (const animal of gameState.animals) {
        animal.fleeing = true;
        animal.fleeTimer = 120;
        animal.targetX = animal.x + (Math.random() - 0.5) * 400;
        animal.targetY = animal.y + (Math.random() - 0.5) * 400;
      }
    },
    unapply() { addEvent('The dragon has flown away. Peace returns.'); }
  }
];

let worldEventCooldown = 1800 + Math.floor(Math.random() * 1200); // 90-150 sec

function updateWorldEvents() {
  if (gameState.activeEvent) {
    gameState.activeEventTimer--;
    if (gameState.activeEventTimer <= 0) {
      const evt = WORLD_EVENTS.find(e => e.name === gameState.activeEvent);
      if (evt && evt.unapply) evt.unapply();
      gameState.activeEvent = null;
    }
    return;
  }
  worldEventCooldown--;
  if (worldEventCooldown <= 0) {
    worldEventCooldown = 1800 + Math.floor(Math.random() * 1200);
    const evt = WORLD_EVENTS[Math.floor(Math.random() * WORLD_EVENTS.length)];
    gameState.activeEvent = evt.name;
    gameState.activeEventTimer = evt.duration;
    evt.apply();
  }
}

// ============================================================================
// Phase 5: Social & Conflict — Relationships, Clans, Tension, Combat
// ============================================================================

const CLAN_COLORS = ['#cc3333', '#3366cc', '#33cc33', '#cc9933', '#9933cc', '#33cccc', '#cc6633', '#6633cc'];
const CLAN_ANIMALS = ['Wolves', 'Bears', 'Eagles', 'Lions', 'Serpents', 'Hawks', 'Stags', 'Ravens'];
const CLAN_PREFIXES = ['Red', 'Iron', 'Golden', 'Shadow', 'Storm', 'Silver', 'Crimson', 'Black'];

function checkClanFormation(agent1, agent2) {
  if (agent1.clan && agent2.clan) return; // both in clans already
  const rel1 = agent1.relationships[agent2.name] || 0;
  const rel2 = agent2.relationships[agent1.name] || 0;
  if (rel1 < 60 || rel2 < 60) return;

  if (agent1.clan && !agent2.clan) {
    // Add agent2 to agent1's clan
    const clan = gameState.clans.find(c => c.id === agent1.clan);
    if (clan && !clan.members.includes(agent2.name)) {
      clan.members.push(agent2.name);
      agent2.clan = clan.id;
      addEvent(agent2.name + ' joined the ' + clan.name + '!');
    }
    return;
  }
  if (!agent1.clan && agent2.clan) {
    const clan = gameState.clans.find(c => c.id === agent2.clan);
    if (clan && !clan.members.includes(agent1.name)) {
      clan.members.push(agent1.name);
      agent1.clan = clan.id;
      addEvent(agent1.name + ' joined the ' + clan.name + '!');
    }
    return;
  }

  // Both clanless — check if agent1 has 2+ high-relationship agents
  let highRelCount = 0;
  const potentialMembers = [agent1.name, agent2.name];
  for (const [name, val] of Object.entries(agent1.relationships)) {
    if (val >= 60 && name !== agent2.name) {
      const other = gameState.agents.find(a => a.name === name);
      if (other && !other.clan) {
        highRelCount++;
        if (!potentialMembers.includes(name)) potentialMembers.push(name);
      }
    }
  }

  // Form clan with 2+ members
  if (potentialMembers.length >= 2) {
    const idx = gameState.clans.length;
    const id = 'clan_' + Date.now();
    const name = CLAN_PREFIXES[idx % CLAN_PREFIXES.length] + ' ' + CLAN_ANIMALS[idx % CLAN_ANIMALS.length];
    const color = CLAN_COLORS[idx % CLAN_COLORS.length];
    const clan = { id, name, members: potentialMembers, settlementId: agent1.settlementId, tensions: {}, color };
    gameState.clans.push(clan);
    for (const mName of potentialMembers) {
      const a = gameState.agents.find(ag => ag.name === mName);
      if (a) a.clan = id;
    }
    addEvent('The ' + name + ' clan has formed! Members: ' + potentialMembers.join(', '));
  }
}

function updateRelationships() {
  // Passive relationship gain for nearby agents
  for (let i = 0; i < gameState.agents.length; i++) {
    for (let j = i + 1; j < gameState.agents.length; j++) {
      const a = gameState.agents[i], b = gameState.agents[j];
      if (a.knockedOut || b.knockedOut) continue;
      const dx = a.x - b.x, dy = a.y - b.y;
      const dist = dx * dx + dy * dy;
      if (dist < 150 * 150) {
        if (!a.relationships[b.name]) a.relationships[b.name] = 0;
        if (!b.relationships[a.name]) b.relationships[a.name] = 0;
        let rate = 0.005; // ~1 per 200 ticks (~10 sec, roughly 1/min at lower rate)
        if (a.clan && a.clan === b.clan) rate = 0.01;
        if (a.race !== b.race) rate *= 0.8;
        a.relationships[b.name] = Math.min(100, a.relationships[b.name] + rate);
        b.relationships[a.name] = Math.min(100, b.relationships[a.name] + rate);
      }
    }
  }
}

function updateTensions() {
  for (const clan of gameState.clans) {
    if (!clan.tensions) clan.tensions = {};
    for (const otherClan of gameState.clans) {
      if (clan.id === otherClan.id) continue;
      if (!clan.tensions[otherClan.id]) clan.tensions[otherClan.id] = 0;

      // Resource scarcity - check if clans compete for nearby resources
      if (clan.settlementId && otherClan.settlementId) {
        const s1 = gameState.settlements.find(s => s.id === clan.settlementId);
        const s2 = gameState.settlements.find(s => s.id === otherClan.settlementId);
        if (s1 && s2) {
          const dx = (s1.centerX - s2.centerX) * TILE_SIZE;
          const dy = (s1.centerY - s2.centerY) * TILE_SIZE;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < 500) {
            clan.tensions[otherClan.id] += 0.001; // territory overlap
          }
        }
      }

      // Natural cooling
      clan.tensions[otherClan.id] = Math.max(0, clan.tensions[otherClan.id] - 0.0002);
      clan.tensions[otherClan.id] = Math.min(100, clan.tensions[otherClan.id]);
    }
  }
}

function shouldFight(agent) {
  if (agent.combatCooldown > 0) return false;

  // Aggressive personality picks fights
  if (agent.personality === 'aggressive' && agent.clan) {
    const clan = gameState.clans.find(c => c.id === agent.clan);
    if (clan) {
      for (const [otherId, tension] of Object.entries(clan.tensions || {})) {
        if (tension > 50) {
          const otherClan = gameState.clans.find(c => c.id === otherId);
          if (otherClan) {
            // Find enemy agent nearby
            for (const enemy of gameState.agents) {
              if (enemy.knockedOut || enemy.clan !== otherId) continue;
              const dx = enemy.x - agent.x, dy = enemy.y - agent.y;
              if (dx * dx + dy * dy < 200 * 200) {
                startCombat(agent, enemy);
                return true;
              }
            }
          }
        }
      }
    }
  }

  // Check for low-relationship nearby agents when aggressive
  if (agent.personality === 'aggressive') {
    for (const other of gameState.agents) {
      if (other.name === agent.name || other.knockedOut) continue;
      const rel = agent.relationships[other.name] || 0;
      if (rel < -30) {
        const dx = other.x - agent.x, dy = other.y - agent.y;
        if (dx * dx + dy * dy < 100 * 100) {
          startCombat(agent, other);
          return true;
        }
      }
    }
  }
  return false;
}

function startCombat(attacker, defender) {
  attacker.currentTask = 'fight';
  attacker.taskTarget = defender.name;
  attacker.targetX = defender.x;
  attacker.targetY = defender.y;
  attacker.combatCooldown = 40; // 2 sec between rounds

  addEvent(attacker.name + ' attacked ' + defender.name + '!');

  // Deal damage
  let damage = 10 + Math.floor(Math.random() * 11); // 10-20
  if (attacker.personality === 'aggressive') damage = Math.floor(damage * 1.5);
  if (attacker.personality === 'lazy') damage = Math.floor(damage * 0.7);

  // Defense bonuses from buildings
  if (defender.settlementId) {
    const hasWatchtower = gameState.buildings.some(b => b.type === 'Watchtower' && b.complete && b.settlementId === defender.settlementId);
    if (hasWatchtower) damage = Math.floor(damage * 0.9);
  }
  if (attacker.settlementId) {
    const hasBarracks = gameState.buildings.some(b => b.type === 'Barracks' && b.complete && b.settlementId === attacker.settlementId);
    if (hasBarracks) damage = Math.floor(damage * 1.2);
  }

  defender.health -= damage;

  // Update relationships
  if (!attacker.relationships[defender.name]) attacker.relationships[defender.name] = 0;
  if (!defender.relationships[attacker.name]) defender.relationships[attacker.name] = 0;
  attacker.relationships[defender.name] -= 30;
  defender.relationships[attacker.name] -= 30;

  // Update clan tensions
  if (attacker.clan && defender.clan && attacker.clan !== defender.clan) {
    const aClan = gameState.clans.find(c => c.id === attacker.clan);
    if (aClan) {
      if (!aClan.tensions) aClan.tensions = {};
      aClan.tensions[defender.clan] = Math.min(100, (aClan.tensions[defender.clan] || 0) + 15);
    }
  }

  // Check for knockout
  if (defender.health <= 0) {
    defender.health = 0;
    defender.knockedOut = true;
    defender.knockedOutTimer = 6000; // 5 min
    defender.currentTask = 'idle';
    defender.targetX = null;
    defender.targetY = null;
    attacker.kills++;

    // Drop 50% inventory
    const dropX = Math.floor(defender.x / TILE_SIZE);
    const dropY = Math.floor(defender.y / TILE_SIZE);
    for (const res of ['wood', 'stone', 'gold', 'food']) {
      const drop = Math.floor(defender.inventory[res] / 2);
      if (drop > 0) {
        attacker.inventory[res] += drop;
        defender.inventory[res] -= drop;
      }
    }
    addEvent(attacker.name + ' knocked out ' + defender.name + '! Looted resources.');
    gameState.warLog.push({ attacker: attacker.name, defender: defender.name, tick: gameState.tickCount });
  } else if (defender.health < 30) {
    // Flee
    defender.currentTask = 'flee';
    const dx = defender.x - attacker.x, dy = defender.y - attacker.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    defender.targetX = defender.x + (dx / dist) * 300;
    defender.targetY = defender.y + (dy / dist) * 300;
    defender.targetX = Math.max(TILE_SIZE, Math.min((WORLD_WIDTH - 1) * TILE_SIZE, defender.targetX));
    defender.targetY = Math.max(TILE_SIZE, Math.min((WORLD_HEIGHT - 1) * TILE_SIZE, defender.targetY));
    addEvent(defender.name + ' is fleeing from ' + attacker.name + '!');
  }

  attacker.combatCooldown = 40;
  defender.combatCooldown = 40;
}

// ============================================================================
// Phase 6: Spectator Features — Deploy Agent, Influence, Points
// ============================================================================

function handleSpectatorAction(ws, action) {
  if (!ws.spectatorPoints) ws.spectatorPoints = 0;

  switch (action.type) {
    case 'deploy_agent': {
      if (gameState.agents.length >= 24) {
        ws.send(JSON.stringify({ type: 'error', message: 'Max agents reached (24)' }));
        return;
      }
      const name = (action.name || 'Agent_' + Math.floor(Math.random() * 999)).slice(0, 16);
      // Check name uniqueness
      if (gameState.agents.some(a => a.name === name)) {
        ws.send(JSON.stringify({ type: 'error', message: 'Name already taken' }));
        return;
      }
      const personalities = ['analyst', 'optimist', 'dreamer', 'overachiever', 'aggressive', 'chaotic', 'grinder', 'lazy'];
      const races = ['human', 'dwarf', 'elf', 'orc'];
      const personality = personalities.includes(action.personality) ? action.personality : personalities[Math.floor(Math.random() * personalities.length)];
      const race = races.includes(action.race) ? action.race : races[Math.floor(Math.random() * races.length)];
      const pos = findValidSpawn(gameState.terrain, Math.random);
      const agent = createAgent({ name, race, personality }, pos.x, pos.y);
      agent.isPlayerDeployed = true;
      agent.deployedBy = ws.spectatorId || 'anonymous';
      gameState.agents.push(agent);
      addEvent('A new agent has arrived: ' + name + ' the ' + race + ' ' + personality + '!');
      ws.send(JSON.stringify({ type: 'deploy_success', name }));
      break;
    }
    case 'drop_food': {
      if (ws.spectatorPoints < 10) {
        ws.send(JSON.stringify({ type: 'error', message: 'Not enough points (need 10)' }));
        return;
      }
      ws.spectatorPoints -= 10;
      // Find nearest agent to the location and give food
      const tx = action.x || 0, ty = action.y || 0;
      let nearest = null, minD = Infinity;
      for (const agent of gameState.agents) {
        const d = Math.abs(agent.x - tx) + Math.abs(agent.y - ty);
        if (d < minD) { minD = d; nearest = agent; }
      }
      if (nearest) {
        nearest.inventory.food += 5;
        addEvent('A mysterious food package appeared near ' + nearest.name + '!');
      }
      break;
    }
    case 'speed_boost': {
      if (ws.spectatorPoints < 20) {
        ws.send(JSON.stringify({ type: 'error', message: 'Not enough points (need 20)' }));
        return;
      }
      ws.spectatorPoints -= 20;
      const targetAgent = gameState.agents.find(a => a.name === action.target);
      if (targetAgent) {
        targetAgent.speedBoostTimer = 600; // 30 sec
        addEvent(targetAgent.name + ' received a mysterious speed boost!');
      }
      break;
    }
    case 'trigger_rain': {
      if (ws.spectatorPoints < 15) {
        ws.send(JSON.stringify({ type: 'error', message: 'Not enough points (need 15)' }));
        return;
      }
      ws.spectatorPoints -= 15;
      // Boost all farm output for a bit
      gameState.activeEvent = 'Bountiful Harvest';
      gameState.activeEventTimer = 1200;
      addEvent('Rain falls across the land! Crops flourish.');
      break;
    }
    case 'mystery_gift': {
      if (ws.spectatorPoints < 25) {
        ws.send(JSON.stringify({ type: 'error', message: 'Not enough points (need 25)' }));
        return;
      }
      ws.spectatorPoints -= 25;
      // Random positive event
      const gifts = [
        () => { for (const a of gameState.agents) a.morale = Math.min(100, a.morale + 15); addEvent('A wave of joy sweeps the land!'); },
        () => { for (const a of gameState.agents) a.energy = Math.min(100, a.energy + 20); addEvent('A burst of energy fills all agents!'); },
        () => { for (const a of gameState.agents) a.inventory.food += 3; addEvent('Food rains from the sky!'); },
        () => { for (const a of gameState.agents) a.health = Math.min(100, a.health + 15); addEvent('A healing light washes over the land!'); }
      ];
      gifts[Math.floor(Math.random() * gifts.length)]();
      break;
    }
  }
  ws.send(JSON.stringify({ type: 'points_update', points: ws.spectatorPoints }));
}

// ============================================================================
// Phase 7: Performance — Game Loop, Server, Broadcast
// ============================================================================

// ---- Main Game Loop ----
function gameTick() {
  gameState.tickCount++;

  // Day/night
  updateDayNight();

  // Agents
  for (const agent of gameState.agents) {
    if (agent.speedBoostTimer > 0) agent.speedBoostTimer--;
    moveAgent(agent);
    // Check if just arrived at target
    if (agent.targetX === null && agent.taskTimer === 0 && agent.currentTask !== 'idle' && agent.currentTask !== 'explore' && agent.currentTask !== 'rest' && agent.currentTask !== 'flee') {
      onAgentArrived(agent);
    }
    agentAI(agent);
  }

  // Buildings under construction
  for (const bld of gameState.buildings) {
    if (!bld.complete) {
      // Check if builder is nearby and working
      const builder = gameState.agents.find(a => a.taskTarget === bld.id && a.currentTask === 'build');
      if (builder && builder.targetX === null) {
        bld.progress++;
        if (bld.progress >= bld.constructionTime) {
          bld.complete = true;
          builder.buildingsBuilt++;
          builder.buildCooldown = 2400;
          builder.currentTask = 'idle';
          builder.taskTarget = null;
          builder.taskTimer = 0;
          addEvent(builder.name + ' completed a ' + bld.type + '!');
          updateEra();
          updateSettlements();
        }
      }
    }
  }

  // Animals (every 2 ticks for perf)
  if (gameState.tickCount % 2 === 0) updateAnimals();

  // Resources (every 5 ticks)
  if (gameState.tickCount % 5 === 0) updateResources();

  // Relationships (every 20 ticks = 1 sec)
  if (gameState.tickCount % 20 === 0) updateRelationships();

  // Tensions (every 60 ticks = 3 sec)
  if (gameState.tickCount % 60 === 0) updateTensions();

  // Settlements (every 100 ticks = 5 sec)
  if (gameState.tickCount % 100 === 0) updateSettlements();

  // World events
  updateWorldEvents();
}

// ---- HTTP Server ----
const indexHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(indexHtml);
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

// ---- WebSocket ----
const wss = new WebSocketServer({ server });
let spectatorIdCounter = 0;

wss.on('connection', (ws) => {
  ws.spectatorId = 'spectator_' + (++spectatorIdCounter);
  ws.spectatorPoints = 0;
  ws.isAlive = true;
  ws.lastPointsAward = Date.now();

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type) {
        handleSpectatorAction(ws, msg);
      }
    } catch (e) { /* ignore bad messages */ }
  });
});

// Heartbeat
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// ---- Broadcast State ----
function getTerrainModsBroadcast() {
  const mods = [];
  for (let y = 0; y < WORLD_HEIGHT; y++) {
    for (let x = 0; x < WORLD_WIDTH; x++) {
      const cell = gameState.terrain[y][x];
      if (cell.stump || (!cell.hasTree && wasOriginallyTree(x, y))) {
        mods.push({ x, y, hasTree: cell.hasTree, stump: cell.stump });
      }
      if (cell.hasRock !== originalHasRock(x, y)) {
        mods.push({ x, y, hasRock: cell.hasRock });
      }
    }
  }
  return mods;
}

function broadcastState() {
  const spectatorCount = wss.clients.size;
  gameState.spectatorCount = spectatorCount;

  const state = {
    type: 'state',
    agents: gameState.agents.map(a => ({
      name: a.name, race: a.race, personality: a.personality,
      x: a.x, y: a.y, targetX: a.targetX, targetY: a.targetY,
      currentTask: a.currentTask, taskTimer: a.taskTimer, facing: a.facing,
      inventory: a.inventory, energy: a.energy, hunger: a.hunger,
      morale: a.morale, health: a.health, clan: a.clan,
      settlementId: a.settlementId, kills: a.kills,
      buildingsBuilt: a.buildingsBuilt, isPlayerDeployed: a.isPlayerDeployed,
      knockedOut: a.knockedOut, animFrame: a.animFrame,
      totalGathered: a.totalGathered, speedBoostTimer: a.speedBoostTimer || 0
    })),
    buildings: gameState.buildings.map(b => ({
      id: b.id, type: b.type, category: b.category,
      x: b.x, y: b.y, builder: b.builder,
      settlementId: b.settlementId, complete: b.complete,
      progress: b.progress, constructionTime: b.constructionTime, era: b.era
    })),
    settlements: gameState.settlements,
    animals: gameState.animals.map(a => ({
      type: a.type, x: a.x, y: a.y, fleeing: a.fleeing
    })),
    clans: gameState.clans,
    day: gameState.day,
    timeOfDay: gameState.timeOfDay,
    era: gameState.era,
    tickCount: gameState.tickCount,
    recentEvents: gameState.recentEvents.slice(0, 20),
    spectatorCount,
    activeEvent: gameState.activeEvent,
    terrainMods: getTerrainModsBroadcast()
  };

  const msg = JSON.stringify(state);
  wss.clients.forEach(ws => {
    if (ws.readyState === 1) {
      ws.send(msg);
      // Award spectator points
      const now = Date.now();
      if (now - ws.lastPointsAward >= 10000) {
        ws.spectatorPoints = (ws.spectatorPoints || 0) + 1;
        ws.lastPointsAward = now;
        ws.send(JSON.stringify({ type: 'points_update', points: ws.spectatorPoints }));
      }
    }
  });
}

// ---- Initialize & Start ----
console.log('Generating terrain...');
gameState.terrain = generateTerrain();
console.log('Terrain generated.');

const loaded = loadState();
if (!loaded || gameState.agents.length === 0) {
  console.log('Spawning initial agents...');
  spawnInitialAgents();
}
if (!loaded || gameState.animals.length === 0) {
  console.log('Spawning animals...');
  spawnAnimals();
}

// Game loop
setInterval(gameTick, 1000 / TICK_RATE);

// Broadcast
setInterval(broadcastState, BROADCAST_INTERVAL);

// Save
setInterval(saveState, SAVE_INTERVAL);

server.listen(PORT, () => {
  console.log('AgentCraft server running on port ' + PORT);
});
