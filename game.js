const path = require("path");
const loadEmbeddings = require("./utils/loadEmbeddings");

class Game {
  constructor() {
    // These properties will be set once the embeddings load.
    this.targetWord = null;
    this.targetEmbedding = null;
    this.guessHistory = [];
    this.embeddings = null;

    // Load embeddings asynchronously.
    loadEmbeddings(path.join(__dirname, "embeddings.json"))
      .then((embeddings) => {
        this.embeddings = embeddings;
        // Get all the words from the embeddings.
        const words = Object.keys(embeddings);
        // Pick a random word from the list.
        const randomIndex = Math.floor(Math.random() * words.length);
        this.targetWord = words[randomIndex];
        this.targetEmbedding = this.getEmbedding(this.targetWord);
        console.log(
          "Embeddings loaded successfully. Target word is:",
          this.targetWord
        );
      })
      .catch((err) => {
        console.error("Error loading embeddings:", err);
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
      // If the target word isn’t set yet (embeddings still loading), return 0.
      targetLength: this.targetWord ? this.targetWord.length : 0,
      guessHistory: this.guessHistory,
    };
  }
}

module.exports = Game;
