const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const socketIo = require("socket.io");
const cors = require("cors");
const Game = require("./game");
const VersusGame = require("./versusGame");
const embeddingsManager = require("./utils/embeddingsManager");

const DEFAULT_PORT = Number(process.env.PORT || 3000);
const MAX_LOBBIES = Number(process.env.MAX_LOBBIES || 100);
const MAX_PLAYERS_PER_LOBBY = Number(process.env.MAX_PLAYERS_PER_LOBBY || 12);
const STALE_LOBBY_MS = Number(process.env.STALE_LOBBY_MS || 30 * 60 * 1000);
const CLEANUP_INTERVAL_MS = Number(
  process.env.CLEANUP_INTERVAL_MS || 5 * 60 * 1000
);
const RECENT_EVENTS_LIMIT = Number(process.env.RECENT_EVENTS_LIMIT || 200);
const GUESS_RATE_LIMIT_MS = Number(process.env.GUESS_RATE_LIMIT_MS || 250);
const PLAYER_COLOR_COUNT = 12;
const PLAYER_AVATAR_IDS = [
  "aqua-cadet",
  "solar-shades",
  "cosmic-crown",
  "heart-hopper",
  "blue-scout",
  "tech-ranger",
  "shark-suit",
  "space-sheriff",
  "disco-pilot",
  "pizza-runner",
  "star-mage",
  "mission-coder",
  "arctic-explorer",
  "dino-cadet",
  "shadow-cat",
  "halo-heart",
];

const DEFAULT_ORIGINS = [
  "http://localhost:5173",
  "http://semantle.netlify.app",
  "https://semantle.netlify.app",
  "https://semantle.hobbyhood.app",
];

const NAME_ADJECTIVES = [
  "Astral", "Cosmic", "Electric", "Galactic", "Lunar", "Nebula",
  "Nova", "Orbiting", "Quantum", "Radiant", "Solar", "Stellar",
];

const NAME_ROLES = [
  "Cadet", "Cartographer", "Comet", "Cosmonaut", "Explorer", "Navigator",
  "Pathfinder", "Pilot", "Pioneer", "Ranger", "Researcher", "Voyager",
];

function nowIso() {
  return new Date().toISOString();
}

