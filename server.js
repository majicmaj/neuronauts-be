const express = require("express");
const http = require("http");
const path = require("path");
const socketIo = require("socket.io");
const Game = require("./game");
const cors = require("cors");
const embeddingsManager = require("./utils/embeddingsManager");

const app = express();
const server = http.createServer(app);

const PORT = Number(process.env.PORT || 3000);
const MAX_LOBBIES = Number(process.env.MAX_LOBBIES || 100);
const MAX_PLAYERS_PER_LOBBY = Number(process.env.MAX_PLAYERS_PER_LOBBY || 12);
const STALE_LOBBY_MS = Number(process.env.STALE_LOBBY_MS || 30 * 60 * 1000);
const CLEANUP_INTERVAL_MS = Number(process.env.CLEANUP_INTERVAL_MS || 5 * 60 * 1000);
const RECENT_EVENTS_LIMIT = Number(process.env.RECENT_EVENTS_LIMIT || 200);

const allowedOrigins = (
  process.env.CORS_ORIGINS ||
  "http://localhost:5173,http://semantle.netlify.app,https://semantle.netlify.app,https://semantle.hobbyhood.app"
)
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: allowedOrigins,
    methods: ["GET", "POST"],
  })
);

const io = socketIo(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
  },
});

app.use(express.static(path.join(__dirname, "public")));

const lobbies = {};
const recentEvents = [];

function nowIso() {
  return new Date().toISOString();
}

function recordEvent(type, details = {}) {
  const event = {
    at: nowIso(),
    type,
    ...details,
  };

  recentEvents.unshift(event);
  if (recentEvents.length > RECENT_EVENTS_LIMIT) {
    recentEvents.length = RECENT_EVENTS_LIMIT;
  }

  const summary = Object.entries(details)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  console.log(`[event] ${type}${summary ? ` ${summary}` : ""}`);

  return event;
}

function getActiveLobbyCount() {
  return Object.keys(lobbies).length;
}

function getActivePlayerCount() {
  return Object.values(lobbies).reduce(
    (sum, lobby) => sum + lobby.players.size,
    0
  );
}

function getStats() {
  const rooms = Object.entries(lobbies).map(([lobbyId, lobby]) => ({
    lobbyId,
    players: lobby.players.size,
    createdAt: lobby.createdAt,
    lastActivityAt: lobby.lastActivityAt,
    idleMs: Date.now() - lobby.lastActivityMs,
  }));

  rooms.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));

  return {
    ok: true,
    serverTime: nowIso(),
    limits: {
      maxLobbies: MAX_LOBBIES,
      maxPlayersPerLobby: MAX_PLAYERS_PER_LOBBY,
      staleLobbyMs: STALE_LOBBY_MS,
      cleanupIntervalMs: CLEANUP_INTERVAL_MS,
      recentEventsLimit: RECENT_EVENTS_LIMIT,
    },
    rooms: {
      active: rooms.length,
      list: rooms,
    },
    players: {
      active: getActivePlayerCount(),
    },
    lastEvent: recentEvents[0] || null,
    recentEvents,
    embeddings: embeddingsManager.getStatus(),
  };
}

function updateLobbyActivity(lobby) {
  lobby.lastActivityMs = Date.now();
  lobby.lastActivityAt = nowIso();
}

function createLobbyRecord(lobbyId) {
  const game = new Game();
  const lobby = {
    lobbyId,
    game,
    players: new Set(),
    createdAt: nowIso(),
    lastActivityAt: nowIso(),
    lastActivityMs: Date.now(),
  };

  game.on("ready", (gameState) => {
    updateLobbyActivity(lobby);
    io.to(lobbyId).emit("gameReady", gameState);
    recordEvent("lobby_ready", {
      lobbyId,
      players: lobby.players.size,
    });
  });

  lobbies[lobbyId] = lobby;
  return lobby;
}

function deleteLobby(lobbyId, reason) {
  const lobby = lobbies[lobbyId];
  if (!lobby) return;

  const playerCount = lobby.players.size;
  delete lobbies[lobbyId];
  recordEvent("lobby_deleted", {
    lobbyId,
    reason,
    players: playerCount,
    activeRooms: getActiveLobbyCount(),
    activePlayers: getActivePlayerCount(),
  });
}

