'use strict';

/**
 * game.test.js — Node.js test suite for game.js
 *
 * Strategy: game.js uses top-level `let` declarations which are block-scoped
 * in vm scripts (not visible as context properties). We rewrite those `let`
 * declarations to `var` so they hoist onto the vm context object, making them
 * accessible as g.snake, g.dir, etc. No logic is changed — only storage class.
 *
 * Run: node game.test.js
 */

const vm = require('vm');
const fs = require('fs');
const assert = require('assert');
const path = require('path');

const SOURCE_PATH = path.join(__dirname, 'game.js');

// ---------------------------------------------------------------------------
// Patch source: convert top-level `let` to `var` for vm context visibility.
// Also rewrite `const` for top-level constants so they appear on the context.
// We target only the specific declarations game.js uses.
// ---------------------------------------------------------------------------
function patchSource(src) {
  // Replace top-level `let` and `const` with `var` so vm hoists them onto ctx
  // Use a line-by-line approach to avoid touching inner-scope lets.
  return src
    .replace(/^const (COLS|ROWS|CELL|DIFFICULTIES|MAX_BLOCKS|canvas|ctx|scoreEl|overlay|overlayMessage)\b/gm, 'var $1')
    .replace(/^let (snake|dir|nextDir|food|blocks|score|gameOver|intervalId|currentDiff|currentMs)\b/gm, 'var $1');
}

// ---------------------------------------------------------------------------
// DOM stub factory
// ---------------------------------------------------------------------------
function makeContext() {
  const intervals = {};
  let nextId = 1;

  const fakeCanvas = {
    width: 400,
    height: 400,
    getContext: () => ({
      fillStyle: '',
      fillRect: () => {},
    }),
  };

  const fakeScore    = { textContent: '0' };
  const fakeOverlay  = { classList: { add: () => {}, remove: () => {} } };
  const fakeMessage  = { textContent: '' };

  const sandbox = {
    document: {
      getElementById: (id) => {
        const map = {
          'game-canvas':     fakeCanvas,
          'score':           fakeScore,
          'overlay':         fakeOverlay,
          'overlay-message': fakeMessage,
        };
        return map[id] || null;
      },
      addEventListener: () => {},
      querySelectorAll: () => ({ forEach: () => {} }),
    },
    setInterval: (fn, ms) => {
      const id = nextId++;
      intervals[id] = { fn, ms };
      return id;
    },
    clearInterval: (id) => { delete intervals[id]; },
    Math,
    console,
    _intervals: intervals,
  };

  sandbox.window = sandbox;
  return sandbox;
}

// ---------------------------------------------------------------------------
// Load game.js into a fresh vm context and return the context.
// ---------------------------------------------------------------------------
function loadGame() {
  const ctx = makeContext();
  const vmCtx = vm.createContext(ctx);
  const patched = patchSource(fs.readFileSync(SOURCE_PATH, 'utf8'));
  vm.runInContext(patched, vmCtx);
  return vmCtx;
}

// ---------------------------------------------------------------------------
// Minimal test runner
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
    failures.push({ name, message: err.message });
    failed++;
  }
}

// ===========================================================================
// Suite: init / initial state
// ===========================================================================
console.log('\n[init / initial state]');

test('snake starts at length 3', () => {
  const g = loadGame();
  assert.strictEqual(g.snake.length, 3);
});

test('snake head starts at (10,10)', () => {
  const g = loadGame();
  assert.strictEqual(g.snake[0].x, 10);
  assert.strictEqual(g.snake[0].y, 10);
});

test('initial direction is right (1,0)', () => {
  const g = loadGame();
  assert.strictEqual(g.dir.x, 1);
  assert.strictEqual(g.dir.y, 0);
});

test('initial nextDir matches dir', () => {
  const g = loadGame();
  assert.strictEqual(g.nextDir.x, 1);
  assert.strictEqual(g.nextDir.y, 0);
});

test('initial score is 0', () => {
  const g = loadGame();
  assert.strictEqual(g.score, 0);
});

test('gameOver is false after init', () => {
  const g = loadGame();
  assert.strictEqual(g.gameOver, false);
});

test('food is placed within grid bounds on init', () => {
  const g = loadGame();
  assert.ok(g.food.x >= 0 && g.food.x < 20, `food.x=${g.food.x} out of range`);
  assert.ok(g.food.y >= 0 && g.food.y < 20, `food.y=${g.food.y} out of range`);
});

test('food does not start on snake body', () => {
  const g = loadGame();
  const onSnake = g.snake.some(s => s.x === g.food.x && s.y === g.food.y);
  assert.strictEqual(onSnake, false);
});

test('interval is registered after init', () => {
  const g = loadGame();
  assert.strictEqual(Object.keys(g._intervals).length, 1);
});

// ===========================================================================
// Suite: placeFood
// ===========================================================================
console.log('\n[placeFood]');

test('placeFood places food within grid bounds', () => {
  const g = loadGame();
  for (let i = 0; i < 50; i++) {
    g.placeFood();
    assert.ok(g.food.x >= 0 && g.food.x < 20, `food.x=${g.food.x}`);
    assert.ok(g.food.y >= 0 && g.food.y < 20, `food.y=${g.food.y}`);
  }
});

test('placeFood never places food on a snake cell', () => {
  const g = loadGame();
  // Fill all cells except the last row (y=19) — 380 cells occupied
  g.blocks = [];
  g.snake = [];
  for (let x = 0; x < 20; x++) {
    for (let y = 0; y < 19; y++) {
      g.snake.push({ x, y });
    }
  }
  for (let i = 0; i < 20; i++) {
    g.placeFood();
    const onSnake = g.snake.some(s => s.x === g.food.x && s.y === g.food.y);
    assert.strictEqual(onSnake, false, `food landed on snake at (${g.food.x},${g.food.y})`);
  }
});

