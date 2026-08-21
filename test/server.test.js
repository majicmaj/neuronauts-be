const test = require("node:test");
const assert = require("node:assert/strict");
const { io: createClient } = require("socket.io-client");
const Game = require("../game");
const { createGameServer } = require("../server");

const EMBEDDINGS = {
  star: [1, 0, 0],
  moon: [0, 1, 0],
  bridge: [0.5, Math.sqrt(0.75), 0],
  planet: [-1, 0, 0],
};

function waitFor(socket, event, predicate = () => true, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Timed out waiting for ${event}`));
    }, timeoutMs);
    const handler = (payload) => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    };
    socket.on(event, handler);
  });
}

async function connect(url) {
  const socket = createClient(url, {
    forceNew: true,
    transports: ["websocket"],
    reconnection: false,
  });
  await waitFor(socket, "connect");
  return socket;
}

function emitWithAck(socket, event, payload, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    socket.timeout(timeoutMs).emit(event, payload, (error, response) => {
      if (error) reject(error);
      else resolve(response);
    });
  });
}

test("multiplayer lobby synchronizes identities, hints, attribution, and wins", async (t) => {
  const runtime = createGameServer({
    skipEmbeddingsBootstrap: true,
    guessRateLimitMs: 0,
    gameFactory: () =>
      new Game({
        embeddings: EMBEDDINGS,
        targetWord: "star",
        commonWords: Object.keys(EMBEDDINGS),
        hintCooldownMs: 60_000,
      }),
  });
  const address = await runtime.start(0, "127.0.0.1");
  const url = `http://127.0.0.1:${address.port}`;
  const first = await connect(url);
  const second = await connect(url);
  let reconnected;

  t.after(async () => {
    first.disconnect();
    second.disconnect();
    reconnected?.disconnect();
    await runtime.stop();
  });

  const createdPromise = waitFor(first, "lobbyCreated");
  first.emit("createLobby", { preferredName: "Nova Navigator" });
  const created = await createdPromise;
  assert.equal(created.playerCount, 1);
  assert.equal(created.players[0].name, "Nova Navigator");
  assert.equal(created.players[0].avatarId, "aqua-cadet");
  assert.deepEqual(created.typingPlayerIds, []);

  const twoPlayersFirst = waitFor(
    first,
    "playersUpdated",
    (payload) => payload.playerCount === 2
  );
  const joinedPromise = waitFor(second, "lobbyJoined");
  second.emit("joinLobby", {
    lobbyId: created.lobbyId,
    preferredName: "Nova Navigator",
  });
  const [playersPayload, joined] = await Promise.all([
    twoPlayersFirst,
    joinedPromise,
  ]);
  assert.equal(joined.playerCount, 2);
  assert.equal(new Set(playersPayload.players.map((player) => player.name)).size, 2);
  assert.equal(
    new Set(playersPayload.players.map((player) => player.colorIndex)).size,
    2
  );
  assert.equal(
    new Set(playersPayload.players.map((player) => player.avatarId)).size,
    2
  );
  const secondIdentity = joined.players.find((player) => player.id === second.id);
  assert.equal(secondIdentity.avatarId, "solar-shades");

  const avatarChangedFirst = waitFor(
    first,
    "playersUpdated",
    (payload) => payload.players.find((player) => player.id === first.id)?.avatarId === "star-mage"
  );
  const avatarChangedSecond = waitFor(
    second,
    "playersUpdated",
    (payload) => payload.players.find((player) => player.id === first.id)?.avatarId === "star-mage"
  );
  first.emit("setPlayerAvatar", {
    lobbyId: created.lobbyId,
    avatarId: "star-mage",
  });
  await Promise.all([avatarChangedFirst, avatarChangedSecond]);

  const avatarTaken = waitFor(
    second,
    "actionError",
    (error) => error.code === "avatar_taken"
  );
  second.emit("setPlayerAvatar", {
    lobbyId: created.lobbyId,
    avatarId: "star-mage",
  });
  assert.match((await avatarTaken).message, /already claimed/i);

  const renamedFirst = waitFor(
    first,
    "playersUpdated",
    (payload) => payload.players.some((player) => player.name === "Captain Kepler")
  );
  const renamedSecond = waitFor(
    second,
    "playersUpdated",
    (payload) => payload.players.some((player) => player.name === "Captain Kepler")
  );
  first.emit("setPlayerName", {
    lobbyId: created.lobbyId,
    name: "Captain Kepler",
  });
  await Promise.all([renamedFirst, renamedSecond]);

  const typingStarted = waitFor(
    first,
    "typingUpdated",
    (payload) => payload.playerIds.includes(second.id)
  );
  second.emit("typing", { lobbyId: created.lobbyId, isTyping: true });
  assert.deepEqual((await typingStarted).playerIds, [second.id]);

  const guessFirst = waitFor(first, "guessResult", (guess) => !guess.isHint);
  const guessSecond = waitFor(second, "guessResult", (guess) => !guess.isHint);
  const typingCleared = waitFor(
    first,
    "typingUpdated",
    (payload) => payload.playerIds.length === 0
  );
  second.emit("guess", { lobbyId: created.lobbyId, guess: "moon" });
  const [firstGuess, secondGuess] = await Promise.all([
    guessFirst,
    guessSecond,
    typingCleared,
  ]);
  assert.equal(firstGuess.id, secondGuess.id);
  assert.equal(firstGuess.playerId, secondIdentity.participantId);
  assert.equal(firstGuess.playerName, joined.players.find((p) => p.id === second.id).name);
  assert.equal(
    firstGuess.colorIndex,
    joined.players.find((p) => p.id === second.id).colorIndex
  );

  const hintFirst = waitFor(first, "guessResult", (guess) => guess.isHint);
  const hintSecond = waitFor(second, "guessResult", (guess) => guess.isHint);
  first.emit("requestHint", { lobbyId: created.lobbyId });
  const [firstHint, secondHint] = await Promise.all([hintFirst, hintSecond]);
  assert.equal(firstHint.id, secondHint.id);
  assert.equal(firstHint.guess, "bridge");
  assert.equal(firstHint.playerName, "Captain Kepler");
  assert.equal(firstHint.colorIndex, created.players[0].colorIndex);
  assert.ok(firstHint.hintAvailableAt);

  const cooldownError = waitFor(
    second,
    "actionError",
    (error) => error.code === "hint_cooldown"
  );
  second.emit("requestHint", { lobbyId: created.lobbyId });
  assert.ok((await cooldownError).hintAvailableAt);

  const wonFirst = waitFor(first, "gameWon");
  const wonSecond = waitFor(second, "gameWon");
  second.emit("guess", { lobbyId: created.lobbyId, guess: "star" });
  const [firstWin, secondWin] = await Promise.all([wonFirst, wonSecond]);
  assert.equal(firstWin.targetWord, "star");
  assert.equal(secondWin.winner.playerId, secondIdentity.participantId);
  assert.equal(firstWin.guessHistory.length, 3);
  assert.equal(firstWin.recap.playerCount, 2);
  assert.equal(firstWin.recap.totalGuesses, 2);
  assert.equal(firstWin.recap.totalHints, 1);
  assert.equal(firstWin.recap.players.length, 2);
  assert.ok(firstWin.recap.awards.some((award) => award.id === "signal-finder"));
  assert.equal(
    firstWin.recap.players.find((player) => player.playerId === created.players[0].participantId).avatarId,
    "star-mage"
  );

  const onePlayer = waitFor(
    first,
    "playersUpdated",
    (payload) => payload.playerCount === 1
  );
  second.disconnect();
  assert.equal((await onePlayer).playerCount, 1);

  reconnected = await connect(url);
  const rejoinedPromise = waitFor(reconnected, "lobbyJoined");
  reconnected.emit("joinLobby", {
    lobbyId: created.lobbyId,
    preferredName: secondIdentity.name,
  });
  const rejoined = await rejoinedPromise;
  const reconnectedIdentity = rejoined.players.find(
    (player) => player.id === reconnected.id
  );
  assert.equal(reconnectedIdentity.name, secondIdentity.name);
  assert.equal(reconnectedIdentity.colorIndex, secondIdentity.colorIndex);
  assert.equal(reconnectedIdentity.avatarId, secondIdentity.avatarId);
  assert.equal(reconnectedIdentity.participantId, secondIdentity.participantId);
  assert.equal(rejoined.gameState.recap.playerCount, 2);
});