function cleanupStaleLobbies() {
  const cutoff = Date.now() - STALE_LOBBY_MS;
  for (const [lobbyId, lobby] of Object.entries(lobbies)) {
    if (lobby.players.size === 0 && lobby.lastActivityMs < cutoff) {
      deleteLobby(lobbyId, "stale_empty");
    }
  }
}

function generateLobbyId(length = 6) {
  const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let result = "";
  do {
    result = "";
    for (let i = 0; i < length; i++) {
      result += characters.charAt(Math.floor(Math.random() * characters.length));
    }
  } while (lobbies[result]);
  return result;
}

function emitCapacityError(socket, message, code) {
  socket.emit("error", message);
  recordEvent("capacity_rejected", {
    socketId: socket.id,
    code,
    message,
    activeRooms: getActiveLobbyCount(),
    activePlayers: getActivePlayerCount(),
  });
}

app.get("/health", (_req, res) => {
  const status = embeddingsManager.getStatus();
  res.status(status.ready ? 200 : 503).json({
    ok: status.ready,
    ...status,
  });
});

app.get("/stats", (_req, res) => {
  res.json(getStats());
});

embeddingsManager
  .getEmbeddings()
  .then(() => {
    recordEvent("embeddings_ready", { file: embeddingsManager.getStatus().file });
  })
  .catch((err) => {
    console.error("Embeddings failed to load:", err.message);
    recordEvent("embeddings_error", { message: err.message });
  });

setInterval(cleanupStaleLobbies, CLEANUP_INTERVAL_MS).unref();

io.on("connection", (socket) => {
  socket.data.lobbyId = null;

  socket.on("createLobby", () => {
    if (getActiveLobbyCount() >= MAX_LOBBIES) {
      return emitCapacityError(
        socket,
        `Server room capacity reached (${MAX_LOBBIES} active lobbies). Please try again later.`,
        "max_lobbies"
      );
    }

    const lobbyId = generateLobbyId();
    const lobby = createLobbyRecord(lobbyId);

    socket.join(lobbyId);
    socket.data.lobbyId = lobbyId;
    lobby.players.add(socket.id);
    updateLobbyActivity(lobby);

    recordEvent("lobby_created", {
      lobbyId,
      players: lobby.players.size,
      activeRooms: getActiveLobbyCount(),
      activePlayers: getActivePlayerCount(),
    });

    socket.emit("lobbyCreated", {
      lobbyId,
      gameState: lobby.game.getGameState(),
    });
  });

  socket.on("joinLobby", (lobbyId) => {
    const lobby = lobbies[lobbyId];
    if (!lobby) {
      socket.emit("error", "Lobby does not exist.");
      return;
    }

    if (!lobby.players.has(socket.id) && lobby.players.size >= MAX_PLAYERS_PER_LOBBY) {
      return emitCapacityError(
        socket,
        `Lobby ${lobbyId} is full (${MAX_PLAYERS_PER_LOBBY} players max).`,
        "max_players_per_lobby"
      );
    }

    socket.join(lobbyId);
    socket.data.lobbyId = lobbyId;
    lobby.players.add(socket.id);
    updateLobbyActivity(lobby);

    socket.emit("lobbyJoined", {
      lobbyId,
      gameState: lobby.game.getGameState(),
    });
    socket.to(lobbyId).emit("playerJoined", { socketId: socket.id });

    recordEvent("lobby_joined", {
      lobbyId,
      players: lobby.players.size,
      activeRooms: getActiveLobbyCount(),
      activePlayers: getActivePlayerCount(),
    });
  });

  socket.on("guess", (data) => {
    const { lobbyId, guess } = data;
    const lobby = lobbies[lobbyId];
    if (!lobby) {
      socket.emit("error", "Lobby not found.");
      return;
    }

    updateLobbyActivity(lobby);
    const result = lobby.game.handleGuess(guess);
    io.to(lobbyId).emit("guessResult", result);
  });

  socket.on("disconnect", () => {
    const { lobbyId } = socket.data;
    if (!lobbyId) return;

    const lobby = lobbies[lobbyId];
    if (!lobby) return;

    lobby.players.delete(socket.id);
    updateLobbyActivity(lobby);

    recordEvent("lobby_left", {
      lobbyId,
      players: lobby.players.size,
      activeRooms: getActiveLobbyCount(),
      activePlayers: getActivePlayerCount(),
    });
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
