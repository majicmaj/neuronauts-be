const loadEmbeddings = require("./loadEmbeddings");
const path = require("path");

class EmbeddingsManager {
  constructor() {
    this.embeddings = null;
    this.loadingPromise = null;
    this.ready = false;
    this.lastError = null;
  }

  getEmbeddingsPath() {
    return process.env.EMBEDDINGS_FILE || path.join(__dirname, "../embeddings.json");
  }

  isReady() {
    return this.ready;
  }

  getStatus() {
    return {
      ready: this.ready,
      loading: !!this.loadingPromise && !this.ready,
      error: this.lastError,
      file: this.getEmbeddingsPath(),
    };
  }

  async getEmbeddings() {
    if (this.embeddings) return this.embeddings;

    if (!this.loadingPromise) {
      this.loadingPromise = loadEmbeddings(this.getEmbeddingsPath())
        .then((embeddings) => {
          this.embeddings = embeddings;
          this.ready = true;
          this.lastError = null;
          return embeddings;
        })
        .catch((err) => {
          this.lastError = err.message;
          this.ready = false;
          this.loadingPromise = null;
          throw err;
        });
    }

    return this.loadingPromise;
  }
}

module.exports = new EmbeddingsManager();
