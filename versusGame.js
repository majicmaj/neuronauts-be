const EventEmitter = require("events");

const TEAM_IDS = ["red", "blue"];
const TEAM_LABELS = {
  red: "Red Shift",
  blue: "Blue Orbit",
};
const GUESS_PENALTY_SECONDS = 2;
const HINT_PENALTY_SECONDS = 60;

function otherTeam(teamId) {
  return teamId === "red" ? "blue" : "red";
}

function gradeForScore(score) {
  if (score <= 240) return "S";
  if (score <= 480) return "A";
  if (score <= 780) return "B";
  if (score <= 1_200) return "C";
  return "D";
}

function summarizeHistory(game, players, nowMs) {
  if (!game) {
    return {
      guessCount: 0,
      hintCount: 0,
      averageSimilarity: null,
      bestSimilarity: null,
      elapsedSeconds: null,
      finishedAt: null,
      foundBy: null,
      score: null,
      grade: null,
      playerStats: players.map((player) => ({
        playerId: player.participantId,
        playerName: player.name,
        avatarId: player.avatarId || null,
        guessCount: 0,
        hintCount: 0,
        averageSimilarity: null,
        bestSimilarity: null,
      })),
    };
  }
  const guesses = game.guessHistory.filter((guess) => !guess.isHint);
  const hints = game.guessHistory.filter((guess) => guess.isHint);
  const totalSimilarity = guesses.reduce((sum, guess) => sum + guess.similarity, 0);
  const best = guesses.reduce(
    (current, guess) => (!current || guess.similarity > current.similarity ? guess : current),
    null
  );
  const byParticipant = new Map();

  for (const participant of game.participants.values()) {
    byParticipant.set(participant.playerId, {
      playerId: participant.playerId,
      playerName: participant.playerName,
      avatarId: participant.avatarId || null,
      guessCount: 0,
      hintCount: 0,
      averageSimilarity: null,
      bestSimilarity: null,
      _total: 0,
    });
  }

  for (const player of players) {
    const playerId = player.participantId;
    const existing = byParticipant.get(playerId);
    byParticipant.set(playerId, {
      playerId: player.participantId,
      playerName: player.name,
      avatarId: player.avatarId || null,
      guessCount: existing?.guessCount || 0,
      hintCount: existing?.hintCount || 0,
      averageSimilarity: existing?.averageSimilarity ?? null,
      bestSimilarity: existing?.bestSimilarity ?? null,
      _total: existing?._total || 0,
    });
  }

  for (const guess of game.guessHistory) {
    const stats = byParticipant.get(guess.playerId);
    if (!stats) continue;
    if (guess.isHint) {
      stats.hintCount += 1;
      continue;
    }
    stats.guessCount += 1;
    stats._total += guess.similarity;
    stats.bestSimilarity = Math.max(stats.bestSimilarity ?? 0, guess.similarity);
  }

  const playerStats = Array.from(byParticipant.values()).map((stats) => {
    const { _total, ...publicStats } = stats;
    return {
      ...publicStats,
      averageSimilarity: stats.guessCount ? _total / stats.guessCount : null,
    };
  });

  const startedMs = game.startedAt ? Date.parse(game.startedAt) : null;
  const finishedMs = game.solvedAt ? Date.parse(game.solvedAt) : null;
  const elapsedSeconds = startedMs === null
    ? null
    : Math.max(0, Math.round(((finishedMs ?? nowMs) - startedMs) / 1_000));
  const score = finishedMs === null
    ? null
    : elapsedSeconds + guesses.length * GUESS_PENALTY_SECONDS + hints.length * HINT_PENALTY_SECONDS;

  return {
    guessCount: guesses.length,
    hintCount: hints.length,
    averageSimilarity: guesses.length ? totalSimilarity / guesses.length : null,
    bestSimilarity: best?.similarity ?? null,
    elapsedSeconds,
    finishedAt: game.solvedAt,
    foundBy: game.winner,
    score,
    grade: score === null ? null : gradeForScore(score),
    playerStats,
  };
}

