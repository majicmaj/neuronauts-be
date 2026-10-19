const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { io } = require('socket.io-client');
const Game = require('../game');
const { createGameServer } = require('../server');
const { getCategory, getTargetPool, getCategoryCatalog } = require('../categories');
const { defaultConceptLexicon } = require('../conceptLexicon');
const inventory = new Set(require('../lexicon/generated/targets.json').targets);
const reference = require('../words.json');
const allPoolWords = [...new Set(getCategoryCatalog().flatMap(c => getTargetPool(c.id) || []))];
const embeddings = Object.fromEntries([...allPoolWords, 'unrelated'].map((word, i) => [word, [1, i / 1000, .1]]));

function waitFor(socket, event) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { socket.off(event, receive); reject(new Error(`Timeout: ${event}`)); }, 3000);
    function receive(payload) { clearTimeout(timeout); resolve(payload); }
    socket.once(event, receive);
  });
}

test('category catalog contains metadata only and pools contain known canonical eligible inventory', () => {
  const catalog = getCategoryCatalog();
  assert.deepEqual([...new Set(catalog.map(c => c.difficulty))], ['hardest', 'easy', 'medium', 'hard']);
  assert.equal(getCategory().id, 'all');
  assert.equal(getTargetPool('all'), null);
  for (const bad of ['missing', '', null, {}, '__proto__']) {
    assert.equal(getCategory(bad), null);
    assert.throws(() => getTargetPool(bad), /Unknown category/);
  }
  for (const category of catalog) {
    assert.deepEqual(Object.keys(category).sort(), ['description', 'difficulty', 'id', 'label']);
    if (category.id === 'all') continue;
    const pool = getTargetPool(category.id);
    assert.ok(pool.length >= 30, `${category.id} has enough replay variety`);
    assert.equal(new Set(pool).size, pool.length);
    for (const word of pool) {
      assert.ok(inventory.has(word));
      assert.equal(defaultConceptLexicon.resolve(word).canonicalWord, word);
      assert.ok(defaultConceptLexicon.isConceptTargetEligible(word));
    }
  }
});

test('categories select available targets without narrowing guesses or rank/hint calibration', async () => {
  for (const category of getCategoryCatalog().filter(c => c.id !== 'all')) {
    const pool = getTargetPool(category.id);
    const game = new Game({ targetPool: pool, embeddings, random: () => .99999 });
    await once(game, 'ready');
    assert.ok(pool.includes(game.targetWord));
    const baseline = new Game({ targetWord: game.targetWord, embeddings });
    await once(baseline, 'ready');
    assert.deepEqual(game.referenceRanking, baseline.referenceRanking);
    assert.equal(game.rankedWordCount, baseline.rankedWordCount);
    const guess = game.handleGuess('unrelated', { participantId: 'p', name: 'Pilot' });
    assert.equal(guess.ok, true);
    assert.equal(guess.result.correct, false);
  }
  // Only one available category embedding: selection must intersect the pool with availability.
  const pool = getTargetPool('animals');
  const game = new Game({ targetPool: pool, embeddings: { [pool[3]]: [1, 0] } });
  await once(game, 'ready');
  assert.equal(game.targetWord, pool[3]);
  for (const targetPool of [[], ['missing-embedding']]) {
    const unavailable = new Game({ targetPool, embeddings });
    const [error] = await once(unavailable, 'error');
    assert.match(error.message, /No eligible targets/);
    assert.equal(unavailable.status, 'error');
    assert.match(unavailable.getGameState().error, /choose another category or All words/);
  }
});