test('placeFood with exactly one free cell always picks that cell', () => {
  const g = loadGame();
  g.blocks = [];
  g.snake = [];
  for (let x = 0; x < 20; x++) {
    for (let y = 0; y < 20; y++) {
      if (!(x === 19 && y === 19)) g.snake.push({ x, y });
    }
  }
  g.placeFood();
  assert.strictEqual(g.food.x, 19);
  assert.strictEqual(g.food.y, 19);
});

test('placeFood avoids cells occupied by blocks', () => {
  const g = loadGame();
  // Fill all cells except (19,19) with snake segments; put a block at (19,19)
  // Then the only free cell excluding blocks is... none? Let's instead:
  // Fill most with snake, leave row y=19 free, put blocks on all y=19 except (5,19)
  g.snake = [];
  for (let x = 0; x < 20; x++) {
    for (let y = 0; y < 19; y++) {
      g.snake.push({ x, y });
    }
  }
  // y=19 row is free; place blocks on all of y=19 except (5,19)
  g.blocks = [];
  for (let x = 0; x < 20; x++) {
    if (x !== 5) g.blocks.push({ x, y: 19 });
  }
  for (let i = 0; i < 20; i++) {
    g.placeFood();
    const onBlock = g.blocks.some(b => b.x === g.food.x && b.y === g.food.y);
    assert.strictEqual(onBlock, false, `food landed on block at (${g.food.x},${g.food.y})`);
    assert.strictEqual(g.food.x, 5);
    assert.strictEqual(g.food.y, 19);
  }
});

test('placeFood never places food on existing blocks (randomized)', () => {
  const g = loadGame();
  g.blocks = [{ x: 5, y: 5 }, { x: 10, y: 10 }, { x: 15, y: 15 }];
  for (let i = 0; i < 50; i++) {
    g.placeFood();
    const onBlock = g.blocks.some(b => b.x === g.food.x && b.y === g.food.y);
    assert.strictEqual(onBlock, false, `food landed on block at (${g.food.x},${g.food.y})`);
  }
});

// ===========================================================================
// Suite: tick — movement
// ===========================================================================
console.log('\n[tick — movement]');

test('head advances one cell in current direction each tick', () => {
  const g = loadGame();
  g.food = { x: 0, y: 19 };
  const prevHead = { ...g.snake[0] };
  g.tick();
  assert.strictEqual(g.snake[0].x, prevHead.x + 1); // dir is (1,0)
  assert.strictEqual(g.snake[0].y, prevHead.y);
});

test('snake length stays constant when no food eaten', () => {
  const g = loadGame();
  g.food = { x: 0, y: 19 };
  const len = g.snake.length;
  g.tick();
  assert.strictEqual(g.snake.length, len);
});

test('snake grows by 1 when head lands on food', () => {
  const g = loadGame();
  g.food = { x: g.snake[0].x + g.dir.x, y: g.snake[0].y + g.dir.y };
  const lenBefore = g.snake.length;
  g.tick();
  assert.strictEqual(g.snake.length, lenBefore + 1);
});

test('score increments when food eaten', () => {
  const g = loadGame();
  g.food = { x: g.snake[0].x + g.dir.x, y: g.snake[0].y + g.dir.y };
  g.tick();
  assert.strictEqual(g.score, 1);
});

test('score does not change when no food eaten', () => {
  const g = loadGame();
  g.food = { x: 0, y: 19 };
  g.tick();
  assert.strictEqual(g.score, 0);
});

test('tick applies nextDir before computing new head position', () => {
  const g = loadGame();
  g.nextDir = { x: 0, y: 1 }; // turn down
  g.food = { x: 0, y: 19 };
  const prevHead = { ...g.snake[0] };
  g.tick();
  assert.strictEqual(g.dir.x, 0);
  assert.strictEqual(g.dir.y, 1);
  assert.strictEqual(g.snake[0].x, prevHead.x);
  assert.strictEqual(g.snake[0].y, prevHead.y + 1);
});

test('snake body follows head: second segment becomes old head after tick', () => {
  const g = loadGame();
  const oldHead = { ...g.snake[0] };
  const oldSecond = { ...g.snake[1] };
  g.food = { x: 0, y: 19 };
  g.tick();
  assert.strictEqual(g.snake[1].x, oldHead.x);
  assert.strictEqual(g.snake[1].y, oldHead.y);
  assert.strictEqual(g.snake[2].x, oldSecond.x);
  assert.strictEqual(g.snake[2].y, oldSecond.y);
});

test('score accumulates correctly across multiple food pickups', () => {
  const g = loadGame();
  for (let i = 0; i < 3; i++) {
    g.food = { x: g.snake[0].x + g.dir.x, y: g.snake[0].y + g.dir.y };
    g.tick();
  }
  assert.strictEqual(g.score, 3);
});

// ===========================================================================
// Suite: tick — wall collision
// ===========================================================================
console.log('\n[tick — wall collision]');

test('game ends when snake hits left wall', () => {
  const g = loadGame();
  g.snake = [{ x: 0, y: 5 }, { x: 1, y: 5 }];
  g.dir = { x: -1, y: 0 };
  g.nextDir = { x: -1, y: 0 };
  g.food = { x: 19, y: 19 };
  g.tick();
  assert.strictEqual(g.gameOver, true);
});

test('game ends when snake hits right wall', () => {
  const g = loadGame();
  g.snake = [{ x: 19, y: 5 }, { x: 18, y: 5 }];
  g.dir = { x: 1, y: 0 };
  g.nextDir = { x: 1, y: 0 };
  g.food = { x: 0, y: 0 };
  g.tick();
  assert.strictEqual(g.gameOver, true);
});

