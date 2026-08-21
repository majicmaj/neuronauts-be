const generatedConcepts = require("./lexicon/generated/concepts.json");
const generatedTargets = require("./lexicon/generated/targets.json");
const generatedAliases = require("./lexicon/generated/guess-aliases.json");

class ConceptLexicon {
  constructor({
    concepts = generatedConcepts.concepts,
    targets = generatedTargets.targets,
    aliases = generatedAliases.aliases,
  } = {}) {
    this.aliases = aliases;
    this.targetWords = new Set(targets);
    this.knownWords = new Set();
    for (const concept of concepts) {
      this.knownWords.add(concept.key);
      for (const alias of concept.aliases) this.knownWords.add(alias);
    }
  }

  resolve(word) {
    const alias = this.aliases[word];
    if (!alias) {
      return {
        submittedWord: word,
        canonicalWord: word,
        transformed: false,
        transformation: null,
      };
    }
    return {
      submittedWord: word,
      canonicalWord: alias.canonical,
      transformed: true,
      transformation: alias.transformation,
    };
  }

  isTargetEligible(word) {
    if (!this.knownWords.has(word)) return true;
    return this.targetWords.has(word);
  }

  isConceptTargetEligible(word) {
    if (!this.knownWords.has(word)) return true;
    return this.targetWords.has(word);
  }
}

const defaultConceptLexicon = new ConceptLexicon();

module.exports = { ConceptLexicon, defaultConceptLexicon };