test("finished crews share one rematch lobby and a stable ready count", async (t) => {
  const runtime = createGameServer({
    skipEmbeddingsBootstrap: true,
    guessRateLimitMs: 0,
    gameFactory: () =>
      new Game({
        embeddings: EMBEDDINGS,
        targetWord: "star",
        commonWords: Object.keys(EMBEDDINGS),
      }),
  });
  const address = await runtime.start(0, "127.0.0.1");
  const url = `http://127.0.0.1:${address.port}`;
  const first = await connect(url);
  const second = await connect(url);

  t.after(async () => {
    first.disconnect();
    second.disconnect();
    await runtime.stop();
  });

  const createdPromise = waitFor(first, "lobbyCreated");
  first.emit("createLobby", { preferredName: "Rematch Ranger" });
  const created = await createdPromise;

  const joinedPromise = waitFor(second, "lobbyJoined");
  second.emit("joinLobby", {
    lobbyId: created.lobbyId,
    preferredName: "Replay Pilot",
  });
  await joinedPromise;

  const wonFirst = waitFor(first, "gameWon");
  const wonSecond = waitFor(second, "gameWon");
  first.emit("guess", { lobbyId: created.lobbyId, guess: "star" });
  await Promise.all([wonFirst, wonSecond]);

  const firstReadyPromise = waitFor(first, "rematchReady");
  const oneReadyPromise = waitFor(
    second,
    "rematchUpdated",
    (rematch) => rematch.readyCount === 1
  );
  first.emit("requestRematch", { lobbyId: created.lobbyId });
  const [firstReady, oneReady] = await Promise.all([
    firstReadyPromise,
    oneReadyPromise,
  ]);
  assert.equal(oneReady.totalCount, 2);
  assert.equal(oneReady.readyParticipantIds.length, 1);
  assert.ok(runtime.lobbies.has(firstReady.lobbyId));

  const secondReadyPromise = waitFor(second, "rematchReady");
  const bothReadyPromise = waitFor(
    first,
    "rematchUpdated",
    (rematch) => rematch.readyCount === 2
  );
  second.emit("requestRematch", { lobbyId: created.lobbyId });
  const [secondReady, bothReady] = await Promise.all([
    secondReadyPromise,
    bothReadyPromise,
  ]);
  assert.equal(secondReady.lobbyId, firstReady.lobbyId);
  assert.equal(bothReady.totalCount, 2);
  assert.equal(bothReady.readyCount, 2);

  const firstJoinedPromise = waitFor(first, "lobbyJoined");
  first.emit("joinLobby", {
    lobbyId: firstReady.lobbyId,
    preferredName: "Rematch Ranger",
  });
  const firstJoined = await firstJoinedPromise;
  assert.equal(firstJoined.lobbyId, firstReady.lobbyId);

  const secondJoinedPromise = waitFor(second, "lobbyJoined");
  second.emit("joinLobby", {
    lobbyId: secondReady.lobbyId,
    preferredName: "Replay Pilot",
  });
  const secondJoined = await secondJoinedPromise;
  assert.equal(secondJoined.lobbyId, firstReady.lobbyId);
  assert.equal(secondJoined.playerCount, 2);
  assert.equal(new Set(secondJoined.players.map((player) => player.name)).size, 2);
});

