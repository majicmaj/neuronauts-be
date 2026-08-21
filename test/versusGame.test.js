const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const Game = require("../game");
const VersusGame = require("../versusGame");

const EMBEDDINGS = {
  star: [1, 0, 0],
  beacon: [0.8, 0.6, 0],
  bridge: [0.6, 0.8, 0],
  moon: [0, 1, 0],
  planet: [-1, 0, 0],
};

function makePlayer(id, teamId) {
  return {
    id: `socket-${id}`,
    participantId: `player-${id}`,
    name: `Player ${id}`,
    avatarId: id === 1 ? "aqua-cadet" : "solar-shades",
    colorIndex: id - 1,
    teamId,
    ready: false,
  };
}

test("keeps team searches isolated, lets the second team finish, and grades hint restraint", async () => {
  let now = Date.parse("2026-08-21T12:00:00Z");
  const match = new VersusGame({
    now: () => now,
    random: () => 0,
    gameFactory: (options = {}) => new Game({
      embeddings: EMBEDDINGS,
      targetWord: options.targetWord || "star",
      commonWords: Object.keys(EMBEDDINGS),
      semanticFloor: 0,
      semanticCeiling: 1,
      hintCooldownMs: 0,
      now: () => now,
    }),
  });
  await once(match, "ready");

  const red = makePlayer(1, "red");
  const blue = makePlayer(2, "blue");
  const players = [red, blue];
  players.forEach((player) => match.registerPlayer(player));

  assert.equal(match.toggleReady(red, players).started, false);
  assert.equal(match.toggleReady(blue, players).started, true);
  assert.equal(match.phase, "playing");

  now += 10_000;
  assert.equal(match.handleGuess("star", red).result.correct, true);
  assert.equal(match.phase, "playing", "the second team keeps playing after first contact");
  assert.equal(match.getView("blue", players).gameState.status, "playing");
  assert.equal(match.getView("red", players).gameState.status, "team-finished");

  now += 1_000;
  assert.equal(match.handleGuess("moon", blue).ok, true);
  assert.equal(match.requestHint(blue).ok, true);
  assert.equal(match.handleGuess("star", blue).result.correct, true);
  assert.equal(match.phase, "complete");

  const result = match.getResult(players);
  assert.equal(result.winnerTeamId, "red");
  assert.equal(result.loserTeamId, "blue");
  assert.equal(result.standings[0].hintCount, 0);
  assert.equal(result.standings[1].hintCount, 1);
  assert.equal(result.scoring.hintPenaltySeconds, 60);
});

test("opponent views expose telemetry and points without transmitting words", async () => {
  const match = new VersusGame({
    random: () => 0,
    gameFactory: (options = {}) => new Game({
      embeddings: EMBEDDINGS,
      targetWord: options.targetWord || "star",
      commonWords: Object.keys(EMBEDDINGS),
      semanticFloor: 0,
      semanticCeiling: 1,
    }),
  });
  await once(match, "ready");
  const red = makePlayer(1, "red");
  const blue = makePlayer(2, "blue");
  const players = [red, blue];
  players.forEach((player) => match.registerPlayer(player));
  match.toggleReady(red, players);
  match.toggleReady(blue, players);
  match.handleGuess("moon", red);

  const redView = match.getView("red", players);
  const blueView = match.getView("blue", players);
  assert.equal(redView.gameState.guessHistory[0].guess, "moon");
  assert.equal(blueView.gameState.guessHistory.length, 0);
  assert.equal(blueView.opponentPoints.length, 1);
  assert.equal("guess" in blueView.opponentPoints[0], false);
  assert.equal("submittedGuess" in blueView.opponentPoints[0], false);
  assert.equal("hintFrom" in blueView.opponentPoints[0], false);
  assert.equal(blueView.teams.find((team) => team.id === "red").guessCount, 1);
  assert.equal(
    blueView.teams.find((team) => team.id === "red").playerStats[0].bestSimilarity,
    0
  );
});

test("keeps disconnected contributors in the final per-player breakdown", async () => {
  const match = new VersusGame({
    random: () => 0,
    gameFactory: (options = {}) => new Game({
      embeddings: EMBEDDINGS,
      targetWord: options.targetWord || "star",
      commonWords: Object.keys(EMBEDDINGS),
      semanticFloor: 0,
      semanticCeiling: 1,
    }),
  });
  await once(match, "ready");
  const red = makePlayer(1, "red");
  const blue = makePlayer(2, "blue");
  const players = [red, blue];
  players.forEach((player) => match.registerPlayer(player));
  match.toggleReady(red, players);
  match.toggleReady(blue, players);

  match.handleGuess("moon", red);
  const redSummary = match.getTeamSummary("red", [blue]);

  assert.equal(redSummary.playerStats.length, 1);
  assert.equal(redSummary.playerStats[0].playerId, red.participantId);
  assert.equal(redSummary.playerStats[0].guessCount, 1);
  assert.equal(redSummary.playerStats[0].playerName, red.name);
});

test("keeps team setup reversible and randomizable until every player launches", async () => {
  const match = new VersusGame({
    random: () => 0,
    gameFactory: (options = {}) => new Game({
      embeddings: EMBEDDINGS,
      targetWord: options.targetWord || "star",
      commonWords: Object.keys(EMBEDDINGS),
      semanticFloor: 0,
      semanticCeiling: 1,
    }),
  });
  await once(match, "ready");

  assert.equal(
    match.games.get("red").targetWord,
    match.games.get("blue").targetWord,
    "both airlocks search for the same target"
  );

  const players = [
    makePlayer(1, "red"),
    makePlayer(2, "blue"),
    makePlayer(3, "red"),
    makePlayer(4, "blue"),
  ];
  players.forEach((player) => match.registerPlayer(player));

  match.toggleReady(players[0], players);
  assert.equal(players[0].ready, true);
  assert.equal(match.setTeam(players[0], "blue").ok, true);
  assert.equal(players[0].ready, false, "switching sides clears the stale ready state");

  assert.equal(match.randomizeTeams(players).ok, true);
  assert.equal(players.filter((player) => player.teamId === "red").length, 2);
  assert.equal(players.filter((player) => player.teamId === "blue").length, 2);
  assert.equal(players.every((player) => player.ready === false), true);

  players.forEach((player) => match.toggleReady(player, players));
  assert.equal(match.phase, "playing");
  assert.equal(match.setTeam(players[0], "red").code, "match_started");
  assert.equal(match.randomizeTeams(players).code, "match_started");
});
