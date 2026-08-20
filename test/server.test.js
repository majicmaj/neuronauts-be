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
  const secondIdentity = joined.players.find((player) => player.id === second.id);

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

  const guessFirst = waitFor(first, "guessResult", (guess) => !guess.isHint);
  const guessSecond = waitFor(second, "guessResult", (guess) => !guess.isHint);
  second.emit("guess", { lobbyId: created.lobbyId, guess: "moon" });
  const [firstGuess, secondGuess] = await Promise.all([guessFirst, guessSecond]);
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
  assert.equal(reconnectedIdentity.participantId, secondIdentity.participantId);
  assert.equal(rejoined.gameState.recap.playerCount, 2);
});