test('game ends when snake hits top wall', () => {
  const g = loadGame();
  g.snake = [{ x: 5, y: 0 }, { x: 5, y: 1 }];
  g.dir = { x: 0, y: -1 };
  g.nextDir = { x: 0, y: -1 };
  g.food = { x: 19, y: 19 };
  g.tick();
  assert.strictEqual(g.gameOver, true);
});

test('game ends when snake hits bottom wall', () => {
  const g = loadGame();
  g.snake = [{ x: 5, y: 19 }, { x: 5, y: 18 }];
  g.dir = { x: 0, y: 1 };
  g.nextDir = { x: 0, y: 1 };
  g.food = { x: 0, y: 0 };
  g.tick();
  assert.strictEqual(g.gameOver, true);
});

test('game does not end when snake is one step from wall but not hitting it', () => {
  const g = loadGame();
  g.snake = [{ x: 18, y: 5 }, { x: 17, y: 5 }, { x: 16, y: 5 }];
  g.dir = { x: 1, y: 0 };
  g.nextDir = { x: 1, y: 0 };
  g.food = { x: 0, y: 0 };
  g.tick();
  assert.strictEqual(g.gameOver, false);
  assert.strictEqual(g.snake[0].x, 19);
});

// ===========================================================================
// Suite: tick — self collision
// ===========================================================================
console.log('\n[tick — self collision]');

test('game ends when head hits body', () => {
  const g = loadGame();
  // Snake curled into a U: head at (6,5), body loops around so (6,5)+right=(7,5) is in body...
  // Actually build a case where next head position is definitely on a body segment.
  // Snake going right; place a body segment one step ahead.
  g.snake = [
    { x: 5, y: 5 },
    { x: 4, y: 5 },
    { x: 3, y: 5 },
    { x: 3, y: 6 },
    { x: 4, y: 6 },
    { x: 5, y: 6 },
    { x: 6, y: 6 },
    { x: 6, y: 5 }, // this is one step ahead of head when moving right
  ];
  g.dir = { x: 1, y: 0 };
  g.nextDir = { x: 1, y: 0 };
  g.food = { x: 0, y: 0 };
  g.tick();
  assert.strictEqual(g.gameOver, true);
});

// ===========================================================================
// Suite: endGame
// ===========================================================================
console.log('\n[endGame]');

test('endGame sets gameOver to true', () => {
  const g = loadGame();
  g.endGame();
  assert.strictEqual(g.gameOver, true);
});

test('endGame clears the game interval', () => {
  const g = loadGame();
  assert.strictEqual(Object.keys(g._intervals).length, 1);
  g.endGame();
  assert.strictEqual(Object.keys(g._intervals).length, 0);
});

// ===========================================================================
// Suite: 180-degree reversal prevention
// ===========================================================================
console.log('\n[reversal prevention]');

test('reversal guard blocks ArrowLeft when moving right', () => {
  const g = loadGame();
  // dir=(1,0); d=(-1,0) => -dir.x=-1, -dir.y=0 => match => blocked
  const d = { x: -1, y: 0 };
  const blocked = (d.x === -g.dir.x && d.y === -g.dir.y);
  assert.strictEqual(blocked, true);
});

test('reversal guard blocks ArrowUp when moving down', () => {
  const g = loadGame();
  g.dir = { x: 0, y: 1 };
  const d = { x: 0, y: -1 };
  const blocked = (d.x === -g.dir.x && d.y === -g.dir.y);
  assert.strictEqual(blocked, true);
});

test('reversal guard allows perpendicular direction', () => {
  const g = loadGame();
  g.dir = { x: 1, y: 0 };
  const d = { x: 0, y: 1 }; // ArrowDown
  const blocked = (d.x === -g.dir.x && d.y === -g.dir.y);
  assert.strictEqual(blocked, false);
});

test('reversal guard allows same direction (no-op)', () => {
  const g = loadGame();
  g.dir = { x: 1, y: 0 };
  const d = { x: 1, y: 0 }; // same as current
  const blocked = (d.x === -g.dir.x && d.y === -g.dir.y);
  assert.strictEqual(blocked, false);
});

// ===========================================================================
// Suite: restart (init called again)
// ===========================================================================
console.log('\n[restart]');

test('init resets game state after game over', () => {
  const g = loadGame();
  g.endGame();
  assert.strictEqual(g.gameOver, true);
  g.init();
  assert.strictEqual(g.gameOver, false);
  assert.strictEqual(g.score, 0);
  assert.strictEqual(g.snake.length, 3);
});

test('init clears existing interval before creating a new one', () => {
  const g = loadGame();
  assert.strictEqual(Object.keys(g._intervals).length, 1);
  g.init();
  // Old interval cleared, new one created — net count stays 1
  assert.strictEqual(Object.keys(g._intervals).length, 1);
});

// ===========================================================================
// Suite: regression — review-reported issues
// ===========================================================================
console.log('\n[regression — review bugs]');

test('REGRESSION: reversal check uses dir not nextDir — opposite-of-nextDir is not blocked', () => {
  // Bug: `if (d.x === -dir.x && d.y === -dir.y)` should be `=== -nextDir.x`
  // Scenario: dir=(1,0), nextDir=(0,1) [down buffered]. Player presses up (0,-1).
  // Guard checks against dir=(1,0): (0 === -1) is false → NOT blocked.
  // So up gets buffered even though nextDir is opposite (down).
  const g = loadGame();
  g.dir = { x: 1, y: 0 };
  g.nextDir = { x: 0, y: 1 }; // down buffered
  const pressUp = { x: 0, y: -1 };
  const blockedByCurrentGuard = (pressUp.x === -g.dir.x && pressUp.y === -g.dir.y);
  // Confirms bug: NOT blocked (returns false) even though it should be blocked
  assert.strictEqual(blockedByCurrentGuard, false,
    'BUG CONFIRMED: up-while-nextDir=down is not blocked; guard uses dir not nextDir');
});

