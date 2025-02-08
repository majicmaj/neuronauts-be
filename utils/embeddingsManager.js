const loadEmbeddings = require("./loadEmbeddings");
const path = require("path");

class EmbeddingsManager {
  constructor() {
    this.embeddings = null;
    this.loadingPromise = null;
  }

  async getEmbeddings() {
    if (this.embeddings) return this.embeddings;

    if (!this.loadingPromise) {
      this.loadingPromise = loadEmbeddings(
        path.join(__dirname, "../embeddings.json")
      ).then((embeddings) => {
        this.embeddings = embeddings;
        return embeddings;
      });
    }

    return this.loadingPromise;
  }
}

module.exports = new EmbeddingsManager();
