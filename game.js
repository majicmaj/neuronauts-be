const EventEmitter = require("events");
const crypto = require("crypto");
const embeddingsManager = require("./utils/embeddingsManager");
const defaultCommonWords = require("./words.json");

const DEFAULT_HINT_COOLDOWN_MS = 60_000;
const DEFAULT_HISTORY_LIMIT = 1_000;
const MAX_GUESS_LENGTH = 40;

function normalizeVector(vector) {
  let magnitudeSquared = 0;
  for (const value of vector) magnitudeSquared += value * value;
  const magnitude = Math.sqrt(magnitudeSquared);
  if (!magnitude) return vector.map(() => 0);
  return vector.map((value) => value / magnitude);
}

function hashSeed(value) {
  const digest = crypto.createHash("sha256").update(value).digest();
  return digest.readUInt32LE(0) || 1;
}

function makeProjectionAxes(seedValue, dimensions) {
  let seed = hashSeed(seedValue);
  const random = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 0xffffffff;
  };

  const x = normalizeVector(
    Array.from({ length: dimensions }, () => random() * 2 - 1)
  );
  const yCandidate = Array.from(
    { length: dimensions },
    () => random() * 2 - 1
  );

  let projection = 0;
  for (let i = 0; i < dimensions; i += 1) projection += yCandidate[i] * x[i];
  const y = normalizeVector(
    yCandidate.map((value, index) => value - projection * x[index])
  );

  return { x, y };
}

