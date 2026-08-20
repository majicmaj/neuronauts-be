const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const Game = require("../game");

const EMBEDDINGS = {
  star: [1, 0, 0],
  moon: [0, 1, 0],
  bridge: [0.5, Math.sqrt(0.75), 0],
  beacon: [0.75, Math.sqrt(0.4375), 0],
  planet: [-1, 0, 0],
};

const PLAYER = { id: "player-1", name: "Nova Navigator" };

async function createReadyGame(options = {}) {
  const game = new Game({
    embeddings: EMBEDDINGS,
    targetWord: "star",
    commonWords: Object.keys(EMBEDDINGS),
    ...options,
  });
  await once(game, "ready");
  return game;
}

test("records attributed guesses with stable vector-space positions", async () => {
  const game = await createReadyGame();
  const response = game.handleGuess("Moon", PLAYER);

  assert.equal(response.ok, true);
  assert.equal(response.result.guess, "moon");
  assert.equal(response.result.playerId, PLAYER.id);
  assert.equal(response.result.playerName, PLAYER.name);
  assert.equal(response.result.correct, false);
  assert.equal(typeof response.result.position.x, "number");
  assert.equal(typeof response.result.position.y, "number");
  assert.ok(response.result.position.x >= 0.06 && response.result.position.x <= 0.94);
  assert.ok(response.result.position.y >= 0.06 && response.result.position.y <= 0.94);
});

test("returns the closest unused word to the score midpoint and enforces a shared cooldown", async () => {
  let now = Date.parse("2026-08-20T00:00:00Z");
  const game = await createReadyGame({ now: () => now, hintCooldownMs: 60_000 });

  const tooSoon = game.requestHint(PLAYER);
  assert.equal(tooSoon.ok, false);
  assert.equal(tooSoon.code, "hint_needs_guess");

  assert.equal(game.handleGuess("moon", PLAYER).ok, true);
  const hint = game.requestHint(PLAYER);
  assert.equal(hint.ok, true);
  assert.equal(hint.result.guess, "bridge");
  assert.ok(Math.abs(hint.result.similarity - 0.5) < 1e-10);
  assert.equal(hint.result.isHint, true);
  assert.equal(hint.result.hintFrom, "moon");
  assert.equal(
    hint.hintAvailableAt,
    new Date(now + 60_000).toISOString()
  );

  const cooldown = game.requestHint(PLAYER);
  assert.equal(cooldown.ok, false);
  assert.equal(cooldown.code, "hint_cooldown");

  now += 60_000;
  const nextHint = game.requestHint(PLAYER);
  assert.equal(nextHint.ok, true);
  assert.equal(nextHint.result.guess, "beacon");
  assert.ok(Math.abs(nextHint.result.similarity - 0.75) < 1e-10);
});

test("targets the arithmetic midpoint between the displayed best score and 100%", async () => {
  const cases = [0, 0.2, 0.9];

  for (const bestSimilarity of cases) {
    const desiredSimilarity = (bestSimilarity + 1) / 2;
    const embeddings = {
      target: [1, 0, 0],
      guess: [bestSimilarity, Math.sqrt(1 - bestSimilarity ** 2), 0],
      hint: [desiredSimilarity, Math.sqrt(1 - desiredSimilarity ** 2), 0],
    };
    const game = new Game({
      embeddings,
      targetWord: "target",
      commonWords: Object.keys(embeddings),
    });
    await once(game, "ready");

    assert.equal(game.handleGuess("guess", PLAYER).ok, true);
    const hint = game.requestHint(PLAYER);

    assert.equal(hint.ok, true);
    assert.equal(hint.result.guess, "hint");
    assert.ok(
      Math.abs(hint.result.similarity - desiredSimilarity) < 1e-10,
      `${bestSimilarity} should produce ${desiredSimilarity}`
    );
  }
});

test("prefers the requested score midpoint over a word beside the current best", async () => {
  const bestSimilarity = 0.412;
  const desiredSimilarity = (bestSimilarity + 1) / 2;
  const embeddings = {
    target: [1, 0, 0],
    guess: [bestSimilarity, Math.sqrt(1 - bestSimilarity ** 2), 0],
    think: [0.493, Math.sqrt(1 - 0.493 ** 2), 0],
    halfway: [
      desiredSimilarity,
      0,
      Math.sqrt(1 - desiredSimilarity ** 2),
    ],
  };
  const game = new Game({
    embeddings,
    targetWord: "target",
    commonWords: Object.keys(embeddings),
  });
  await once(game, "ready");

  game.handleGuess("guess", PLAYER);
  const hint = game.requestHint(PLAYER);

  assert.equal(hint.ok, true);
  assert.equal(hint.result.guess, "halfway");
  assert.ok(Math.abs(hint.result.similarity - 0.706) < 1e-10);
});

test("reveals and persists the target only after a player wins", async () => {
  const game = await createReadyGame();
  assert.equal(game.getGameState().targetWord, undefined);

  const win = game.handleGuess("star", PLAYER);
  assert.equal(win.ok, true);
  assert.equal(win.result.correct, true);
  assert.equal(win.result.targetWord, "star");

  const state = game.getGameState();
  assert.equal(state.status, "won");
  assert.equal(state.targetWord, "star");
  assert.deepEqual(state.winner, {
    playerId: PLAYER.id,
    playerName: PLAYER.name,
  });
  assert.ok(state.solvedAt);
  assert.equal(game.handleGuess("moon", PLAYER).code, "game_won");
});

test("rejects invalid, unknown, and duplicate guesses without growing history", async () => {
  const game = await createReadyGame();
  assert.equal(game.handleGuess("two words", PLAYER).code, "invalid_guess");
  assert.equal(game.handleGuess("unknown", PLAYER).code, "unknown_word");
  assert.equal(game.handleGuess("moon", PLAYER).ok, true);
  assert.equal(game.handleGuess("MOON", PLAYER).code, "duplicate_guess");
  assert.equal(game.getGameState().guessHistory.length, 1);
});