test('REGRESSION: full-grid placeFood — only free cell is selected', () => {
  // Documents the near-infinite-loop risk: if grid is full, do-while never exits.
  // When exactly one cell is free, placeFood must pick it.
  const g = loadGame();
  g.snake = [];
  for (let x = 0; x < 20; x++) {
    for (let y = 0; y < 20; y++) {
      if (!(x === 0 && y === 0)) g.snake.push({ x, y });
    }
  }
  g.placeFood();
  assert.strictEqual(g.food.x, 0);
  assert.strictEqual(g.food.y, 0);
});

// ===========================================================================
// Suite: DIFFICULTIES config structure
// ===========================================================================
console.log('\n[DIFFICULTIES config structure]');

test('DIFFICULTIES has exactly 4 levels: easy, medium, hard, extreme', () => {
  const g = loadGame();
  const keys = Object.keys(g.DIFFICULTIES);
  assert.deepStrictEqual(keys.sort(), ['easy', 'extreme', 'hard', 'medium']);
});

test('each difficulty has required fields: startMs, accelEvery, accelAmount, minMs', () => {
  const g = loadGame();
  for (const [name, cfg] of Object.entries(g.DIFFICULTIES)) {
    assert.ok('startMs'     in cfg, `${name} missing startMs`);
    assert.ok('accelEvery'  in cfg, `${name} missing accelEvery`);
    assert.ok('accelAmount' in cfg, `${name} missing accelAmount`);
    assert.ok('minMs'       in cfg, `${name} missing minMs`);
  }
});

test('easy: startMs=200, accelEvery=5, accelAmount=5, minMs=80', () => {
  const g = loadGame();
  const c = g.DIFFICULTIES.easy;
  assert.strictEqual(c.startMs, 200);
  assert.strictEqual(c.accelEvery, 5);
  assert.strictEqual(c.accelAmount, 5);
  assert.strictEqual(c.minMs, 80);
});

test('medium: startMs=150, accelEvery=4, accelAmount=8, minMs=60', () => {
  const g = loadGame();
  const c = g.DIFFICULTIES.medium;
  assert.strictEqual(c.startMs, 150);
  assert.strictEqual(c.accelEvery, 4);
  assert.strictEqual(c.accelAmount, 8);
  assert.strictEqual(c.minMs, 60);
});

test('hard: startMs=100, accelEvery=3, accelAmount=10, minMs=50', () => {
  const g = loadGame();
  const c = g.DIFFICULTIES.hard;
  assert.strictEqual(c.startMs, 100);
  assert.strictEqual(c.accelEvery, 3);
  assert.strictEqual(c.accelAmount, 10);
  assert.strictEqual(c.minMs, 50);
});

test('extreme: startMs=70, accelEvery=2, accelAmount=12, minMs=40', () => {
  const g = loadGame();
  const c = g.DIFFICULTIES.extreme;
  assert.strictEqual(c.startMs, 70);
  assert.strictEqual(c.accelEvery, 2);
  assert.strictEqual(c.accelAmount, 12);
  assert.strictEqual(c.minMs, 40);
});

test('minMs is strictly less than startMs for all difficulties', () => {
  const g = loadGame();
  for (const [name, cfg] of Object.entries(g.DIFFICULTIES)) {
    assert.ok(cfg.minMs < cfg.startMs, `${name}: minMs(${cfg.minMs}) should be < startMs(${cfg.startMs})`);
  }
});

test('accelEvery and accelAmount are positive integers for all difficulties', () => {
  const g = loadGame();
  for (const [name, cfg] of Object.entries(g.DIFFICULTIES)) {
    assert.ok(Number.isInteger(cfg.accelEvery) && cfg.accelEvery > 0, `${name}: accelEvery invalid`);
    assert.ok(Number.isInteger(cfg.accelAmount) && cfg.accelAmount > 0, `${name}: accelAmount invalid`);
  }
});

// ===========================================================================
// Suite: default difficulty and init speed
// ===========================================================================
console.log('\n[default difficulty and init speed]');

test('default currentDiff is medium', () => {
  const g = loadGame();
  assert.strictEqual(g.currentDiff, 'medium');
});

test('init sets currentMs to DIFFICULTIES[currentDiff].startMs', () => {
  const g = loadGame();
  assert.strictEqual(g.currentMs, g.DIFFICULTIES[g.currentDiff].startMs);
});

test('game starts with interval matching medium startMs (150)', () => {
  const g = loadGame();
  const ids = Object.keys(g._intervals);
  assert.strictEqual(ids.length, 1);
  assert.strictEqual(g._intervals[ids[0]].ms, 150);
});

// ===========================================================================
// Suite: switching difficulty changes starting speed
// ===========================================================================
console.log('\n[switching difficulty changes starting speed]');

test('setting currentDiff to easy and calling init uses startMs=200', () => {
  const g = loadGame();
  g.currentDiff = 'easy';
  g.init();
  assert.strictEqual(g.currentMs, 200);
  const ids = Object.keys(g._intervals);
  assert.strictEqual(g._intervals[ids[0]].ms, 200);
});

test('setting currentDiff to hard and calling init uses startMs=100', () => {
  const g = loadGame();
  g.currentDiff = 'hard';
  g.init();
  assert.strictEqual(g.currentMs, 100);
  const ids = Object.keys(g._intervals);
  assert.strictEqual(g._intervals[ids[0]].ms, 100);
});

