const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');
const scoreEl = document.getElementById('score');
const overlay = document.getElementById('overlay');
const overlayMessage = document.getElementById('overlay-message');

const COLS = 20;
const ROWS = 20;
const CELL = canvas.width / COLS;
const MAX_BLOCKS = 20;

const DIFFICULTIES = {
  easy:    { startMs: 200, accelEvery: 5, accelAmount: 5,  minMs: 80,  blocksMin: 0, blocksMax: 0,  blockSpawnEvery: 0 },
  medium:  { startMs: 150, accelEvery: 4, accelAmount: 8,  minMs: 60,  blocksMin: 0, blocksMax: 0,  blockSpawnEvery: 0 },
  hard:    { startMs: 100, accelEvery: 3, accelAmount: 10, minMs: 50,  blocksMin: 3, blocksMax: 5,  blockSpawnEvery: 8 },
  extreme: { startMs: 70,  accelEvery: 2, accelAmount: 12, minMs: 40,  blocksMin: 8, blocksMax: 12, blockSpawnEvery: 5 },
};

let currentDiff = 'medium';
let currentMs;

let snake, dir, nextDir, food, blocks, score, gameOver, intervalId;

function init() {
  snake = [{ x: 10, y: 10 }, { x: 9, y: 10 }, { x: 8, y: 10 }];
  dir = { x: 1, y: 0 };
  nextDir = { x: 1, y: 0 };
  blocks = [];
  score = 0;
  gameOver = false;
  scoreEl.textContent = score;
  overlay.classList.add('hidden');
  placeFood();
  const config = DIFFICULTIES[currentDiff];
  const blockCount = config.blocksMin + Math.floor(Math.random() * (config.blocksMax - config.blocksMin + 1));
  for (let i = 0; i < blockCount; i++) placeBlock();
  currentMs = config.startMs;
  if (intervalId) clearInterval(intervalId);
  intervalId = setInterval(tick, currentMs);
}

function placeBlock() {
  let cell;
  do {
    cell = { x: Math.floor(Math.random() * COLS), y: Math.floor(Math.random() * ROWS) };
  } while (
    snake.some(s => s.x === cell.x && s.y === cell.y) ||
    (food && food.x === cell.x && food.y === cell.y) ||
    blocks.some(b => b.x === cell.x && b.y === cell.y)
  );
  blocks.push(cell);
}

function placeFood() {
  let cell;
  do {
    cell = { x: Math.floor(Math.random() * COLS), y: Math.floor(Math.random() * ROWS) };
  } while (
    snake.some(s => s.x === cell.x && s.y === cell.y) ||
    blocks.some(b => b.x === cell.x && b.y === cell.y)
  );
  food = cell;
}

function tick() {
  dir = nextDir;
  const head = { x: snake[0].x + dir.x, y: snake[0].y + dir.y };

  if (head.x < 0 || head.x >= COLS || head.y < 0 || head.y >= ROWS) {
    endGame();
    return;
  }
  if (snake.some(s => s.x === head.x && s.y === head.y)) {
    endGame();
    return;
  }
  if (blocks.some(b => b.x === head.x && b.y === head.y)) {
    endGame();
    return;
  }

  snake.unshift(head);

  if (head.x === food.x && head.y === food.y) {
    score++;
    scoreEl.textContent = score;
    const config = DIFFICULTIES[currentDiff];
    if (score % config.accelEvery === 0) {
      currentMs = Math.max(currentMs - config.accelAmount, config.minMs);
      clearInterval(intervalId);
      intervalId = setInterval(tick, currentMs);
    }
    if (config.blockSpawnEvery > 0 && score % config.blockSpawnEvery === 0 && blocks.length < MAX_BLOCKS) {
      placeBlock();
    }
    placeFood();
  } else {
    snake.pop();
  }

  draw();
}

function draw() {
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = '#4caf50';
  snake.forEach((s, i) => {
    ctx.fillStyle = i === 0 ? '#81c784' : '#4caf50';
    ctx.fillRect(s.x * CELL + 1, s.y * CELL + 1, CELL - 2, CELL - 2);
  });

  ctx.fillStyle = '#ff9800';
  blocks.forEach(b => {
    ctx.fillRect(b.x * CELL + 1, b.y * CELL + 1, CELL - 2, CELL - 2);
  });

  ctx.fillStyle = '#f44336';
  ctx.fillRect(food.x * CELL + 1, food.y * CELL + 1, CELL - 2, CELL - 2);
}

function endGame() {
  gameOver = true;
  clearInterval(intervalId);
  overlayMessage.textContent = 'Game Over — Score: ' + score;
  overlay.classList.remove('hidden');
}

document.addEventListener('keydown', e => {
  const map = {
    ArrowUp:    { x: 0,  y: -1 },
    ArrowDown:  { x: 0,  y:  1 },
    ArrowLeft:  { x: -1, y:  0 },
    ArrowRight: { x: 1,  y:  0 },
  };
  const d = map[e.key];
  if (!d) return;
  e.preventDefault();

  if (gameOver) {
    init();
    return;
  }

  if (d.x === -dir.x && d.y === -dir.y) return;
  nextDir = d;
});

document.querySelectorAll('.diff-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.diff-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentDiff = btn.dataset.diff;
    init();
  });
});

init();
