// game.js
const embeddingsManager = require("./utils/embeddingsManager");
const EventEmitter = require("events");
const commonWords = require("./words.json");

class Game extends EventEmitter {
  constructor() {
    super();
    // These properties will be set once the embeddings load.
    this.targetWord = null;
    this.targetEmbedding = null;
    this.guessHistory = [];
    this.embeddings = null;

    // Initialize game using shared embeddings
    embeddingsManager
      .getEmbeddings()
      .then((embeddings) => {
        this.embeddings = embeddings;
        // Get all the words from the embeddings.
        const words = Object.keys(embeddings);
        // Pick a random word from the list.
        let randomIndex = Math.floor(Math.random() * commonWords.length);
        let commonWord = commonWords[randomIndex];
        // Ensure that the common word is in the embeddings.
        while (!words.includes(commonWord.toLowerCase())) {
          randomIndex = Math.floor(Math.random() * commonWords.length);
          commonWord = commonWords[randomIndex];
        }
        this.targetWord = commonWord;
        this.targetEmbedding = this.getEmbedding(this.targetWord);
        console.log("Game initialized with target word:", this.targetWord);
        // Emit a "ready" event with the current game state so the frontend can update.
        this.emit("ready", this.getGameState());
      })
      .catch((err) => {
        console.error("Error initializing game:", err);
      });
  }

  // Returns the embedding for the given word (if available)
  getEmbedding(word) {
    return this.embeddings ? this.embeddings[word.toLowerCase()] || null : null;
  }

  // Compute cosine similarity between two vectors.
  cosineSimilarity(vecA, vecB) {
    let dot = 0,
      normA = 0,
      normB = 0;
    for (let i = 0; i < vecA.length; i++) {
      dot += vecA[i] * vecB[i];
      normA += vecA[i] ** 2;
      normB += vecB[i] ** 2;
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  // Process a guess and return a result object.
  handleGuess(guess) {
    // Check if embeddings have finished loading.
    if (!this.embeddings || !this.targetWord || !this.targetEmbedding) {
      return {
        guess,
        error:
          "Embeddings are still loading. Please wait before making guesses.",
        similarity: null,
      };
    }

    const guessEmbedding = this.getEmbedding(guess);
    let result;
    if (!guessEmbedding) {
      result = {
        guess,
        error: "Word not found in dictionary.",
        similarity: null,
      };
    } else {
      const similarity = this.cosineSimilarity(
        this.targetEmbedding,
        guessEmbedding
      );
      result = {
        guess,
        similarity,
        correct: guess.toLowerCase() === this.targetWord.toLowerCase(),
      };
    }
    this.guessHistory.push(result);
    return result;
  }

  // Return the current game state for sending to clients.
  getGameState() {
    return {
      // If the target word isn’t set yet (embeddings still loading), targetLength is 0.
      targetLength: this.targetWord ? this.targetWord.length : 0,
      guessHistory: this.guessHistory,
    };
  }
}

module.exports = Game;