class VersusGame extends EventEmitter {
  constructor(options = {}) {
    super();
    this.gameFactory = options.gameFactory;
    this.now = options.now || Date.now;
    this.random = options.random || Math.random;
    this.games = new Map();
    this.status = "loading";
    this.phase = "setup";
    this.startedAt = null;
    this.completedAt = null;
    this.firstFinishTeamId = null;
    this.readyTeams = new Set();
    this.createTeamGame("red");
  }

  createTeamGame(teamId, targetWord) {
    const game = this.gameFactory(targetWord ? { targetWord } : {});
    this.games.set(teamId, game);
    game.on("ready", () => {
      this.readyTeams.add(teamId);
      if (teamId === "red" && !this.games.has("blue")) {
        this.createTeamGame("blue", game.targetWord);
      }
      if (this.readyTeams.size === TEAM_IDS.length) {
        this.status = "setup";
        this.emit("ready");
        this.maybeStart();
      }
    });
    game.on("error", (error) => {
      this.status = "error";
      this.emit("error", error);
    });
    return game;
  }

  registerPlayer(player) {
    if (!TEAM_IDS.includes(player?.teamId)) return null;
    return this.games.get(player.teamId)?.registerPlayer(player) || null;
  }

  unregisterPlayer(player) {
    if (!TEAM_IDS.includes(player?.teamId)) return false;
    return this.games.get(player.teamId)?.unregisterPlayer(player) || false;
  }

  assignTeam(players) {
    const counts = { red: 0, blue: 0 };
    for (const player of players) {
      if (TEAM_IDS.includes(player.teamId)) counts[player.teamId] += 1;
    }
    if (counts.red === counts.blue) return this.random() < 0.5 ? "red" : "blue";
    return counts.red < counts.blue ? "red" : "blue";
  }

  setTeam(player, teamId) {
    if (this.phase !== "setup") return { ok: false, code: "match_started", error: "Teams are locked after launch." };
    if (!TEAM_IDS.includes(teamId)) return { ok: false, code: "invalid_team", error: "Choose Red Shift or Blue Orbit." };
    if (player.teamId === teamId) return { ok: true, changed: false };
    this.unregisterPlayer(player);
    player.teamId = teamId;
    player.ready = false;
    this.registerPlayer(player);
    return { ok: true, changed: true };
  }

  randomizeTeams(players) {
    if (this.phase !== "setup") return { ok: false, code: "match_started", error: "Teams are locked after launch." };
    const shuffled = [...players];
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(this.random() * (index + 1));
      [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
    }
    shuffled.forEach((player, index) => {
      this.unregisterPlayer(player);
      player.teamId = TEAM_IDS[index % TEAM_IDS.length];
      player.ready = false;
      this.registerPlayer(player);
    });
    return { ok: true };
  }

  toggleReady(player, players) {
    if (this.phase !== "setup") return { ok: false, code: "match_started", error: "The match has already launched." };
    player.ready = !player.ready;
    const started = this.maybeStart(players);
    return { ok: true, ready: player.ready, started };
  }

  maybeStart(players = []) {
    if (this.phase !== "setup" || this.readyTeams.size !== TEAM_IDS.length) return false;
    if (players.length < 2 || players.some((player) => !player.ready)) return false;
    if (TEAM_IDS.some((teamId) => !players.some((player) => player.teamId === teamId))) return false;
    const startedAt = new Date(this.now()).toISOString();
    for (const game of this.games.values()) game.beginAt(startedAt);
    this.startedAt = startedAt;
    this.phase = "playing";
    this.status = "playing";
    this.emit("started");
    return true;
  }

  handleGuess(rawGuess, player) {
    if (this.phase !== "playing") {
      return { ok: false, code: this.phase === "complete" ? "game_won" : "match_not_started", error: this.phase === "complete" ? "Both teams have finished." : "Ready up before transmitting guesses." };
    }
    const game = this.games.get(player.teamId);
    if (!game) return { ok: false, code: "invalid_team", error: "Choose a team before guessing." };
    const response = game.handleGuess(rawGuess, player);
    if (response.ok && response.result.correct) this.recordFinish(player.teamId);
    return response;
  }