function normalizeGuess(rawGuess) {
  if (typeof rawGuess !== "string") return null;
  const guess = rawGuess.trim().toLowerCase().replace(/\s+/g, " ");
  if (!guess || guess.length > MAX_GUESS_LENGTH || guess.includes(" ")) return null;
  if (!/^[\p{L}\p{N}][\p{L}\p{N}'-]*$/u.test(guess)) return null;
  return guess;
}

class Game extends EventEmitter {
  constructor(options = {}) {
    super();
    this.targetWord = null;
    this.targetEmbedding = null;
    this.normalizedTargetEmbedding = null;
    this.guessHistory = [];
    this.guessedWords = new Set();
    this.embeddings = null;
    this.status = "loading";
    this.error = null;
    this.startedAt = null;
    this.solvedAt = null;
    this.winner = null;
    this.hintAvailableAt = null;
    this.sequence = 0;
    this.axes = null;
    this.referenceRanking = [];
    this.referenceRankByWord = new Map();
    this.rankedWordCount = 0;
    this.participants = new Map();

    this.commonWords = options.commonWords || defaultCommonWords;
    this.forcedTargetWord = options.targetWord || null;
    this.random = options.random || Math.random;
    this.now = options.now || Date.now;
    this.hintCooldownMs =
      options.hintCooldownMs ?? DEFAULT_HINT_COOLDOWN_MS;
    this.historyLimit = options.historyLimit || DEFAULT_HISTORY_LIMIT;

    const embeddingsPromise = options.embeddings
      ? Promise.resolve(options.embeddings)
      : embeddingsManager.getEmbeddings();

    embeddingsPromise
      .then((embeddings) => this.initialize(embeddings))
      .catch((error) => {
        this.status = "error";
        this.error = "The semantic model could not be loaded.";
        console.error("Error initializing game:", error);
        this.emit("error", error);
      });
  }

  initialize(embeddings) {
    this.embeddings = embeddings;
    this.targetWord = this.selectTargetWord();
    this.targetEmbedding = this.getEmbedding(this.targetWord);

    if (!this.targetEmbedding) {
      throw new Error("No eligible target word has an embedding.");
    }

    this.normalizedTargetEmbedding = normalizeVector(this.targetEmbedding);
    this.buildReferenceRanking();
    this.axes = makeProjectionAxes(
      `neuronauts:${this.targetWord}`,
      this.targetEmbedding.length
    );
    this.status = "playing";
    this.startedAt = new Date(this.now()).toISOString();
    this.emit("ready", this.getGameState());
  }

  selectTargetWord() {
    if (this.forcedTargetWord) {
      const forced = normalizeGuess(this.forcedTargetWord);
      if (forced && this.getEmbedding(forced)) return forced;
      throw new Error(`Forced target word is unavailable: ${this.forcedTargetWord}`);
    }

    const maxAttempts = Math.max(100, this.commonWords.length * 2);
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const index = Math.floor(this.random() * this.commonWords.length);
      const word = normalizeGuess(this.commonWords[index]);
      if (word && this.getEmbedding(word)) return word;
    }

    return this.commonWords.find((word) => this.getEmbedding(word)) || null;
  }

  getEmbedding(word) {
    return this.embeddings && word
      ? this.embeddings[word.toLowerCase()] || null
      : null;
  }

  cosineSimilarity(vecA, vecB) {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < vecA.length; i += 1) {
      dot += vecA[i] * vecB[i];
      normA += vecA[i] ** 2;
      normB += vecB[i] ** 2;
    }
    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    return denominator ? dot / denominator : 0;
  }

  buildReferenceRanking() {
    const seen = new Set();
    this.referenceRanking = [];

    for (const rawWord of this.commonWords) {
      const word = normalizeGuess(rawWord);
      if (!word || seen.has(word)) continue;
      seen.add(word);
      const embedding = this.getEmbedding(word);
      if (!embedding) continue;
      this.referenceRanking.push({
        word,
        cosineSimilarity: this.cosineSimilarity(
          this.targetEmbedding,
          embedding
        ),
      });
    }

    this.referenceRanking.sort((a, b) => {
      const difference = b.cosineSimilarity - a.cosineSimilarity;
      if (difference) return difference;
      if (a.word === this.targetWord) return -1;
      if (b.word === this.targetWord) return 1;
      return a.word.localeCompare(b.word);
    });
    this.referenceRankByWord = new Map(
      this.referenceRanking.map((entry, index) => [entry.word, index + 1])
    );
    this.rankedWordCount = this.referenceRanking.length;
  }

  getRank(word, cosineSimilarity) {
    const knownRank = this.referenceRankByWord.get(word);
    if (knownRank) return knownRank;

    let low = 0;
    let high = this.referenceRanking.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (this.referenceRanking[middle].cosineSimilarity > cosineSimilarity) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return Math.max(1, Math.min(this.rankedWordCount, low + 1));
  }

  getScoreForRank(rank) {
    if (this.rankedWordCount <= 1) return rank === 1 ? 1 : 0;
    const boundedRank = Math.max(1, Math.min(this.rankedWordCount, rank));
    return 1 - (boundedRank - 1) / (this.rankedWordCount - 1);
  }

  getPosition(embedding, similarity, word) {
    const normalized = normalizeVector(embedding);
    let projectedX = 0;
    let projectedY = 0;

    for (let i = 0; i < normalized.length; i += 1) {
      const difference = normalized[i] - this.normalizedTargetEmbedding[i];
      projectedX += difference * this.axes.x[i];
      projectedY += difference * this.axes.y[i];
    }

    let projectedMagnitude = Math.hypot(projectedX, projectedY);
    if (projectedMagnitude < 1e-8) {
      const angle = (hashSeed(word) / 0xffffffff) * Math.PI * 2;
      projectedX = Math.cos(angle);
      projectedY = Math.sin(angle);
      projectedMagnitude = 1;
    }

    // The radial scale matches the displayed rank percentile: a 50% word sits
    // halfway between the outer boundary and the 100% target. The seeded
    // projection still supplies a stable semantic direction in the square.
    const rankDistance = Math.max(0, Math.min(1, 1 - similarity));
    const radius = rankDistance * 0.44;

    return {
      x: Number((0.5 + (projectedX / projectedMagnitude) * radius).toFixed(4)),
      y: Number((0.5 - (projectedY / projectedMagnitude) * radius).toFixed(4)),
    };
  }

  makeError(message, code) {
    return { ok: false, error: message, code };
  }

  registerPlayer(player) {
    if (!player) return null;
    const playerId = player.participantId || player.id;
    if (!playerId) return null;
    const previous = this.participants.get(playerId);
    const participant = {
      playerId,
      playerName: player.name || previous?.playerName || "Unknown Neuronaut",
      colorIndex: Number.isInteger(player.colorIndex)
        ? player.colorIndex
        : previous?.colorIndex || 0,
      avatarId: player.avatarId || previous?.avatarId || null,
      joinedAt: player.joinedAt || previous?.joinedAt || new Date(this.now()).toISOString(),
    };
    this.participants.set(playerId, participant);
    return participant;
  }

  makeResult({ word, embedding, player, isHint = false, hintFrom = null }) {
    const participant = this.registerPlayer(player);
    const cosineSimilarity = this.cosineSimilarity(
      this.targetEmbedding,
      embedding
    );
    const rank = word === this.targetWord
      ? 1
      : this.getRank(word, cosineSimilarity);
    const similarity = this.getScoreForRank(rank);
    const createdAt = new Date(this.now()).toISOString();
    const correct = word === this.targetWord;
    const result = {
      id: `${createdAt}-${this.sequence += 1}`,
      guess: word,
      similarity,
      cosineSimilarity,
      rank,
      rankedWordCount: this.rankedWordCount,
      correct,
      isHint,
      hintFrom,
      playerId: participant?.playerId || player.id,
      playerName: participant?.playerName || player.name,
      colorIndex: participant?.colorIndex || 0,
      avatarId: participant?.avatarId || null,
      createdAt,
      position: this.getPosition(embedding, similarity, word),
    };

    if (correct) {
      this.status = "won";
      this.solvedAt = createdAt;
      this.winner = {
        playerId: participant?.playerId || player.id,
        playerName: participant?.playerName || player.name,
      };
      result.targetWord = this.targetWord;
    }

    this.guessedWords.add(word);
    this.guessHistory.push(result);
    if (this.guessHistory.length > this.historyLimit) this.guessHistory.shift();
    return { ok: true, result };
  }

  handleGuess(rawGuess, player) {
    if (this.status === "loading") {
      return this.makeError(
        "The semantic model is still loading. Try again in a moment.",
        "game_loading"
      );
    }
    if (this.status === "error") {
      return this.makeError(this.error, "game_unavailable");
    }
    if (this.status === "won") {
      return this.makeError("This word has already been found.", "game_won");
    }

    const word = normalizeGuess(rawGuess);
    if (!word) {
      return this.makeError("Enter one dictionary word.", "invalid_guess");
    }
    if (this.guessedWords.has(word)) {
      return this.makeError(`“${word}” has already been guessed.`, "duplicate_guess");
    }

    const embedding = this.getEmbedding(word);
    if (!embedding) {
      return this.makeError("That word is not in the dictionary.", "unknown_word");
    }

    return this.makeResult({ word, embedding, player });
  }

  getBestGuess() {
    return this.guessHistory.reduce((best, guess) => {
      if (guess.similarity === null || guess.correct) return best;
      return !best || guess.similarity > best.similarity ? guess : best;
    }, null);
  }

  findHalfwayWord(bestGuess) {
    const bestEmbedding = normalizeVector(this.getEmbedding(bestGuess.guess));
    const desiredRank = (bestGuess.rank + 1) / 2;
    const ideal = normalizeVector(
      bestEmbedding.map(
        (value, index) => value + this.normalizedTargetEmbedding[index]
      )
    );

    const candidates = [];
    let bestRankError = Infinity;

    for (let index = 0; index < this.referenceRanking.length; index += 1) {
      const { word } = this.referenceRanking[index];
      const rank = index + 1;
      if (
        word === this.targetWord ||
        this.guessedWords.has(word) ||
        rank >= bestGuess.rank
      ) {
        continue;
      }
      const embedding = this.getEmbedding(word);
      const rankError = Math.abs(rank - desiredRank);
      bestRankError = Math.min(bestRankError, rankError);
      candidates.push({
        word,
        embedding,
        rankError,
        pathAlignment: this.cosineSimilarity(
          ideal,
          normalizeVector(embedding)
        ),
      });
    }

    if (!candidates.length) return null;

    // Rank distance is the displayed linear scale, so it stays primary. Only
    // equally close ranks use semantic path alignment as the tie-breaker.
    return candidates
      .filter((candidate) => candidate.rankError === bestRankError)
      .reduce((selected, candidate) => {
        if (!selected || candidate.pathAlignment > selected.pathAlignment) {
          return candidate;
        }
        return selected;
      }, null);
  }

  requestHint(player) {
    if (this.status !== "playing") {
      return this.makeError(
        this.status === "won"
          ? "This word has already been found."
          : "The game is not ready for a hint yet.",
        this.status === "won" ? "game_won" : "game_loading"
      );
    }

    const now = this.now();
    if (this.hintAvailableAt && now < this.hintAvailableAt) {
      return {
        ...this.makeError("The shared hint is cooling down.", "hint_cooldown"),
        hintAvailableAt: new Date(this.hintAvailableAt).toISOString(),
      };
    }

    const bestGuess = this.getBestGuess();
    if (!bestGuess) {
      return this.makeError(
        "Make a valid guess before asking the navigator for a hint.",
        "hint_needs_guess"
      );
    }

    const halfway = this.findHalfwayWord(bestGuess);
    if (!halfway) {
      return this.makeError(
        "No unused halfway word could be found.",
        "hint_unavailable"
      );
    }

    this.hintAvailableAt = now + this.hintCooldownMs;
    const response = this.makeResult({
      word: halfway.word,
      embedding: halfway.embedding,
      player,
      isHint: true,
      hintFrom: bestGuess.guess,
    });
    response.hintAvailableAt = new Date(this.hintAvailableAt).toISOString();
    return response;
  }

  pickAwardCopy(awardId, playerId, options) {
    const index = hashSeed(`${this.targetWord}:${awardId}:${playerId}`) % options.length;
    return options[index];
  }

  buildRecap() {
    if (this.status !== "won") return null;

    const statsByPlayer = new Map();
    const ensureStats = (participant) => {
      const playerId = participant.playerId;
      if (!statsByPlayer.has(playerId)) {
        statsByPlayer.set(playerId, {
          playerId,
          playerName: participant.playerName,
          colorIndex: participant.colorIndex,
          avatarId: participant.avatarId,
          joinedAt: participant.joinedAt,
          guessCount: 0,
          wrongGuessCount: 0,
          hintCount: 0,
          averageSimilarity: null,
          bestGuess: null,
          furthestGuess: null,
          breakthroughs: 0,
          biggestLeap: 0,
          foundTarget: playerId === this.winner?.playerId,
          _similarityTotal: 0,
          _personalBest: 0,
        });
      }
      return statsByPlayer.get(playerId);
    };

    for (const participant of this.participants.values()) ensureStats(participant);

    let globalBest = -Infinity;
    let firstGuess = null;
    for (const guess of this.guessHistory) {
      const participant = this.participants.get(guess.playerId) || {
        playerId: guess.playerId,
        playerName: guess.playerName,
        colorIndex: guess.colorIndex || 0,
        avatarId: guess.avatarId || null,
        joinedAt: guess.createdAt,
      };
      const stats = ensureStats(participant);
      if (guess.isHint) {
        stats.hintCount += 1;
        continue;
      }

      if (!firstGuess) firstGuess = guess;
      stats.guessCount += 1;
      if (!guess.correct) stats.wrongGuessCount += 1;
      stats._similarityTotal += guess.similarity;

      if (!stats.bestGuess || guess.similarity > stats.bestGuess.similarity) {
        stats.bestGuess = {
          word: guess.guess,
          similarity: guess.similarity,
          rank: guess.rank || null,
        };
      }
      if (!stats.furthestGuess || guess.similarity < stats.furthestGuess.similarity) {
        stats.furthestGuess = {
          word: guess.guess,
          similarity: guess.similarity,
          rank: guess.rank || null,
        };
      }

      const leap = Math.max(0, guess.similarity - stats._personalBest);
      stats.biggestLeap = Math.max(stats.biggestLeap, leap);
      stats._personalBest = Math.max(stats._personalBest, guess.similarity);
      if (guess.similarity > globalBest) {
        stats.breakthroughs += 1;
        globalBest = guess.similarity;
      }
    }

    const players = Array.from(statsByPlayer.values())
      .map((stats) => ({
        ...stats,
        averageSimilarity: stats.guessCount
          ? stats._similarityTotal / stats.guessCount
          : null,
      }))
      .sort((a, b) => {
        if (a.foundTarget !== b.foundTarget) return a.foundTarget ? -1 : 1;
        if (b.guessCount !== a.guessCount) return b.guessCount - a.guessCount;
        return a.joinedAt.localeCompare(b.joinedAt);
      });

    const byMetric = (metric, direction = "max", eligible = () => true) => {
      const candidates = players.filter(eligible);
      if (!candidates.length) return null;
      return candidates.reduce((selected, candidate) => {
        const candidateValue = metric(candidate);
        const selectedValue = metric(selected);
        const isBetter = direction === "min"
          ? candidateValue < selectedValue
          : candidateValue > selectedValue;
        return isBetter ? candidate : selected;
      });
    };

    const makeAward = (id, player, titles, description, metricLabel) => {
      if (!player) return null;
      return {
        id,
        title: this.pickAwardCopy(id, player.playerId, titles),
        description,
        metricLabel,
        playerId: player.playerId,
        playerName: player.playerName,
        colorIndex: player.colorIndex,
      };
    };

    const winner = players.find((player) => player.foundTarget) || null;
    const mostGuesses = byMetric((player) => player.guessCount, "max", (player) => player.guessCount > 0);
    const mostWrong = byMetric((player) => player.wrongGuessCount, "max", (player) => player.wrongGuessCount > 0);
    const furthest = byMetric(
      (player) => player.furthestGuess?.similarity ?? Infinity,
      "min",
      (player) => Boolean(player.furthestGuess)
    );
    const fewest = players.length > 1
      ? byMetric((player) => player.guessCount, "min")
      : null;
    const bestAverage = byMetric(
      (player) => player.averageSimilarity ?? -Infinity,
      "max",
      (player) => player.averageSimilarity !== null
    );
    const mostHints = byMetric((player) => player.hintCount, "max", (player) => player.hintCount > 0);
    const mostBreakthroughs = byMetric((player) => player.breakthroughs, "max", (player) => player.breakthroughs > 0);
    const biggestLeap = byMetric((player) => player.biggestLeap, "max", (player) => player.biggestLeap > 0);
    const closestMissGuess = this.guessHistory.reduce((closest, guess) => {
      if (guess.correct || guess.isHint) return closest;
      return !closest || guess.similarity > closest.similarity ? guess : closest;
    }, null);
    const closestMiss = closestMissGuess
      ? players.find((player) => player.playerId === closestMissGuess.playerId)
      : null;

    const percent = (value) => `${(value * 100).toFixed(1)}%`;
    const plural = (count, singular, pluralForm = `${singular}s`) =>
      `${count} ${count === 1 ? singular : pluralForm}`;
    const awards = [
      makeAward(
        "signal-finder",
        winner,
        ["Signal Snatcher", "Bullseye Bandit", "Synapse Savior", "Word Wrangler"],
        `Said “${this.targetWord}” and made everyone else pretend they were about to.`,
        "Target acquired"
      ),
      makeAward(
        "most-guesses",
        mostGuesses,
        ["Keyboard Comet", "Transmission Machine", "Guess Thruster", "Mission Motor"],
        "Kept the comms channel busier than mission control.",
        mostGuesses ? plural(mostGuesses.guessCount, "guess") : ""
      ),
      makeAward(
        "most-wrong",
        mostWrong,
        ["Scenic Route Specialist", "Wrong-Turn Collector", "Orbit Enjoyer", "Detour Commander"],
        "Matched the crew’s largest collection of wrong turns—and somehow made them useful.",
        mostWrong ? plural(mostWrong.wrongGuessCount, "wrong turn") : ""
      ),
      makeAward(
        "furthest-guess",
        furthest,
        ["Outer Rim Tourist", "Deep-Void Cartographer", "Lost Moon Ambassador", "Semantic Space Cadet"],
        furthest?.furthestGuess
          ? `Sent “${furthest.furthestGuess.word}” from ${percent(furthest.furthestGuess.similarity)}. Deep-void tourism.`
          : "",
        furthest?.furthestGuess ? `${furthest.furthestGuess.word} · ${percent(furthest.furthestGuess.similarity)}` : ""
      ),
      makeAward(
        "fewest-guesses",
        fewest,
        ["Fuel-Efficient Flyer", "Silent Running", "Minimal-Mileage Mind", "Low-Orbit Thinker"],
        fewest?.guessCount
          ? "Found a way to contribute without wearing out the transmit button."
          : "Observed the mission with immaculate radio discipline.",
        fewest ? plural(fewest.guessCount, "guess") : ""
      ),
      makeAward(
        "best-average",
        bestAverage,
        ["Precision Pilot", "Vector Whisperer", "Closeness Connoisseur", "Semantic Sharpshooter"],
        "Maintained the crew’s highest average signal strength.",
        bestAverage ? `${percent(bestAverage.averageSimilarity)} average` : ""
      ),
      makeAward(
        "most-hints",
        mostHints,
        ["Navigator’s Best Customer", "Cosmic Lifeline", "Directions Enthusiast", "Mission Control Regular"],
        "Called the navigator enough times to get on a first-name basis.",
        mostHints ? plural(mostHints.hintCount, "hint") : ""
      ),
      makeAward(
        "most-breakthroughs",
        mostBreakthroughs,
        ["Trailblazer", "Hotter-Warmer", "Course Plotter", "Signal Booster"],
        "Matched the mission’s top count for moving the whole crew closer.",
        mostBreakthroughs ? plural(mostBreakthroughs.breakthroughs, "new crew best", "new crew bests") : ""
      ),
      makeAward(
        "biggest-leap",
        biggestLeap,
        ["Hyperspace Hopper", "Slingshot Specialist", "Quantum Leaper", "Warp-Drive Operator"],
        "Made the mission’s biggest personal jump toward the target.",
        biggestLeap ? `+${(biggestLeap.biggestLeap * 100).toFixed(1)} points` : ""
      ),
      firstGuess && makeAward(
        "first-contact",
        players.find((player) => player.playerId === firstGuess.playerId),
        ["First Contact", "Opening Transmission", "Launch Button Presser", "Early Bird in Space"],
        `Broke the silence with “${firstGuess.guess}.”`,
        firstGuess.guess
      ),
      closestMissGuess && makeAward(
        "closest-miss",
        closestMiss,
        ["Docked Without Landing", "Near-Miss Nebula", "Target Tease", "Almost Astronaut"],
        `Put “${closestMissGuess.guess}” within touching distance before the final lock.`,
        `${closestMissGuess.guess} · ${percent(closestMissGuess.similarity)}`
      ),
    ].filter(Boolean);

    const primaryAwardByPlayer = new Map();
    for (const award of awards) {
      if (!primaryAwardByPlayer.has(award.playerId)) {
        primaryAwardByPlayer.set(award.playerId, award);
      }
    }
    const fallbackTitles = [
      ["Cosmic Wildcard", "No single metric could explain the trajectory."],
      ["Backup Brain", "Kept the crew’s semantic options open."],
      ["Dark Matter Department", "Unclassifiable, but definitely mission-critical."],
      ["Moon-Shot Mechanic", "Kept launching ideas until one found an orbit."],
    ];

    const publicPlayers = players.map((player) => {
      const award = primaryAwardByPlayer.get(player.playerId);
      const fallback = this.pickAwardCopy("fallback", player.playerId, fallbackTitles);
      const {
        _similarityTotal,
        _personalBest,
        joinedAt,
        ...publicStats
      } = player;
      return {
        ...publicStats,
        title: award?.title || fallback[0],
        titleDetail: award?.description || fallback[1],
        awardIds: awards
          .filter((candidate) => candidate.playerId === player.playerId)
          .map((candidate) => candidate.id),
      };
    });

    const elapsedSeconds = this.startedAt && this.solvedAt
      ? Math.max(0, Math.round((Date.parse(this.solvedAt) - Date.parse(this.startedAt)) / 1000))
      : null;

    return {
      totalGuesses: publicPlayers.reduce((total, player) => total + player.guessCount, 0),
      totalHints: publicPlayers.reduce((total, player) => total + player.hintCount, 0),
      elapsedSeconds,
      playerCount: publicPlayers.length,
      awards,
      players: publicPlayers,
    };
  }

  getGameState() {
    const state = {
      status: this.status,
      targetLength: this.targetWord ? this.targetWord.length : 0,
      guessHistory: this.guessHistory,
      startedAt: this.startedAt,
      solvedAt: this.solvedAt,
      winner: this.winner,
      hintAvailableAt: this.hintAvailableAt
        ? new Date(this.hintAvailableAt).toISOString()
        : null,
      error: this.error,
      recap: this.buildRecap(),
    };

    if (this.status === "won") state.targetWord = this.targetWord;
    return state;
  }
}

module.exports = Game;
module.exports.normalizeGuess = normalizeGuess;
module.exports.DEFAULT_HINT_COOLDOWN_MS = DEFAULT_HINT_COOLDOWN_MS;