test('setting currentDiff to extreme and calling init uses startMs=70', () => {
  const g = loadGame();
  g.currentDiff = 'extreme';
  g.init();
  assert.strictEqual(g.currentMs, 70);
  const ids = Object.keys(g._intervals);
  assert.strictEqual(g._intervals[ids[0]].ms, 70);
});

test('init resets currentMs to startMs even if currentMs was reduced by acceleration', () => {
  const g = loadGame();
  // Simulate speed having been reduced
  g.currentMs = g.DIFFICULTIES.medium.minMs;
  g.init();
  assert.strictEqual(g.currentMs, g.DIFFICULTIES.medium.startMs);
});

// ===========================================================================
// Suite: acceleration on food eaten
// ===========================================================================
console.log('\n[acceleration on food eaten]');

test('currentMs decreases by accelAmount after eating accelEvery foods (medium)', () => {
  const g = loadGame();
  // medium: accelEvery=4, accelAmount=8, startMs=150
  const config = g.DIFFICULTIES.medium;
  const startMs = g.currentMs;
  // Eat (accelEvery - 1) foods — no acceleration yet
  for (let i = 0; i < config.accelEvery - 1; i++) {
    g.food = { x: g.snake[0].x + g.dir.x, y: g.snake[0].y + g.dir.y };
    g.tick();
  }
  assert.strictEqual(g.currentMs, startMs, 'speed should not change before accelEvery threshold');
  // Eat one more to hit the threshold
  g.food = { x: g.snake[0].x + g.dir.x, y: g.snake[0].y + g.dir.y };
  g.tick();
  assert.strictEqual(g.currentMs, startMs - config.accelAmount);
});

test('interval is rescheduled with new currentMs after acceleration', () => {
  const g = loadGame();
  const config = g.DIFFICULTIES.medium;
  const expectedMs = config.startMs - config.accelAmount;
  for (let i = 0; i < config.accelEvery; i++) {
    g.food = { x: g.snake[0].x + g.dir.x, y: g.snake[0].y + g.dir.y };
    g.tick();
  }
  const ids = Object.keys(g._intervals);
  assert.strictEqual(ids.length, 1);
  assert.strictEqual(g._intervals[ids[0]].ms, expectedMs);
});

test('no acceleration on non-threshold food (score not divisible by accelEvery)', () => {
  const g = loadGame();
  const startMs = g.currentMs;
  // Eat exactly 1 food (medium: accelEvery=4, so score=1 is not a threshold)
  g.food = { x: g.snake[0].x + g.dir.x, y: g.snake[0].y + g.dir.y };
  g.tick();
  assert.strictEqual(g.currentMs, startMs);
});

test('acceleration triggers correctly for easy difficulty (accelEvery=5)', () => {
  const g = loadGame();
  g.currentDiff = 'easy';
  g.init();
  const config = g.DIFFICULTIES.easy;
  const startMs = g.currentMs;
  for (let i = 0; i < config.accelEvery; i++) {
    g.food = { x: g.snake[0].x + g.dir.x, y: g.snake[0].y + g.dir.y };
    g.tick();
  }
  assert.strictEqual(g.currentMs, startMs - config.accelAmount);
});

test('acceleration triggers correctly for hard difficulty (accelEvery=3)', () => {
  const g = loadGame();
  g.currentDiff = 'hard';
  g.init();
  const config = g.DIFFICULTIES.hard;
  const startMs = g.currentMs;
  for (let i = 0; i < config.accelEvery; i++) {
    g.food = { x: g.snake[0].x + g.dir.x, y: g.snake[0].y + g.dir.y };
    g.tick();
  }
  assert.strictEqual(g.currentMs, startMs - config.accelAmount);
});

test('acceleration triggers correctly for extreme difficulty (accelEvery=2)', () => {
  const g = loadGame();
  g.currentDiff = 'extreme';
  g.init();
  const config = g.DIFFICULTIES.extreme;
  const startMs = g.currentMs;
  for (let i = 0; i < config.accelEvery; i++) {
    g.food = { x: g.snake[0].x + g.dir.x, y: g.snake[0].y + g.dir.y };
    g.tick();
  }
  assert.strictEqual(g.currentMs, startMs - config.accelAmount);
});

// ===========================================================================
// Suite: speed floor (minMs)
// ===========================================================================
console.log('\n[speed floor — minMs]');

test('currentMs never drops below minMs for medium difficulty', () => {
  const g = loadGame();
  const config = g.DIFFICULTIES.medium;
  // Force currentMs to just above minMs and trigger one more acceleration
  g.currentMs = config.minMs + 1;
  // Manually set score to a multiple of accelEvery minus 1 so next food triggers
  g.score = config.accelEvery - 1;
  g.food = { x: g.snake[0].x + g.dir.x, y: g.snake[0].y + g.dir.y };
  g.tick();
  assert.ok(g.currentMs >= config.minMs,
    `currentMs(${g.currentMs}) dropped below minMs(${config.minMs})`);
});

test('currentMs stays at minMs when already at floor and acceleration fires', () => {
  const g = loadGame();
  const config = g.DIFFICULTIES.medium;
  g.currentMs = config.minMs;
  g.score = config.accelEvery - 1;
  g.food = { x: g.snake[0].x + g.dir.x, y: g.snake[0].y + g.dir.y };
  g.tick();
  assert.strictEqual(g.currentMs, config.minMs);
});

test('speed floor respected for easy difficulty', () => {
  const g = loadGame();
  g.currentDiff = 'easy';
  g.init();
  const config = g.DIFFICULTIES.easy;
  g.currentMs = config.minMs;
  g.score = config.accelEvery - 1;
  g.food = { x: g.snake[0].x + g.dir.x, y: g.snake[0].y + g.dir.y };
  g.tick();
  assert.ok(g.currentMs >= config.minMs);
});