  requestHint(player) {
    if (this.phase !== "playing") {
      return { ok: false, code: "match_not_started", error: "Ready up before calling the navigator." };
    }
    const game = this.games.get(player.teamId);
    if (!game) return { ok: false, code: "invalid_team", error: "Choose a team before requesting a hint." };
    return game.requestHint(player);
  }

  recordFinish(teamId) {
    if (!this.firstFinishTeamId) this.firstFinishTeamId = teamId;
    if (TEAM_IDS.every((id) => this.games.get(id)?.status === "won")) {
      this.phase = "complete";
      this.status = "won";
      this.completedAt = new Date(this.now()).toISOString();
      this.emit("complete");
    } else {
      this.emit("teamFinished", teamId);
    }
  }

  getTeamSummary(teamId, players, nowMs = this.now()) {
    const teamPlayers = players.filter((player) => player.teamId === teamId);
    return {
      id: teamId,
      label: TEAM_LABELS[teamId],
      status: this.games.get(teamId)?.status === "won"
        ? "finished"
        : this.phase === "setup" ? "setup" : "playing",
      readyCount: teamPlayers.filter((player) => player.ready).length,
      playerCount: teamPlayers.length,
      ...summarizeHistory(this.games.get(teamId), teamPlayers, nowMs),
    };
  }

  getResult(players) {
    if (this.phase !== "complete") return null;
    const standings = TEAM_IDS.map((teamId) => this.getTeamSummary(teamId, players));
    standings.sort((a, b) =>
      a.score - b.score ||
      a.hintCount - b.hintCount ||
      a.guessCount - b.guessCount ||
      a.elapsedSeconds - b.elapsedSeconds ||
      TEAM_IDS.indexOf(a.id) - TEAM_IDS.indexOf(b.id)
    );
    return {
      winnerTeamId: standings[0].id,
      loserTeamId: standings[1].id,
      standings,
      targetWord: this.games.get("red").targetWord,
      scoring: {
        guessPenaltySeconds: GUESS_PENALTY_SECONDS,
        hintPenaltySeconds: HINT_PENALTY_SECONDS,
      },
    };
  }

  getView(teamId, players, hostParticipantId) {
    const ownGame = this.games.get(teamId);
    const opponentId = otherTeam(teamId);
    const opponentGame = this.games.get(opponentId);
    const gameState = ownGame?.getGameState() || {
      status: "loading",
      targetLength: 0,
      guessHistory: [],
      startedAt: null,
      solvedAt: null,
      winner: null,
      hintAvailableAt: null,
      error: null,
      recap: null,
    };
    if (this.phase === "setup") gameState.status = this.status === "loading" ? "loading" : "setup";
    if (this.phase === "playing" && ownGame?.status === "won") gameState.status = "team-finished";
    if (this.phase === "complete") gameState.status = "won";

    return {
      phase: this.phase,
      teamId,
      hostParticipantId,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
      firstFinishTeamId: this.firstFinishTeamId,
      canStart: players.length >= 2 && TEAM_IDS.every((id) => players.some((player) => player.teamId === id)),
      readyCount: players.filter((player) => player.ready).length,
      totalCount: players.length,
      teams: TEAM_IDS.map((id) => this.getTeamSummary(id, players)),
      opponentPoints: (opponentGame?.guessHistory || []).map((guess) => ({
        id: guess.id,
        teamId: opponentId,
        playerId: guess.playerId,
        similarity: guess.similarity,
        position: guess.position,
        isHint: guess.isHint,
        createdAt: guess.createdAt,
      })),
      result: this.getResult(players),
      scoring: {
        guessPenaltySeconds: GUESS_PENALTY_SECONDS,
        hintPenaltySeconds: HINT_PENALTY_SECONDS,
      },
      gameState,
    };
  }
}

module.exports = VersusGame;
module.exports.TEAM_IDS = TEAM_IDS;
module.exports.GUESS_PENALTY_SECONDS = GUESS_PENALTY_SECONDS;
module.exports.HINT_PENALTY_SECONDS = HINT_PENALTY_SECONDS;