test("concurrent spelling variants create one guess and recall it for the other player", async (t) => {
  const embeddings = {
    star: [1, 0],
    jewelry: [0.8, 0.6],
    moon: [0, 1],
  };
  const runtime = createGameServer({
    skipEmbeddingsBootstrap: true,
    guessRateLimitMs: 0,
    gameFactory: () =>
      new Game({
        embeddings,
        targetWord: "star",
        commonWords: ["star", "jewellery", "jewelry", "moon"],
      }),
  });
  const address = await runtime.start(0, "127.0.0.1");
  const url = `http://127.0.0.1:${address.port}`;
  const first = await connect(url);
  const second = await connect(url);

  t.after(async () => {
    first.disconnect();
    second.disconnect();
    await runtime.stop();
  });

  const createdPromise = waitFor(first, "lobbyCreated");
  first.emit("createLobby", { preferredName: "Variant Voyager" });
  const created = await createdPromise;
  const joinedPromise = waitFor(second, "lobbyJoined");
  second.emit("joinLobby", {
    lobbyId: created.lobbyId,
    preferredName: "Spelling Scout",
  });
  await joinedPromise;

  const responses = await Promise.all([
    emitWithAck(first, "guess", { lobbyId: created.lobbyId, guess: "jewelry" }),
    emitWithAck(second, "guess", { lobbyId: created.lobbyId, guess: "jewellery" }),
  ]);
  const accepted = responses.find((response) => response.ok);
  const duplicate = responses.find((response) => !response.ok);

  assert.ok(accepted);
  assert.equal(accepted.result.guess, "jewelry");
  assert.equal(duplicate.code, "duplicate_guess");
  assert.equal(duplicate.resolvedGuess, "jewelry");
  assert.equal(duplicate.existingResult.id, accepted.result.id);
  assert.equal(runtime.lobbies.get(created.lobbyId).game.guessHistory.length, 1);
});