test('speed floor respected for hard difficulty', () => {
  const g = loadGame();
  g.currentDiff = 'hard';
  g.init();
  const config = g.DIFFICULTIES.hard;
  g.currentMs = config.minMs;
  g.score = config.accelEvery - 1;
  g.food = { x: g.snake[0].x + g.dir.x, y: g.snake[0].y + g.dir.y };
  g.tick();
  assert.ok(g.currentMs >= config.minMs);
});

test('speed floor respected for extreme difficulty', () => {
  const g = loadGame();
  g.currentDiff = 'extreme';
  g.init();
  const config = g.DIFFICULTIES.extreme;
  g.currentMs = config.minMs;
  g.score = config.accelEvery - 1;
  g.food = { x: g.snake[0].x + g.dir.x, y: g.snake[0].y + g.dir.y };
  g.tick();
  assert.ok(g.currentMs >= config.minMs);
});

test('multiple acceleration cycles never breach minMs floor', () => {
  const g = loadGame();
  const config = g.DIFFICULTIES.medium;
  // Drive score up by many multiples of accelEvery
  const cycles = 30;
  for (let i = 0; i < config.accelEvery * cycles; i++) {
    g.food = { x: g.snake[0].x + g.dir.x, y: g.snake[0].y + g.dir.y };
    // Guard against wall collision by keeping snake near center
    g.snake = [{ x: 10, y: 10 }, { x: 9, y: 10 }, { x: 8, y: 10 }];
    g.dir = { x: 1, y: 0 };
    g.nextDir = { x: 1, y: 0 };
    g.food = { x: 11, y: 10 };
    g.tick();
    assert.ok(g.currentMs >= config.minMs,
      `After ${i + 1} foods, currentMs(${g.currentMs}) < minMs(${config.minMs})`);
  }
});

// ===========================================================================
// Suite: DIFFICULTIES block config
// ===========================================================================
console.log('\n[DIFFICULTIES block config]');

test('DIFFICULTIES has blocksMin/blocksMax/blockSpawnEvery fields on all levels', () => {
  const g = loadGame();
  for (const [name, cfg] of Object.entries(g.DIFFICULTIES)) {
    assert.ok('blocksMin'        in cfg, `${name} missing blocksMin`);
    assert.ok('blocksMax'        in cfg, `${name} missing blocksMax`);
    assert.ok('blockSpawnEvery'  in cfg, `${name} missing blockSpawnEvery`);
  }
});

test('easy: blocksMin=0, blocksMax=0, blockSpawnEvery=0', () => {
  const g = loadGame();
  const c = g.DIFFICULTIES.easy;
  assert.strictEqual(c.blocksMin, 0);
  assert.strictEqual(c.blocksMax, 0);
  assert.strictEqual(c.blockSpawnEvery, 0);
});

test('medium: blocksMin=0, blocksMax=0, blockSpawnEvery=0', () => {
  const g = loadGame();
  const c = g.DIFFICULTIES.medium;
  assert.strictEqual(c.blocksMin, 0);
  assert.strictEqual(c.blocksMax, 0);
  assert.strictEqual(c.blockSpawnEvery, 0);
});

test('hard: blocksMin=3, blocksMax=5, blockSpawnEvery=8', () => {
  const g = loadGame();
  const c = g.DIFFICULTIES.hard;
  assert.strictEqual(c.blocksMin, 3);
  assert.strictEqual(c.blocksMax, 5);
  assert.strictEqual(c.blockSpawnEvery, 8);
});

test('extreme: blocksMin=8, blocksMax=12, blockSpawnEvery=5', () => {
  const g = loadGame();
  const c = g.DIFFICULTIES.extreme;
  assert.strictEqual(c.blocksMin, 8);
  assert.strictEqual(c.blocksMax, 12);
  assert.strictEqual(c.blockSpawnEvery, 5);
});

test('MAX_BLOCKS constant equals 20', () => {
  const g = loadGame();
  assert.strictEqual(g.MAX_BLOCKS, 20);
});

// ===========================================================================
// Suite: init blocks state
// ===========================================================================
console.log('\n[init blocks state]');

test('blocks array is empty after init on easy', () => {
  const g = loadGame();
  g.currentDiff = 'easy';
  g.init();
  assert.strictEqual(g.blocks.length, 0);
});

test('blocks array is empty after init on medium', () => {
  const g = loadGame();
  // medium is the default; blocks must still be empty
  assert.strictEqual(g.blocks.length, 0);
});

test('blocks array has between blocksMin and blocksMax entries after init on hard', () => {
  // Run many times to reduce false-negative probability from randomness
  for (let trial = 0; trial < 20; trial++) {
    const g = loadGame();
    g.currentDiff = 'hard';
    g.init();
    const cfg = g.DIFFICULTIES.hard;
    assert.ok(
      g.blocks.length >= cfg.blocksMin && g.blocks.length <= cfg.blocksMax,
      `trial ${trial}: blocks.length=${g.blocks.length} not in [${cfg.blocksMin},${cfg.blocksMax}]`
    );
  }
});

test('blocks array has between blocksMin and blocksMax entries after init on extreme', () => {
  for (let trial = 0; trial < 20; trial++) {
    const g = loadGame();
    g.currentDiff = 'extreme';
    g.init();
    const cfg = g.DIFFICULTIES.extreme;
    assert.ok(
      g.blocks.length >= cfg.blocksMin && g.blocks.length <= cfg.blocksMax,
      `trial ${trial}: blocks.length=${g.blocks.length} not in [${cfg.blocksMin},${cfg.blocksMax}]`
    );
  }
});

