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

  makeResult({ word, embedding, player, isHint = false, hintFrom = null }) {
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
      playerId: player.id,
      playerName: player.name,
      colorIndex: Number.isInteger(player.colorIndex) ? player.colorIndex : 0,
      createdAt,
      position: this.getPosition(embedding, similarity, word),
    };

    if (correct) {
      this.status = "won";
      this.solvedAt = createdAt;
      this.winner = { playerId: player.id, playerName: player.name };
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
    };

    if (this.status === "won") state.targetWord = this.targetWord;
    return state;
  }
}

module.exports = Game;
module.exports.normalizeGuess = normalizeGuess;
module.exports.DEFAULT_HINT_COOLDOWN_MS = DEFAULT_HINT_COOLDOWN_MS;
