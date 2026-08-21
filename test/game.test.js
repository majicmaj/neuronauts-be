const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const Game = require("../game");

const EMBEDDINGS = {
  star: [1, 0, 0],
  moon: [0, 1, 0],
  bridge: [0.6, 0.8, 0],
  beacon: [0.8, 0.6, 0],
  comet: [0.4, Math.sqrt(0.84), 0],
  planet: [-1, 0, 0],
  ohio: [0.7, Math.sqrt(0.51), 0],
};
const REFERENCE_WORDS = ["star", "beacon", "bridge", "comet", "moon", "planet"];

const PLAYER = {
  id: "player-1",
  name: "Nova Navigator",
  colorIndex: 3,
  avatarId: "cosmic-crown",
};

async function createReadyGame(options = {}) {
  const game = new Game({
    embeddings: EMBEDDINGS,
    targetWord: "star",
    commonWords: REFERENCE_WORDS,
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
  assert.equal(response.result.colorIndex, PLAYER.colorIndex);
  assert.equal(response.result.avatarId, PLAYER.avatarId);
  assert.equal(response.result.cosineSimilarity, 0);
  assert.equal(response.result.rank, 5);
  assert.equal(response.result.rankedWordCount, 6);
  assert.ok(Math.abs(response.result.similarity - 0.2) < 1e-10);
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
  assert.ok(Math.abs(hint.result.similarity - 0.6) < 1e-10);
  assert.equal(hint.result.rank, 3);
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
  assert.ok(Math.abs(nextHint.result.similarity - 0.8) < 1e-10);
});

test("ranks valid guesses outside the reference vocabulary on the same linear scale", async () => {
  const game = await createReadyGame();
  const response = game.handleGuess("ohio", PLAYER);

  assert.equal(response.ok, true);
  assert.equal(response.result.rank, 3);
  assert.equal(response.result.rankedWordCount, 6);
  assert.ok(Math.abs(response.result.similarity - 0.6) < 1e-10);
  assert.ok(Math.abs(response.result.cosineSimilarity - 0.7) < 1e-10);
});

function makeRankedEmbeddings(count) {
  return Object.fromEntries(
    Array.from({ length: count }, (_, index) => {
      const rank = index + 1;
      const cosine = 1 - (2 * index) / (count - 1);
      return [
        `word${rank}`,
        [cosine, Math.sqrt(Math.max(0, 1 - cosine ** 2)), 0],
      ];
    })
  );
}

test("targets the arithmetic midpoint on the displayed rank-percentile scale", async () => {
  const cases = [
    { bestRank: 21, bestScore: 0, hintRank: 11, hintScore: 0.5 },
    { bestRank: 17, bestScore: 0.2, hintRank: 9, hintScore: 0.6 },
    { bestRank: 3, bestScore: 0.9, hintRank: 2, hintScore: 0.95 },
  ];

  for (const testCase of cases) {
    const embeddings = makeRankedEmbeddings(21);
    const game = new Game({
      embeddings,
      targetWord: "word1",
      commonWords: Object.keys(embeddings),
    });
    await once(game, "ready");

    const guess = game.handleGuess(`word${testCase.bestRank}`, PLAYER);
    assert.equal(guess.ok, true);
    assert.ok(Math.abs(guess.result.similarity - testCase.bestScore) < 1e-10);
    const hint = game.requestHint(PLAYER);

    assert.equal(hint.ok, true);
    assert.equal(hint.result.rank, testCase.hintRank);
    assert.ok(
      Math.abs(hint.result.similarity - testCase.hintScore) < 1e-10,
      `${testCase.bestScore} should produce ${testCase.hintScore}`
    );
  }
});

test("moves 41.2% to 70.6% by rank instead of choosing a nearby 49.4% word", async () => {
  const embeddings = makeRankedEmbeddings(501);
  const game = new Game({
    embeddings,
    targetWord: "word1",
    commonWords: Object.keys(embeddings),
  });
  await once(game, "ready");

  const guess = game.handleGuess("word295", PLAYER);
  assert.ok(Math.abs(guess.result.similarity - 0.412) < 1e-10);
  assert.ok(
    Math.abs(game.getScoreForRank(254) - 0.494) < 1e-10,
    "rank 254 represents the nearby 49.4% candidate"
  );
  const hint = game.requestHint(PLAYER);

  assert.equal(hint.ok, true);
  assert.equal(hint.result.rank, 148);
  assert.ok(Math.abs(hint.result.similarity - 0.706) < 1e-10);
});

test("retains a 500-guess flight log by default", async () => {
  const embeddings = makeRankedEmbeddings(601);
  const game = new Game({
    embeddings,
    targetWord: "word1",
    commonWords: Object.keys(embeddings),
  });
  await once(game, "ready");

  for (let rank = 2; rank <= 501; rank += 1) {
    assert.equal(game.handleGuess(`word${rank}`, PLAYER).ok, true);
  }

  assert.equal(game.getGameState().guessHistory.length, 500);
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

test("builds a stable mission recap with playful awards and per-player stats", async () => {
  const game = await createReadyGame();
  const players = [
    { id: "socket-1", participantId: "crew-1", name: "Nova Navigator", colorIndex: 0, avatarId: "aqua-cadet", joinedAt: "2026-08-20T00:00:00Z" },
    { id: "socket-2", participantId: "crew-2", name: "Orbit Pilot", colorIndex: 1, avatarId: "solar-shades", joinedAt: "2026-08-20T00:00:01Z" },
    { id: "socket-3", participantId: "crew-3", name: "Signal Scout", colorIndex: 2, avatarId: "cosmic-crown", joinedAt: "2026-08-20T00:00:02Z" },
    { id: "socket-4", participantId: "crew-4", name: "Quiet Comet", colorIndex: 3, avatarId: "heart-hopper", joinedAt: "2026-08-20T00:00:03Z" },
  ];
  players.forEach((player) => game.registerPlayer(player));

  assert.equal(game.handleGuess("moon", players[0]).ok, true);
  assert.equal(game.requestHint(players[0]).ok, true);
  assert.equal(game.handleGuess("planet", players[1]).ok, true);
  assert.equal(game.handleGuess("comet", players[1]).ok, true);
  assert.equal(game.handleGuess("beacon", players[2]).ok, true);
  assert.equal(game.handleGuess("star", players[2]).ok, true);

  const recap = game.getGameState().recap;
  assert.equal(recap.playerCount, 4);
  assert.equal(recap.totalGuesses, 5);
  assert.equal(recap.totalHints, 1);
  assert.equal(recap.players.length, 4);
  assert.ok(recap.awards.length >= 9);

  const navigator = recap.players.find((player) => player.playerId === "crew-1");
  assert.equal(navigator.guessCount, 1);
  assert.equal(navigator.hintCount, 1);
  assert.equal(navigator.avatarId, "aqua-cadet");
  assert.equal(navigator.bestGuess.word, "moon");
  assert.ok(navigator.awardIds.includes("most-hints"));

  const pilot = recap.players.find((player) => player.playerId === "crew-2");
  assert.equal(pilot.wrongGuessCount, 2);
  assert.equal(pilot.furthestGuess.word, "planet");
  assert.ok(pilot.awardIds.includes("most-wrong"));
  assert.ok(pilot.awardIds.includes("furthest-guess"));

  const scout = recap.players.find((player) => player.playerId === "crew-3");
  assert.equal(scout.foundTarget, true);
  assert.equal(scout.averageSimilarity, 0.9);
  assert.ok(scout.awardIds.includes("signal-finder"));
  assert.ok(scout.awardIds.includes("best-average"));

  const quiet = recap.players.find((player) => player.playerId === "crew-4");
  assert.equal(quiet.guessCount, 0);
  assert.equal(quiet.averageSimilarity, null);
  assert.equal(quiet.bestGuess, null);
  assert.ok(quiet.awardIds.includes("fewest-guesses"));

  const secondRead = game.getGameState().recap;
  assert.deepEqual(secondRead, recap);
});

test("rejects invalid, unknown, and duplicate guesses without growing history", async () => {
  const game = await createReadyGame();
  assert.equal(game.handleGuess("two words", PLAYER).code, "invalid_guess");
  assert.equal(game.handleGuess("unknown", PLAYER).code, "unknown_word");
  assert.equal(game.handleGuess("moon", PLAYER).ok, true);
  assert.equal(game.handleGuess("MOON", PLAYER).code, "duplicate_guess");
  assert.equal(game.getGameState().guessHistory.length, 1);
});