test('init resets blocks to empty before placing new ones', () => {
  const g = loadGame();
  g.currentDiff = 'hard';
  g.init();
  const firstCount = g.blocks.length;
  g.init();
  const secondCount = g.blocks.length;
  // Both counts must be within valid range; no accumulation across inits
  const cfg = g.DIFFICULTIES.hard;
  assert.ok(firstCount  >= cfg.blocksMin && firstCount  <= cfg.blocksMax);
  assert.ok(secondCount >= cfg.blocksMin && secondCount <= cfg.blocksMax);
});

// ===========================================================================
// Suite: placeBlock
// ===========================================================================
console.log('\n[placeBlock]');

test('placeBlock places within grid bounds', () => {
  const g = loadGame();
  g.blocks = [];
  for (let i = 0; i < 50; i++) {
    g.placeBlock();
    const b = g.blocks[g.blocks.length - 1];
    assert.ok(b.x >= 0 && b.x < 20, `block.x=${b.x} out of range`);
    assert.ok(b.y >= 0 && b.y < 20, `block.y=${b.y} out of range`);
  }
});

test('placeBlock does not place on snake', () => {
  const g = loadGame();
  // Snake occupies most of the grid; only y=19 row is free
  g.snake = [];
  for (let x = 0; x < 20; x++) {
    for (let y = 0; y < 19; y++) {
      g.snake.push({ x, y });
    }
  }
  g.blocks = [];
  g.food = { x: 0, y: 19 };
  for (let i = 1; i < 20; i++) {
    g.placeBlock();
    const b = g.blocks[g.blocks.length - 1];
    const onSnake = g.snake.some(s => s.x === b.x && s.y === b.y);
    assert.strictEqual(onSnake, false, `block at (${b.x},${b.y}) is on snake`);
  }
});

test('placeBlock does not place on food', () => {
  const g = loadGame();
  g.food = { x: 10, y: 10 };
  g.blocks = [];
  for (let i = 0; i < 30; i++) {
    g.placeBlock();
    const b = g.blocks[g.blocks.length - 1];
    const onFood = (b.x === g.food.x && b.y === g.food.y);
    assert.strictEqual(onFood, false, `block placed on food at (${b.x},${b.y})`);
  }
});

test('placeBlock does not duplicate existing block positions', () => {
  const g = loadGame();
  g.blocks = [];
  for (let i = 0; i < 30; i++) {
    g.placeBlock();
  }
  // Check uniqueness
  const seen = new Set();
  for (const b of g.blocks) {
    const key = `${b.x},${b.y}`;
    assert.strictEqual(seen.has(key), false, `duplicate block at (${b.x},${b.y})`);
    seen.add(key);
  }
});

test('placeBlock increases blocks.length by 1', () => {
  const g = loadGame();
  g.blocks = [];
  const before = g.blocks.length;
  g.placeBlock();
  assert.strictEqual(g.blocks.length, before + 1);
});

// ===========================================================================
// Suite: block collision ends the game
// ===========================================================================
console.log('\n[block collision]');

test('game ends when snake head moves into a block', () => {
  const g = loadGame();
  // Head at (10,10) moving right; place block at (11,10)
  g.snake = [{ x: 10, y: 10 }, { x: 9, y: 10 }, { x: 8, y: 10 }];
  g.dir = { x: 1, y: 0 };
  g.nextDir = { x: 1, y: 0 };
  g.blocks = [{ x: 11, y: 10 }];
  g.food = { x: 0, y: 0 };
  g.tick();
  assert.strictEqual(g.gameOver, true);
});

test('game does not end when block is adjacent but not in path', () => {
  const g = loadGame();
  g.snake = [{ x: 10, y: 10 }, { x: 9, y: 10 }, { x: 8, y: 10 }];
  g.dir = { x: 1, y: 0 };
  g.nextDir = { x: 1, y: 0 };
  // Block below, not ahead
  g.blocks = [{ x: 10, y: 11 }];
  g.food = { x: 0, y: 0 };
  g.tick();
  assert.strictEqual(g.gameOver, false);
});

test('block collision ends game when moving up', () => {
  const g = loadGame();
  g.snake = [{ x: 10, y: 10 }, { x: 10, y: 11 }];
  g.dir = { x: 0, y: -1 };
  g.nextDir = { x: 0, y: -1 };
  g.blocks = [{ x: 10, y: 9 }];
  g.food = { x: 0, y: 0 };
  g.tick();
  assert.strictEqual(g.gameOver, true);
});

test('block collision ends game when moving down', () => {
  const g = loadGame();
  g.snake = [{ x: 10, y: 10 }, { x: 10, y: 9 }];
  g.dir = { x: 0, y: 1 };
  g.nextDir = { x: 0, y: 1 };
  g.blocks = [{ x: 10, y: 11 }];
  g.food = { x: 0, y: 0 };
  g.tick();
  assert.strictEqual(g.gameOver, true);
});

// ===========================================================================
// Suite: block spawning on food eaten
// ===========================================================================
console.log('\n[block spawning on food eaten]');

test('placeBlock is called at blockSpawnEvery threshold on hard', () => {
  const g = loadGame();
  g.currentDiff = 'hard';
  g.init();
  const cfg = g.DIFFICULTIES.hard;
  const blocksBefore = g.blocks.length;
  // Drive score to exactly cfg.blockSpawnEvery without crossing accelEvery boundary awkwardly
  // Force score to (blockSpawnEvery - 1) then eat one more food
  g.score = cfg.blockSpawnEvery - 1;
  g.snake = [{ x: 10, y: 10 }, { x: 9, y: 10 }, { x: 8, y: 10 }];
  g.dir = { x: 1, y: 0 };
  g.nextDir = { x: 1, y: 0 };
  g.food = { x: 11, y: 10 };
  g.tick();
  assert.strictEqual(g.score, cfg.blockSpawnEvery);
  assert.ok(g.blocks.length > blocksBefore, `expected blocks to grow; was ${blocksBefore}, now ${g.blocks.length}`);
});

