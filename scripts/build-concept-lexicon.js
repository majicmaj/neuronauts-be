const fs = require("node:fs");
const path = require("node:path");
const lemmatize = require("wink-lemmatizer");
const winkLexicon = require("wink-lexicon");
const britishSpellings = require(
  "american-british-english-translator/data/british_spellings.json"
);

const root = path.resolve(__dirname, "..");
const words = require(path.join(root, "words.json"));
const overrides = require(path.join(root, "lexicon", "lexicon-overrides.json"));
const outputDirectory = path.join(root, "lexicon", "generated");
const checkOnly = process.argv.includes("--check");
const wordSet = new Set(words);

function distinctLemmas(word) {
  return [...new Set([
    lemmatize.noun(word),
    lemmatize.verb(word),
    lemmatize.adjective(word),
  ])]
    .filter(
      (candidate) =>
        candidate !== word &&
        /^[a-z][a-z'-]*$/.test(candidate) &&
        (
          wordSet.has(candidate) ||
          winkLexicon.wnWords[candidate] !== undefined ||
          winkLexicon.lexicon[candidate]
        )
    )
    .sort();
}

function transformationFor(word, canonical) {
  const tags = winkLexicon.lexicon[word] || [];
  if (tags.includes("NNS")) return "plural";
  if (tags.includes("VBG") || word.endsWith("ing")) return "participle";
  if (tags.includes("VBD") || tags.includes("VBN") || word.endsWith("ed")) {
    return "past";
  }
  if (tags.includes("VBZ")) return "agreement";
  if (tags.includes("JJR") || tags.includes("JJS")) return "comparison";
  if (canonical !== word) return "irregular";
  return "inflection";
}

function isKnownWord(word) {
  return wordSet.has(word) ||
    winkLexicon.wnWords[word] !== undefined ||
    Boolean(winkLexicon.lexicon[word]);
}

function getSpellingVariant(word) {
  const canonical = britishSpellings[word];
  if (!canonical || overrides.spellingVariantExcluded[word]) return null;
  return /^[a-z][a-z'-]*$/.test(canonical) ? canonical : null;
}

function canBeTarget(word) {
  if (overrides.targetExcluded[word]) return false;
  if ((overrides.invariantSingular || []).includes(word)) return true;
  const tags = winkLexicon.lexicon[word] || [];
  // Unknown s-endings include web vocabulary and compounds that the lemma
  // dictionary misses (screenshots, plugins). Keep them guessable, never answers.
  if (word.endsWith("s") && !word.endsWith("ss")) {
    return tags.length > 0 && !tags.includes("NNS");
  }
  return true;
}

function classifyInflection(word) {
  const aliasOverride = overrides.aliases[word];
  if (aliasOverride) {
    if (!isKnownWord(aliasOverride.canonical)) {
      throw new Error(
        `Alias override for ${word} points to unknown ${aliasOverride.canonical}.`
      );
    }
    return {
      action: "alias",
      canonical: aliasOverride.canonical,
      transformation: aliasOverride.transformation || transformationFor(word, aliasOverride.canonical),
      reason: aliasOverride.reason || "Explicit alias override.",
      source: "override",
    };
  }

  if (overrides.standalone[word]) {
    return {
      action: "standalone",
      canonical: word,
      targetEligible: canBeTarget(word),
      reason: overrides.standalone[word],
      source: "override",
    };
  }

  const candidates = distinctLemmas(word);
  if (!candidates.length) {
    return {
      action: "standalone",
      canonical: word,
      targetEligible: canBeTarget(word),
      reason: overrides.targetExcluded[word] || "No related inflection in the reference vocabulary.",
      source: overrides.targetExcluded[word] ? "override" : "automatic",
    };
  }

  if (candidates.length > 1) {
    return {
      action: "standalone",
      canonical: word,
      targetEligible: false,
      reason: `Ambiguous lemmas: ${candidates.join(", ")}.`,
      source: "conservative",
      review: true,
      candidates,
    };
  }

  const [canonical] = candidates;
  const tags = winkLexicon.lexicon[word] || [];
  // WordNet lists ordinary plurals and gerunds as senses too. Dictionary
  // membership alone must not force an almost-identical answer into the pool.
  const nounLemma = lemmatize.noun(word);
  if (nounLemma !== word && canonical === nounLemma &&
      (tags.includes("NNS") || (word.endsWith("s") && !word.endsWith("ss")))) {
    return {
      action: "alias",
      canonical,
      transformation: "plural",
      reason: `Ordinary plural of ${canonical}.`,
      source: "automatic",
    };
  }

  if (tags.includes("JJR") || tags.includes("JJS") || tags.includes("RBR") || tags.includes("RBS")) {
    const lexicalized = tags.some((tag) => ["NN", "JJ", "RB", "VB"].includes(tag));
    if (!lexicalized) {
      return {
        action: "alias",
        canonical,
        transformation: "comparison",
        reason: `One unambiguous comparison form of ${canonical}.`,
        source: "automatic",
      };
    }
    return {
      action: "standalone",
      canonical: word,
      targetEligible: canBeTarget(word),
      reason: `Comparison form has an independent lexical role alongside ${canonical}.`,
      source: "lexicalized",
      review: true,
      candidates,
    };
  }

  const verbLemma = lemmatize.verb(word);
  if (canonical === verbLemma && verbLemma !== word &&
      (tags.some((tag) => ["VBG", "VBD", "VBN"].includes(tag)) ||
       word.endsWith("ing") || word.endsWith("ed"))) {
    return {
      action: "alias",
      canonical,
      transformation: transformationFor(word, canonical),
      reason: `Verb inflection of ${canonical}; distinct noun concepts require an explicit exception.`,
      source: "automatic",
    };
  }

  if (tags.includes("VBZ")) {
    return {
      action: "alias",
      canonical,
      transformation: "agreement",
      reason: `One unambiguous agreement form of ${canonical}.`,
      source: "automatic",
    };
  }

  return {
    action: "standalone",
    canonical: word,
    targetEligible: false,
    reason: `No supported inflection rule safely maps this word to ${canonical}.`,
    source: "conservative",
    review: true,
    candidates,
  };
}

function classify(word) {
  if (overrides.aliases[word] || overrides.standalone[word]) {
    return classifyInflection(word);
  }

  const spellingCanonical = getSpellingVariant(word);
  if (!spellingCanonical) return classifyInflection(word);

  const spellingDecision = classifyInflection(spellingCanonical);
  return {
    action: "alias",
    canonical: spellingDecision.canonical,
    transformation: "spelling-variant",
    reason: `British spelling variant of ${spellingCanonical}.`,
    source: "spelling-data",
  };
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function serializeJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function buildArtifacts() {
  const decisions = new Map(words.map((word) => [word, classify(word)]));
  const aliases = {};
  const conceptByKey = new Map();
  const reviewRows = [];

  for (const word of words) {
    const decision = decisions.get(word);
    if (decision.action === "alias") {
      aliases[word] = {
        canonical: decision.canonical,
        transformation: decision.transformation,
      };
    }
    const key = decision.canonical;
    if (!conceptByKey.has(key)) {
      conceptByKey.set(key, { key, aliases: [], targetEligible: false });
    }
    if (word !== key) conceptByKey.get(key).aliases.push(word);
    if (decision.action === "standalone" && decision.targetEligible) {
      conceptByKey.get(key).targetEligible = true;
    } else if (decision.action === "alias" && !wordSet.has(key)) {
      // Replace an inflected target with its scoreable base form when the base
      // is outside words.json (for example ending -> end).
      const baseDecision = classify(key);
      conceptByKey.get(key).targetEligible =
        baseDecision.action === "standalone" && baseDecision.targetEligible;
    }
    if (decision.review) {
      reviewRows.push([
        word,
        (decision.candidates || []).join("|"),
        winkLexicon.wnWords[word] !== undefined ? "yes" : "no",
        (winkLexicon.lexicon[word] || []).join("|"),
        decision.targetEligible ? "standalone" : "target-excluded",
        decision.reason,
      ]);
    }
  }

  for (const [surfaceWord, override] of Object.entries(overrides.aliases).sort()) {
    if (wordSet.has(surfaceWord) || aliases[surfaceWord]) continue;
    if (!conceptByKey.has(override.canonical)) {
      conceptByKey.set(override.canonical, {
        key: override.canonical,
        aliases: [],
        targetEligible: false,
      });
    }
    aliases[surfaceWord] = {
      canonical: override.canonical,
      transformation: override.transformation || transformationFor(surfaceWord, override.canonical),
    };
    conceptByKey.get(override.canonical).aliases.push(surfaceWord);
  }

  for (const surfaceWord of Object.keys(overrides.standalone).sort()) {
    if (!conceptByKey.has(surfaceWord)) {
      conceptByKey.set(surfaceWord, {
        key: surfaceWord, aliases: [], targetEligible: false,
      });
    }
  }

  // Accept regional spelling variants outside words.json whenever their
  // canonical concept is scoreable. These are input aliases, never targets.
  for (const surfaceWord of Object.keys(britishSpellings).sort()) {
    if (wordSet.has(surfaceWord) || overrides.spellingVariantExcluded[surfaceWord]) continue;
    const spellingCanonical = getSpellingVariant(surfaceWord);
    if (!spellingCanonical) continue;
    const spellingDecision = classifyInflection(spellingCanonical);
    const canonical = spellingDecision.canonical;
    if (!conceptByKey.has(canonical) || aliases[surfaceWord]) continue;
    aliases[surfaceWord] = {
      canonical,
      transformation: "spelling-variant",
    };
    conceptByKey.get(canonical).aliases.push(surfaceWord);
  }

  // Use the same decision for guesses inside and outside the target vocabulary.
  // This includes dictionary-attested irregulars without accepting arbitrary stems.
  const dictionaryWords = new Set([
    ...Object.keys(winkLexicon.lexicon), ...Object.keys(winkLexicon.wnWords),
  ]);
  for (const surfaceWord of [...dictionaryWords].sort()) {
    if (wordSet.has(surfaceWord) || aliases[surfaceWord] ||
        surfaceWord.length > 40 || !/^[a-z][a-z'-]*$/.test(surfaceWord)) continue;
    const decision = classify(surfaceWord);
    if (decision.action !== "alias") continue;
    if (!conceptByKey.has(decision.canonical)) {
      conceptByKey.set(decision.canonical, {
        key: decision.canonical, aliases: [], targetEligible: false,
      });
    }
    aliases[surfaceWord] = {
      canonical: decision.canonical,
      transformation: decision.transformation,
    };
    conceptByKey.get(decision.canonical).aliases.push(surfaceWord);
  }

  // Inflections can compose (readings -> reading -> read). Emit direct aliases
  // and one representative so wins, ranks, hints and duplicate recall all agree.
  for (const [surfaceWord, alias] of Object.entries(aliases)) {
    const seen = new Set([surfaceWord]);
    while (aliases[alias.canonical]) {
      if (seen.has(alias.canonical)) throw new Error(`Alias cycle at ${surfaceWord}.`);
      seen.add(alias.canonical);
      alias.canonical = aliases[alias.canonical].canonical;
    }
  }
  for (const concept of conceptByKey.values()) concept.aliases = [];
  for (const [surfaceWord, alias] of Object.entries(aliases)) {
    const oldConcept = conceptByKey.get(surfaceWord);
    if (oldConcept) conceptByKey.delete(surfaceWord);
    conceptByKey.get(alias.canonical).aliases.push(surfaceWord);
  }

  const concepts = [...conceptByKey.values()].map((concept) => ({
    ...concept,
    aliases: concept.aliases.sort(),
  }));
  const targets = concepts
    .filter((concept) => concept.targetEligible)
    .map((concept) => concept.key)
    .sort();
  const conceptKeys = new Set(concepts.map((concept) => concept.key));
  const targetKeys = new Set(targets);
  for (const [surfaceWord, alias] of Object.entries(aliases)) {
    if (surfaceWord === alias.canonical) {
      throw new Error(`Self-referential alias is not allowed: ${surfaceWord}.`);
    }
    if (aliases[alias.canonical]) {
      throw new Error(
        `Alias chain is not allowed: ${surfaceWord} -> ${alias.canonical} -> ${aliases[alias.canonical].canonical}.`
      );
    }
    if (!conceptKeys.has(alias.canonical)) {
      throw new Error(`Alias ${surfaceWord} points to missing concept ${alias.canonical}.`);
    }
    if (targetKeys.has(surfaceWord)) {
      throw new Error(`Alias ${surfaceWord} cannot remain target-eligible.`);
    }
  }
  for (const concept of concepts) {
    if (new Set(concept.aliases).size !== concept.aliases.length) {
      throw new Error(`Concept ${concept.key} contains a duplicate alias.`);
    }
  }
  const summary = {
    version: 1,
    sourceWordCount: words.length,
    conceptCount: concepts.length,
    targetCount: targets.length,
    aliasCount: Object.keys(aliases).length,
    reviewCount: reviewRows.length,
  };
  const review = [
    ["surface", "candidate_lemmas", "wordnet_exact", "parts_of_speech", "default_action", "reason"],
    ...reviewRows,
  ].map((row) => row.map(csvCell).join(",")).join("\n") + "\n";

  return {
    "concepts.json": serializeJson({ ...summary, concepts }),
    "targets.json": serializeJson({ version: summary.version, targets }),
    "guess-aliases.json": serializeJson({ version: summary.version, aliases }),
    "lexicon-review.csv": review,
    "summary.json": serializeJson(summary),
  };
}

function main() {
  const artifacts = buildArtifacts();
  fs.mkdirSync(outputDirectory, { recursive: true });
  const drift = [];
  for (const [filename, contents] of Object.entries(artifacts)) {
    const outputPath = path.join(outputDirectory, filename);
    if (checkOnly) {
      const existing = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8") : null;
      if (existing !== contents) drift.push(filename);
    } else {
      fs.writeFileSync(outputPath, contents);
    }
  }

  if (drift.length) {
    throw new Error(`Generated concept lexicon is stale: ${drift.join(", ")}. Run npm run lexicon:build.`);
  }
  const summary = JSON.parse(artifacts["summary.json"]);
  console.log(
    `${checkOnly ? "Verified" : "Built"} ${summary.conceptCount} concepts, ` +
    `${summary.targetCount} targets, ${summary.aliasCount} aliases, ` +
    `${summary.reviewCount} review cases.`
  );
}

main();