function normalizeLobbyId(value) {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function normalizePlayerName(value) {
  if (typeof value !== "string") return null;
  const name = value.trim().replace(/\s+/g, " ");
  if (name.length < 2 || name.length > 24) return null;
  if (!/^[\p{L}\p{N}][\p{L}\p{N} .'-]*$/u.test(name)) return null;
  return name;
}

function isNameAvailable(lobby, name, exceptSocketId = null) {
  const normalized = name.toLocaleLowerCase();
  return !Array.from(lobby.players.values()).some(
    (player) =>
      player.id !== exceptSocketId &&
      player.name.toLocaleLowerCase() === normalized
  );
}

function isAvatarAvailable(lobby, avatarId, exceptSocketId = null) {
  return !Array.from(lobby.players.values()).some(
    (player) => player.id !== exceptSocketId && player.avatarId === avatarId
  );
}

function generatePlayerName(lobby, random = Math.random) {
  const combinations = NAME_ADJECTIVES.length * NAME_ROLES.length;
  const start = Math.floor(random() * combinations);
  for (let offset = 0; offset < combinations; offset += 1) {
    const index = (start + offset) % combinations;
    const adjective = NAME_ADJECTIVES[Math.floor(index / NAME_ROLES.length)];
    const role = NAME_ROLES[index % NAME_ROLES.length];
    const name = `${adjective} ${role}`;
    if (isNameAvailable(lobby, name)) return name;
  }
  return `Neuronaut ${lobby.players.size + 1}`;
}

function serializePlayers(lobby) {
  return Array.from(lobby.players.values()).map((player) => ({
    id: player.id,
    participantId: player.participantId,
    name: player.name,
    joinedAt: player.joinedAt,
    colorIndex: player.colorIndex,
    avatarId: player.avatarId,
    teamId: player.teamId || null,
    ready: player.ready === true,
  }));
}

function createGameServer(options = {}) {
  const allowedOrigins = (
    options.allowedOrigins ||
    (process.env.CORS_ORIGINS
      ? process.env.CORS_ORIGINS.split(",")
      : DEFAULT_ORIGINS)
  )
    .map((origin) => origin.trim())
    .filter(Boolean);

  const app = express();
  const server = http.createServer(app);
  const io = socketIo(server, {
    cors: { origin: allowedOrigins, methods: ["GET", "POST"] },
    serveClient: false,
    transports: ["websocket", "polling"],
    maxHttpBufferSize: 16_384,
    pingInterval: 25_000,
    pingTimeout: 20_000,
  });
  const lobbies = new Map();
  const recentEvents = [];
  const random = options.random || Math.random;
  const gameFactory = options.gameFactory || ((gameOptions = {}) => new Game(gameOptions));
  const versusFactory = options.versusFactory || ((versusOptions = {}) =>
    new VersusGame({
      gameFactory,
      random,
      ...versusOptions,
    })
  );
  const limits = {
    maxLobbies: options.maxLobbies || MAX_LOBBIES,
    maxPlayersPerLobby: Math.min(
      options.maxPlayersPerLobby || MAX_PLAYERS_PER_LOBBY,
      PLAYER_AVATAR_IDS.length,
      PLAYER_COLOR_COUNT
    ),
    staleLobbyMs: options.staleLobbyMs || STALE_LOBBY_MS,
    cleanupIntervalMs: options.cleanupIntervalMs || CLEANUP_INTERVAL_MS,
    recentEventsLimit: options.recentEventsLimit || RECENT_EVENTS_LIMIT,
    guessRateLimitMs: options.guessRateLimitMs ?? GUESS_RATE_LIMIT_MS,
  };

  app.disable("x-powered-by");
  app.use(cors({ origin: allowedOrigins, methods: ["GET", "POST"] }));
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  });
  app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h" }));

  function recordEvent(type, details = {}) {
    const event = { at: nowIso(), type, ...details };
    recentEvents.unshift(event);
    if (recentEvents.length > limits.recentEventsLimit) {
      recentEvents.length = limits.recentEventsLimit;
    }
    const summary = Object.entries(details)
      .map(([key, value]) => `${key}=${value}`)
      .join(" ");
    console.log(`[event] ${type}${summary ? ` ${summary}` : ""}`);
    return event;
  }

  const getActivePlayerCount = () =>
    Array.from(lobbies.values()).reduce(
      (sum, lobby) => sum + lobby.players.size,
      0
    );

  function updateLobbyActivity(lobby) {
    lobby.lastActivityMs = Date.now();
    lobby.lastActivityAt = nowIso();
  }

  function emitPlayers(lobby) {
    io.to(lobby.lobbyId).emit("playersUpdated", {
      players: serializePlayers(lobby),
      playerCount: lobby.players.size,
    });
  }

  function emitVersusState(lobby) {
    if (lobby.mode !== "versus") return;
    for (const player of lobby.players.values()) {
      io.to(player.id).emit("versusUpdated", lobbyPayload(lobby, player.id));
    }
  }

  function emitTyping(lobby) {
    io.to(lobby.lobbyId).emit("typingUpdated", {
      playerIds: Array.from(lobby.typingPlayerIds),
    });
  }

  function serializeRematch(lobby) {
    const recap = lobby.mode === "classic" ? lobby.game.getGameState().recap : null;
    const totalCount = Math.max(
      recap?.playerCount || lobby.players.size,
      lobby.rematchReadyParticipantIds.size
    );
    return {
      lobbyId: lobby.rematchLobbyId,
      readyCount: lobby.rematchReadyParticipantIds.size,
      totalCount,
      readyParticipantIds: Array.from(lobby.rematchReadyParticipantIds),
    };
  }

  function emitRematch(lobby) {
    io.to(lobby.lobbyId).emit("rematchUpdated", serializeRematch(lobby));
  }

  function createLobbyRecord(lobbyId, lobbyOptions = {}) {
    const mode = lobbyOptions.mode === "versus" ? "versus" : "classic";
    const game = mode === "versus" ? versusFactory() : gameFactory();
    const lobby = {
      lobbyId,
      mode,
      game,
      players: new Map(),
      identityAssignments: new Map(),
      nextColorIndex: 0,
      nextAvatarIndex: 0,
      typingPlayerIds: new Set(),
      rematchLobbyId: null,
      rematchReadyParticipantIds: new Set(),
      hostParticipantId: null,
      createdAt: nowIso(),
      lastActivityAt: nowIso(),
      lastActivityMs: Date.now(),
    };

    game.on("ready", (gameState) => {
      updateLobbyActivity(lobby);
      if (mode === "versus") {
        game.maybeStart(Array.from(lobby.players.values()));
        emitVersusState(lobby);
      }
      else io.to(lobbyId).emit("gameReady", gameState);
      recordEvent("lobby_ready", {
        lobbyId,
        mode,
        players: lobby.players.size,
      });
    });
    if (mode === "versus") {
      game.on("started", () => {
        lobby.typingPlayerIds.clear();
        emitTyping(lobby);
        emitVersusState(lobby);
        recordEvent("versus_started", { lobbyId, players: lobby.players.size });
      });
      game.on("teamFinished", (teamId) => {
        emitVersusState(lobby);
        recordEvent("versus_team_finished", { lobbyId, teamId });
      });
      game.on("complete", () => {
        lobby.typingPlayerIds.clear();
        emitTyping(lobby);
        emitVersusState(lobby);
        recordEvent("versus_complete", {
          lobbyId,
          winnerTeamId: game.getResult(Array.from(lobby.players.values()))?.winnerTeamId,
        });
      });
    }
    game.on("error", (error) => {
      io.to(lobbyId).emit("actionError", {
        code: "game_unavailable",
        message: "The semantic model could not be loaded.",
      });
      recordEvent("game_error", { lobbyId, message: error.message });
    });

    lobbies.set(lobbyId, lobby);
    return lobby;
  }

  function deleteLobby(lobbyId, reason) {
    const lobby = lobbies.get(lobbyId);
    if (!lobby) return;
    const playerCount = lobby.players.size;
    lobbies.delete(lobbyId);
    recordEvent("lobby_deleted", {
      lobbyId,
      reason,
      players: playerCount,
      activeRooms: lobbies.size,
      activePlayers: getActivePlayerCount(),
    });
  }

  function cleanupStaleLobbies() {
    const cutoff = Date.now() - limits.staleLobbyMs;
    for (const [lobbyId, lobby] of lobbies) {
      if (lobby.players.size === 0 && lobby.lastActivityMs < cutoff) {
        deleteLobby(lobbyId, "stale_empty");
      }
    }
  }

  function generateLobbyId(length = 6) {
    const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let result = "";
    do {
      result = Array.from(
        { length },
        () => characters[Math.floor(random() * characters.length)]
      ).join("");
    } while (lobbies.has(result));
    return result;
  }

  function addPlayer(lobby, socket, preferredName) {
    const requested = normalizePlayerName(preferredName);
    const name =
      requested && isNameAvailable(lobby, requested)
        ? requested
        : generatePlayerName(lobby, random);
    const activeColors = new Set(
      Array.from(lobby.players.values()).map((player) => player.colorIndex)
    );
    const colorKey = name.toLocaleLowerCase();
    const rememberedIdentity = lobby.identityAssignments.get(colorKey);
    let colorIndex = rememberedIdentity?.colorIndex;
    if (!Number.isInteger(colorIndex) || activeColors.has(colorIndex)) {
      colorIndex = lobby.nextColorIndex;
      for (let offset = 0; offset < PLAYER_COLOR_COUNT; offset += 1) {
        const candidate = (lobby.nextColorIndex + offset) % PLAYER_COLOR_COUNT;
        if (!activeColors.has(candidate)) {
          colorIndex = candidate;
          break;
        }
      }
    }
    lobby.nextColorIndex = (colorIndex + 1) % PLAYER_COLOR_COUNT;
    let avatarId = rememberedIdentity?.avatarId;
    if (
      !PLAYER_AVATAR_IDS.includes(avatarId) ||
      !isAvatarAvailable(lobby, avatarId)
    ) {
      for (let offset = 0; offset < PLAYER_AVATAR_IDS.length; offset += 1) {
        const index = (lobby.nextAvatarIndex + offset) % PLAYER_AVATAR_IDS.length;
        const candidate = PLAYER_AVATAR_IDS[index];
        if (isAvatarAvailable(lobby, candidate)) {
          avatarId = candidate;
          lobby.nextAvatarIndex = (index + 1) % PLAYER_AVATAR_IDS.length;
          break;
        }
      }
    }
    const participantId = rememberedIdentity?.participantId || crypto.randomUUID();
    const teamId = lobby.mode === "versus"
      ? rememberedIdentity?.teamId || lobby.game.assignTeam(Array.from(lobby.players.values()))
      : null;
    lobby.identityAssignments.set(colorKey, { colorIndex, avatarId, participantId, teamId });

    const player = {
      id: socket.id,
      participantId,
      name,
      joinedAt: nowIso(),
      colorIndex,
      avatarId,
      teamId,
      ready: false,
    };
    lobby.players.set(socket.id, player);
    if (!lobby.hostParticipantId) lobby.hostParticipantId = participantId;
    lobby.game.registerPlayer(player);
    socket.data.lobbyId = lobby.lobbyId;
    socket.join(lobby.lobbyId);
    updateLobbyActivity(lobby);
    return player;
  }

  function removePlayerFromCurrentLobby(socket) {
    const currentLobbyId = socket.data.lobbyId;
    if (!currentLobbyId) return;
    const lobby = lobbies.get(currentLobbyId);
    socket.data.lobbyId = null;
    socket.leave(currentLobbyId);
    const departingPlayer = lobby?.players.get(socket.id);
    if (!lobby || !departingPlayer || !lobby.players.delete(socket.id)) return;
    if (lobby.mode === "versus" && lobby.game.phase === "setup") {
      lobby.game.unregisterPlayer(departingPlayer);
    }
    if (
      departingPlayer.participantId === lobby.hostParticipantId &&
      !Array.from(lobby.players.values()).some(
        (player) => player.participantId === lobby.hostParticipantId
      )
    ) {
      lobby.hostParticipantId = lobby.players.values().next().value?.participantId || null;
    }
    if (lobby.mode === "versus") {
      lobby.game.maybeStart(Array.from(lobby.players.values()));
    }
    lobby.typingPlayerIds.delete(socket.id);
    updateLobbyActivity(lobby);
    emitPlayers(lobby);
    emitTyping(lobby);
    emitVersusState(lobby);
    recordEvent("lobby_left", {
      lobbyId: currentLobbyId,
      players: lobby.players.size,
      activeRooms: lobbies.size,
      activePlayers: getActivePlayerCount(),
    });
  }

  function lobbyPayload(lobby, socketId = null) {
    const player = socketId ? lobby.players.get(socketId) : null;
    const versus = lobby.mode === "versus" && player
      ? lobby.game.getView(
          player.teamId,
          Array.from(lobby.players.values()),
          lobby.hostParticipantId
        )
      : null;
    return {
      lobbyId: lobby.lobbyId,
      mode: lobby.mode,
      gameState: versus?.gameState || lobby.game.getGameState(),
      versus: versus ? { ...versus, gameState: undefined } : null,
      players: serializePlayers(lobby),
      playerCount: lobby.players.size,
      typingPlayerIds: Array.from(lobby.typingPlayerIds),
      rematch: lobby.game.status === "won" ? serializeRematch(lobby) : null,
    };
  }

  function getSocketLobby(socket, requestedLobbyId) {
    const lobbyId = normalizeLobbyId(
      requestedLobbyId || socket.data.lobbyId
    );
    if (!lobbyId || socket.data.lobbyId !== lobbyId) return null;
    const lobby = lobbies.get(lobbyId);
    return lobby && lobby.players.has(socket.id) ? lobby : null;
  }

  function emitActionError(socket, response) {
    socket.emit("actionError", {
      message: response.error,
      code: response.code,
      hintAvailableAt: response.hintAvailableAt || null,
    });
  }

  function replyToGuess(socket, acknowledge, response) {
    if (typeof acknowledge === "function") {
      acknowledge(response);
      return;
    }
    if (!response.ok) emitActionError(socket, response);
  }

  app.get("/health", (_req, res) => {
    const status = options.skipEmbeddingsBootstrap
      ? { ready: true, loading: false, error: null, file: "in-memory" }
      : embeddingsManager.getStatus();
    res
      .status(status.ready ? 200 : 503)
      .set("Cache-Control", "no-store")
      .json({ ok: status.ready, service: "neuronauts-be", ...status });
  });

  app.get("/stats", (_req, res) => {
    const rooms = Array.from(lobbies.values())
      .map((lobby) => ({
        lobbyId: lobby.lobbyId,
        players: lobby.players.size,
        status: lobby.mode === "versus" ? lobby.game.status : lobby.game.getGameState().status,
        mode: lobby.mode,
        createdAt: lobby.createdAt,
        lastActivityAt: lobby.lastActivityAt,
        idleMs: Date.now() - lobby.lastActivityMs,
      }))
      .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
    res.set("Cache-Control", "no-store").json({
      ok: true,
      serverTime: nowIso(),
      uptimeSeconds: Math.round(process.uptime()),
      limits,
      rooms: { active: rooms.length, list: rooms },
      players: { active: getActivePlayerCount() },
      lastEvent: recentEvents[0] || null,
      recentEvents,
      embeddings: options.skipEmbeddingsBootstrap
        ? { ready: true, loading: false, error: null, file: "in-memory" }
        : embeddingsManager.getStatus(),
    });
  });

  if (!options.skipEmbeddingsBootstrap) {
    embeddingsManager
      .getEmbeddings()
      .then(() =>
        recordEvent("embeddings_ready", {
          file: embeddingsManager.getStatus().file,
        })
      )
      .catch((error) => {
        console.error("Embeddings failed to load:", error.message);
        recordEvent("embeddings_error", { message: error.message });
      });
  }

  const cleanupTimer = setInterval(
    cleanupStaleLobbies,
    limits.cleanupIntervalMs
  );
  cleanupTimer.unref();

  io.on("connection", (socket) => {
    socket.data.lobbyId = null;
    socket.data.lastGuessAt = 0;

    socket.on("createLobby", (payload = {}) => {
      if (lobbies.size >= limits.maxLobbies) {
        socket.emit("error", "Server room capacity reached. Try again later.");
        return;
      }
      removePlayerFromCurrentLobby(socket);
      const lobbyId = generateLobbyId();
      const mode = payload?.mode === "versus" ? "versus" : "classic";
      const lobby = createLobbyRecord(lobbyId, { mode });
      addPlayer(lobby, socket, payload?.preferredName);
      const response = lobbyPayload(lobby, socket.id);
      socket.emit("lobbyCreated", response);
      emitPlayers(lobby);
      recordEvent("lobby_created", {
        lobbyId,
        mode,
        players: lobby.players.size,
        activeRooms: lobbies.size,
        activePlayers: getActivePlayerCount(),
      });
    });

    socket.on("joinLobby", (payload) => {
      const lobbyId = normalizeLobbyId(
        typeof payload === "string" ? payload : payload?.lobbyId
      );
      const preferredName =
        typeof payload === "object" ? payload?.preferredName : null;
      const lobby = lobbies.get(lobbyId);
      if (!lobby) {
        socket.emit("error", "Lobby does not exist.");
        return;
      }
      if (
        !lobby.players.has(socket.id) &&
        lobby.players.size >= limits.maxPlayersPerLobby
      ) {
        socket.emit("error", `Lobby ${lobbyId} is full.`);
        return;
      }

      if (socket.data.lobbyId !== lobbyId) {
        removePlayerFromCurrentLobby(socket);
        addPlayer(lobby, socket, preferredName);
      }
      socket.emit("lobbyJoined", lobbyPayload(lobby, socket.id));
      emitPlayers(lobby);
      emitVersusState(lobby);
      recordEvent("lobby_joined", {
        lobbyId,
        players: lobby.players.size,
        activeRooms: lobbies.size,
        activePlayers: getActivePlayerCount(),
      });
    });

    socket.on("setPlayerName", (payload = {}) => {
      const lobby = getSocketLobby(socket, payload.lobbyId);
      if (!lobby) {
        emitActionError(socket, {
          error: "Join the lobby before changing your name.",
          code: "not_in_lobby",
        });
        return;
      }
      const name = normalizePlayerName(payload.name);
      if (!name) {
        emitActionError(socket, {
          error: "Names must be 2–24 letters, numbers, spaces, apostrophes, periods, or hyphens.",
          code: "invalid_name",
        });
        return;
      }
      if (!isNameAvailable(lobby, name, socket.id)) {
        emitActionError(socket, {
          error: "That name is already taken in this lobby.",
          code: "duplicate_name",
        });
        return;
      }
      const player = lobby.players.get(socket.id);
      const previousName = player.name;
      player.name = name;
      lobby.identityAssignments.delete(previousName.toLocaleLowerCase());
      lobby.identityAssignments.set(name.toLocaleLowerCase(), {
        colorIndex: player.colorIndex,
        avatarId: player.avatarId,
        participantId: player.participantId,
        teamId: player.teamId,
      });
      lobby.game.registerPlayer(player);
      updateLobbyActivity(lobby);
      emitPlayers(lobby);
      emitVersusState(lobby);
      socket.emit("playerNameChanged", { name });
      recordEvent("player_renamed", {
        lobbyId: lobby.lobbyId,
        previousName,
        name,
      });
    });

    socket.on("setPlayerAvatar", (payload = {}) => {
      const lobby = getSocketLobby(socket, payload.lobbyId);
      if (!lobby) {
        emitActionError(socket, {
          error: "Join the lobby before changing your avatar.",
          code: "not_in_lobby",
        });
        return;
      }
      const avatarId = typeof payload.avatarId === "string" ? payload.avatarId : "";
      if (!PLAYER_AVATAR_IDS.includes(avatarId)) {
        emitActionError(socket, {
          error: "That avatar is not part of this crew roster.",
          code: "invalid_avatar",
        });
        return;
      }
      if (!isAvatarAvailable(lobby, avatarId, socket.id)) {
        emitActionError(socket, {
          error: "That avatar is already claimed. Pick another one.",
          code: "avatar_taken",
        });
        return;
      }

      const player = lobby.players.get(socket.id);
      player.avatarId = avatarId;
      lobby.identityAssignments.set(player.name.toLocaleLowerCase(), {
        colorIndex: player.colorIndex,
        avatarId,
        participantId: player.participantId,
        teamId: player.teamId,
      });
      lobby.game.registerPlayer(player);
      updateLobbyActivity(lobby);
      emitPlayers(lobby);
      emitVersusState(lobby);
      socket.emit("playerAvatarChanged", { avatarId });
      recordEvent("player_avatar_changed", {
        lobbyId: lobby.lobbyId,
        playerName: player.name,
        avatarId,
      });
    });

    socket.on("setTeam", (payload = {}) => {
      const lobby = getSocketLobby(socket, payload.lobbyId);
      if (!lobby || lobby.mode !== "versus") {
        emitActionError(socket, {
          error: "Join a VS lobby before choosing a side.",
          code: "not_in_versus_lobby",
        });
        return;
      }
      const player = lobby.players.get(socket.id);
      const response = lobby.game.setTeam(player, payload.teamId);
      if (!response.ok) {
        emitActionError(socket, response);
        return;
      }
      lobby.identityAssignments.set(player.name.toLocaleLowerCase(), {
        colorIndex: player.colorIndex,
        avatarId: player.avatarId,
        participantId: player.participantId,
        teamId: player.teamId,
      });
      updateLobbyActivity(lobby);
      emitPlayers(lobby);
      emitVersusState(lobby);
      recordEvent("versus_team_changed", {
        lobbyId: lobby.lobbyId,
        playerName: player.name,
        teamId: player.teamId,
      });
    });

    socket.on("randomizeTeams", (payload = {}) => {
      const lobby = getSocketLobby(socket, payload.lobbyId);
      if (!lobby || lobby.mode !== "versus") {
        emitActionError(socket, {
          error: "Join a VS lobby before randomizing teams.",
          code: "not_in_versus_lobby",
        });
        return;
      }
      const player = lobby.players.get(socket.id);
      if (player.participantId !== lobby.hostParticipantId) {
        emitActionError(socket, {
          error: "Only the lobby host can randomize teams.",
          code: "host_only",
        });
        return;
      }
      const response = lobby.game.randomizeTeams(Array.from(lobby.players.values()));
      if (!response.ok) {
        emitActionError(socket, response);
        return;
      }
      for (const teammate of lobby.players.values()) {
        const identity = lobby.identityAssignments.get(teammate.name.toLocaleLowerCase());
        if (identity) identity.teamId = teammate.teamId;
      }
      updateLobbyActivity(lobby);
      emitPlayers(lobby);
      emitVersusState(lobby);
      recordEvent("versus_teams_randomized", { lobbyId: lobby.lobbyId });
    });

    socket.on("toggleReady", (payload = {}) => {
      const lobby = getSocketLobby(socket, payload.lobbyId);
      if (!lobby || lobby.mode !== "versus") {
        emitActionError(socket, {
          error: "Join a VS lobby before readying up.",
          code: "not_in_versus_lobby",
        });
        return;
      }
      const player = lobby.players.get(socket.id);
      const response = lobby.game.toggleReady(
        player,
        Array.from(lobby.players.values())
      );
      if (!response.ok) {
        emitActionError(socket, response);
        return;
      }
      updateLobbyActivity(lobby);
      emitPlayers(lobby);
      emitVersusState(lobby);
      recordEvent("versus_ready_changed", {
        lobbyId: lobby.lobbyId,
        playerName: player.name,
        ready: player.ready,
      });
    });

    socket.on("typing", (payload = {}) => {
      const lobby = getSocketLobby(socket, payload.lobbyId);
      if (!lobby) return;
      const wasTyping = lobby.typingPlayerIds.has(socket.id);
      const isTyping = payload.isTyping === true && lobby.game.status === "playing";
      if (wasTyping === isTyping) return;
      if (isTyping) lobby.typingPlayerIds.add(socket.id);
      else lobby.typingPlayerIds.delete(socket.id);
      emitTyping(lobby);
    });

    socket.on("guess", (payload = {}, acknowledge) => {
      const lobby = getSocketLobby(socket, payload.lobbyId);
      if (!lobby) {
        replyToGuess(socket, acknowledge, {
          ok: false,
          error: "Join the lobby before guessing.",
          code: "not_in_lobby",
        });
        return;
      }
      const now = Date.now();
      if (now - socket.data.lastGuessAt < limits.guessRateLimitMs) {
        replyToGuess(socket, acknowledge, {
          ok: false,
          error: "Easy, explorer—wait a moment before guessing again.",
          code: "guess_rate_limited",
        });
        return;
      }
      socket.data.lastGuessAt = now;
      const player = lobby.players.get(socket.id);
      if (lobby.typingPlayerIds.delete(socket.id)) emitTyping(lobby);
      const response = lobby.game.handleGuess(payload.guess, player);
      if (!response.ok) {
        replyToGuess(socket, acknowledge, response);
        return;
      }
      updateLobbyActivity(lobby);
      replyToGuess(socket, acknowledge, response);
      if (lobby.mode === "versus") {
        if (response.result.correct) {
          for (const teammate of lobby.players.values()) {
            if (teammate.teamId === player.teamId) {
              lobby.typingPlayerIds.delete(teammate.id);
            }
          }
          emitTyping(lobby);
        }
        emitVersusState(lobby);
      } else {
        io.to(lobby.lobbyId).emit("guessResult", response.result);
        if (response.result.correct) {
          lobby.typingPlayerIds.clear();
          emitTyping(lobby);
          io.to(lobby.lobbyId).emit("gameWon", lobby.game.getGameState());
        }
      }
      recordEvent(response.result.correct ? "word_solved" : "guess_made", {
        lobbyId: lobby.lobbyId,
        playerName: player.name,
        teamId: player.teamId || undefined,
        guesses: lobby.mode === "versus"
          ? lobby.game.games.get(player.teamId).guessHistory.length
          : lobby.game.getGameState().guessHistory.length,
      });
    });

    socket.on("requestHint", (payload = {}) => {
      const lobby = getSocketLobby(socket, payload.lobbyId);
      if (!lobby) {
        emitActionError(socket, {
          error: "Join the lobby before requesting a hint.",
          code: "not_in_lobby",
        });
        return;
      }
      const player = lobby.players.get(socket.id);
      const response = lobby.game.requestHint(player);
      if (!response.ok) {
        emitActionError(socket, response);
        return;
      }
      updateLobbyActivity(lobby);
      if (lobby.mode === "versus") {
        emitVersusState(lobby);
        for (const teammate of lobby.players.values()) {
          if (teammate.teamId === player.teamId) {
            io.to(teammate.id).emit("hintCooldown", {
              hintAvailableAt: response.hintAvailableAt,
            });
          }
        }
      } else {
        io.to(lobby.lobbyId).emit("guessResult", {
          ...response.result,
          hintAvailableAt: response.hintAvailableAt,
        });
        io.to(lobby.lobbyId).emit("hintCooldown", {
          hintAvailableAt: response.hintAvailableAt,
        });
      }
      recordEvent("hint_used", {
        lobbyId: lobby.lobbyId,
        playerName: player.name,
        teamId: player.teamId || undefined,
        hintFrom: response.result.hintFrom,
      });
    });

    socket.on("requestRematch", (payload = {}) => {
      const sourceLobby = getSocketLobby(socket, payload.lobbyId);
      if (!sourceLobby) {
        emitActionError(socket, {
          error: "Join the finished mission before playing again.",
          code: "not_in_lobby",
        });
        return;
      }
      if (sourceLobby.game.status !== "won") {
        emitActionError(socket, {
          error: "Finish this mission before starting the next one.",
          code: "game_not_won",
        });
        return;
      }

      if (
        !sourceLobby.rematchLobbyId ||
        !lobbies.has(sourceLobby.rematchLobbyId)
      ) {
        if (lobbies.size >= limits.maxLobbies) {
          emitActionError(socket, {
            error: "Server room capacity reached. Try again later.",
            code: "lobby_capacity",
          });
          return;
        }
        sourceLobby.rematchLobbyId = generateLobbyId();
        sourceLobby.rematchReadyParticipantIds.clear();
        createLobbyRecord(sourceLobby.rematchLobbyId, { mode: sourceLobby.mode });
      }

      const player = sourceLobby.players.get(socket.id);
      const wasReady = sourceLobby.rematchReadyParticipantIds.has(
        player.participantId
      );
      sourceLobby.rematchReadyParticipantIds.add(player.participantId);
      updateLobbyActivity(sourceLobby);
      const rematch = serializeRematch(sourceLobby);
      emitRematch(sourceLobby);
      socket.emit("rematchReady", {
        lobbyId: sourceLobby.rematchLobbyId,
        rematch,
      });
      if (!wasReady) {
        recordEvent("rematch_requested", {
          lobbyId: sourceLobby.lobbyId,
          rematchLobbyId: sourceLobby.rematchLobbyId,
          playerName: player.name,
          ready: rematch.readyCount,
          total: rematch.totalCount,
        });
      }
    });

    socket.on("disconnect", () => removePlayerFromCurrentLobby(socket));
  });

  async function start(port = DEFAULT_PORT, host) {
    if (server.listening) return server.address();
    await new Promise((resolve) =>
      host ? server.listen(port, host, resolve) : server.listen(port, resolve)
    );
    const address = server.address();
    console.log(
      `Neuronauts server listening on port ${
        typeof address === "object" ? address.port : port
      }`
    );
    return address;
  }

  async function stop() {
    clearInterval(cleanupTimer);
    await new Promise((resolve) => io.close(resolve));
    if (server.listening) {
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  }

  return { app, server, io, lobbies, start, stop, cleanupStaleLobbies };
}

if (require.main === module) {
  const runtime = createGameServer();
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}; closing connections gracefully.`);
    const forcedExit = setTimeout(() => {
      console.error("Graceful shutdown timed out.");
      process.exit(1);
    }, 10_000);
    forcedExit.unref();
    try {
      await runtime.stop();
      clearTimeout(forcedExit);
      process.exit(0);
    } catch (error) {
      console.error("Graceful shutdown failed:", error);
      process.exit(1);
    }
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
  runtime.start().catch((error) => {
    console.error("Failed to start Neuronauts:", error);
    process.exitCode = 1;
  });
}

module.exports = { createGameServer, normalizePlayerName };