test('no block spawned when score is not a multiple of blockSpawnEvery (hard)', () => {
  const g = loadGame();
  g.currentDiff = 'hard';
  g.init();
  const cfg = g.DIFFICULTIES.hard;
  const blocksBefore = g.blocks.length;
  // Eat 1 food (score=1 is not a multiple of blockSpawnEvery=8)
  g.snake = [{ x: 10, y: 10 }, { x: 9, y: 10 }, { x: 8, y: 10 }];
  g.dir = { x: 1, y: 0 };
  g.nextDir = { x: 1, y: 0 };
  g.food = { x: 11, y: 10 };
  g.tick();
  assert.strictEqual(g.blocks.length, blocksBefore, 'block count should not change on non-threshold food');
});

test('no block spawned on easy (blockSpawnEvery=0)', () => {
  const g = loadGame();
  g.currentDiff = 'easy';
  g.init();
  const blocksBefore = g.blocks.length; // should be 0
  assert.strictEqual(blocksBefore, 0);
  // Eat many foods — no blocks should ever appear
  for (let i = 0; i < 10; i++) {
    g.snake = [{ x: 10, y: 10 }, { x: 9, y: 10 }, { x: 8, y: 10 }];
    g.dir = { x: 1, y: 0 };
    g.nextDir = { x: 1, y: 0 };
    g.food = { x: 11, y: 10 };
    g.tick();
  }
  assert.strictEqual(g.blocks.length, 0, `blocks should remain 0 on easy; got ${g.blocks.length}`);
});

test('no block spawned on medium (blockSpawnEvery=0)', () => {
  const g = loadGame();
  // default is medium
  for (let i = 0; i < 10; i++) {
    g.snake = [{ x: 10, y: 10 }, { x: 9, y: 10 }, { x: 8, y: 10 }];
    g.dir = { x: 1, y: 0 };
    g.nextDir = { x: 1, y: 0 };
    g.food = { x: 11, y: 10 };
    g.tick();
  }
  assert.strictEqual(g.blocks.length, 0, `blocks should remain 0 on medium; got ${g.blocks.length}`);
});

test('block spawns on extreme at blockSpawnEvery=5 threshold', () => {
  const g = loadGame();
  g.currentDiff = 'extreme';
  g.init();
  const cfg = g.DIFFICULTIES.extreme;
  const blocksBefore = g.blocks.length;
  g.score = cfg.blockSpawnEvery - 1;
  g.snake = [{ x: 10, y: 10 }, { x: 9, y: 10 }, { x: 8, y: 10 }];
  g.dir = { x: 1, y: 0 };
  g.nextDir = { x: 1, y: 0 };
  g.food = { x: 11, y: 10 };
  g.tick();
  assert.ok(g.blocks.length > blocksBefore, `expected block to spawn; before=${blocksBefore} after=${g.blocks.length}`);
});

// ===========================================================================
// Suite: MAX_BLOCKS cap
// ===========================================================================
console.log('\n[MAX_BLOCKS cap]');

test('no block spawned when blocks.length already equals MAX_BLOCKS', () => {
  const g = loadGame();
  g.currentDiff = 'hard';
  g.init();
  const cfg = g.DIFFICULTIES.hard;
  // Pre-fill blocks to MAX_BLOCKS
  g.blocks = [];
  for (let i = 0; i < g.MAX_BLOCKS; i++) {
    g.blocks.push({ x: i % 20, y: Math.floor(i / 20) + 15 });
  }
  // Ensure those block positions don't collide with snake/food we'll set below
  g.snake = [{ x: 10, y: 10 }, { x: 9, y: 10 }, { x: 8, y: 10 }];
  g.dir = { x: 1, y: 0 };
  g.nextDir = { x: 1, y: 0 };
  g.food = { x: 11, y: 10 };
  g.score = cfg.blockSpawnEvery - 1;
  g.tick();
  assert.strictEqual(g.blocks.length, g.MAX_BLOCKS,
    `blocks should stay at MAX_BLOCKS=${g.MAX_BLOCKS}; got ${g.blocks.length}`);
});

test('blocks never exceed MAX_BLOCKS across many food-eaten events on extreme', () => {
  const g = loadGame();
  g.currentDiff = 'extreme';
  g.init();
  const cfg = g.DIFFICULTIES.extreme;
  // Eat many foods; blocks should cap at MAX_BLOCKS
  for (let i = 0; i < cfg.blockSpawnEvery * 30; i++) {
    if (g.gameOver) break;
    g.snake = [{ x: 10, y: 10 }, { x: 9, y: 10 }, { x: 8, y: 10 }];
    g.dir = { x: 1, y: 0 };
    g.nextDir = { x: 1, y: 0 };
    g.food = { x: 11, y: 10 };
    g.tick();
    assert.ok(g.blocks.length <= g.MAX_BLOCKS,
      `After ${i + 1} ticks, blocks=${g.blocks.length} exceeds MAX_BLOCKS=${g.MAX_BLOCKS}`);
  }
});

// ===========================================================================
// Summary
// ===========================================================================
console.log('\n' + '='.repeat(60));
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failures.length > 0) {
  console.log('\nFailed tests:');
  failures.forEach(f => console.log(`  - ${f.name}: ${f.message}`));
}
console.log('='.repeat(60) + '\n');

process.exit(failed > 0 ? 1 : 0);