for (const mode of ['classic', 'versus']) {
  test(`${mode}: server owns category through joins, shared targets, and rematches; older clients default`, async t => {
    const runtime = createGameServer({
      skipEmbeddingsBootstrap: true,
      gameFactory: options => new Game({ ...options, embeddings, random: () => 0 }),
    });
    const address = await runtime.start(0, '127.0.0.1');
    const socket = io(`http://127.0.0.1:${address.port}`, { transports: ['websocket'], reconnection: false });
    const second = io(`http://127.0.0.1:${address.port}`, { transports: ['websocket'], reconnection: false });
    t.after(async () => { socket.disconnect(); second.disconnect(); await runtime.stop(); });
    await Promise.all([waitFor(socket, 'connect'), waitFor(second, 'connect')]);
    const catalogPromise = waitFor(socket, 'categoryCatalog');
    socket.emit('getCategories');
    assert.deepEqual(await catalogPromise, getCategoryCatalog());
    let responsePromise = waitFor(socket, 'lobbyCreated');
    socket.emit('createLobby', { mode });
    const legacy = await responsePromise;
    assert.equal(legacy.category.id, 'all');
    assert.equal(runtime.lobbies.get(legacy.lobbyId).game.targetPool, null);
    const errorPromise = waitFor(socket, 'error');
    socket.emit('createLobby', { mode, categoryId: 'invalid' });
    assert.match(await errorPromise, /Unknown mission category/);
    assert.equal(runtime.lobbies.get(legacy.lobbyId).players.size, 1, 'invalid selection must not remove existing membership');
    responsePromise = waitFor(socket, 'lobbyCreated');
    socket.emit('createLobby', { mode, categoryId: 'animals' });
    const created = await responsePromise;
    assert.deepEqual(created.category, getCategory('animals'));
    assert.equal(created.gameState.targetWord, undefined);
    const joinedPromise = waitFor(second, 'lobbyJoined');
    second.emit('joinLobby', { lobbyId: created.lobbyId, categoryId: 'science' });
    const joined = await joinedPromise;
    assert.deepEqual(joined.category, created.category);
    const lobby = runtime.lobbies.get(created.lobbyId);
    if (lobby.game.status === 'loading') await once(lobby.game, 'ready');
    const games = mode === 'versus' ? [...lobby.game.games.values()] : [lobby.game];
    for (const game of games) {
      assert.ok(getTargetPool('animals').includes(game.targetWord));
      assert.deepEqual(game.targetPool, getTargetPool('animals'));
    }
    assert.equal(new Set(games.map(game => game.targetWord)).size, 1);
    // Completion mechanics are covered in dedicated multiplayer tests; exercise rematch protocol here.
    lobby.game.status = 'won';
    const rematchPromise = waitFor(socket, 'rematchReady');
    socket.emit('requestRematch', { lobbyId: created.lobbyId });
    const rematch = await rematchPromise;
    const next = runtime.lobbies.get(rematch.lobbyId);
    assert.equal(next.mode, mode);
    assert.deepEqual(next.category, created.category);
    if (next.game.status === 'loading') await once(next.game, 'ready');
    const nextGames = mode === 'versus' ? [...next.game.games.values()] : [next.game];
    assert.ok(nextGames.every(game => getTargetPool('animals').includes(game.targetWord)));
  });
}

for (const mode of ['classic', 'versus']) {
  test(`${mode}: unavailable category targets give an actionable socket error without leaking a target`, async t => {
    const runtime = createGameServer({
      skipEmbeddingsBootstrap: true,
      gameFactory: options => new Game({ ...options, embeddings: { unrelated: [1, 0] } }),
    });
    const address = await runtime.start(0, '127.0.0.1');
    const socket = io(`http://127.0.0.1:${address.port}`, { transports: ['websocket'], reconnection: false });
    t.after(async () => { socket.disconnect(); await runtime.stop(); });
    await waitFor(socket, 'connect');
    const createdPromise = waitFor(socket, 'lobbyCreated');
    const errorPromise = waitFor(socket, 'actionError');
    socket.emit('createLobby', { mode, categoryId: 'animals' });
    const created = await createdPromise;
    const error = await errorPromise;
    assert.equal(error.code, 'game_unavailable');
    assert.match(error.message, /Return home and choose another category or All words/);
    assert.equal(created.gameState.targetWord, undefined);
    const rejoinedPromise = waitFor(socket, 'lobbyJoined');
    socket.emit('joinLobby', { lobbyId: created.lobbyId });
    const rejoined = await rejoinedPromise;
    assert.equal(rejoined.gameState.status, 'error');
    assert.match(rejoined.gameState.error, /Return home and choose another category or All words/);
    assert.equal(rejoined.gameState.targetWord, undefined);
  });
}
