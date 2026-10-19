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
const invariantSingular = new Set(overrides.invariantSingular || []);
const irregularPastBases = new Set(Object.entries(winkLexicon.wnVerbExceptions)
  .filter(([surface, base]) => surface !== base && !surface.endsWith("ing") && !surface.endsWith("ed"))
  .map(([, base]) => base));

function isVerb(word) {
  const index = winkLexicon.wnWords[word];
  return index !== undefined &&
    winkLexicon.wnWordSenses[index].some((sense) => sense > 28 && sense < 44);
}

function inflectVerb(base, ending) {
  if (ending === "ing") {
    if (base.endsWith("ie")) return `${base.slice(0, -2)}ying`;
    if (base.endsWith("e") && !/(ee|ye|oe)$/.test(base)) return `${base.slice(0, -1)}ing`;
  } else {
    if (base.endsWith("e")) return `${base}d`;
    if (/[^aeiou]y$/.test(base)) return `${base.slice(0, -1)}ied`;
  }
  // A one-syllable CVC stem doubles its final consonant: hop/hopping,
  // rid/ridding. Multi-syllable stress exceptions use attested WordNet forms.
  if (/^[^aeiou]*[aeiou][^aeiouwxy]$/.test(base)) {
    return `${base}${base.at(-1)}${ending}`;
  }
  return `${base}${ending}`;
}

function verbLemmas(word) {
  const attested = winkLexicon.wnVerbExceptions[word];
  if (attested) return attested === word ? [] : [attested];
  const ending = word.endsWith("ing") ? "ing" : word.endsWith("ed") ? "ed" : null;
  if (!ending) {
    const lemma = lemmatize.verb(word);
    return lemma === word ? [] : [lemma];
  }
  const stem = word.slice(0, -ending.length);
  const candidates = new Set([
    stem, `${stem}e`, stem.slice(0, -1),
    stem.endsWith("i") ? `${stem.slice(0, -1)}y` : "",
    stem.endsWith("y") ? `${stem.slice(0, -1)}ie` : "",
  ]);
  // Reconstruct the actual spelling rather than trusting Morphy's first valid
  // stem (which incorrectly returns hoping/hop, riding/rid, staring/star).
  const matches = [...candidates].filter((base) => isVerb(base) && inflectVerb(base, ending) === word);
  // singed is singe + d, not the regular past of irregular sing. Keep regular
  // variants such as hanged when no competing verb explains the spelling.
  const regularMatches = matches.filter((base) => !irregularPastBases.has(base));
  return ending === "ed" && matches.length > 1 && regularMatches.length
    ? regularMatches
    : matches;
}

function hasIndependentBaseSense(word) {
  const index = winkLexicon.wnWords[word];
  return index !== undefined &&
    winkLexicon.wnWordSenses[index].some((sense) => sense > 2 && sense < 44);
}

function attestedLemmas(word, { protectedConcept = false } = {}) {
  const tags = winkLexicon.lexicon[word] || [];
  const candidates = [];
  if (looksPlural(word, tags)) candidates.push(nounLemma(word));
  if (!protectedConcept && (tags.some((tag) => ["VBG", "VBD", "VBN", "VBZ"].includes(tag)) ||
      word.endsWith("ing") || word.endsWith("ed") || winkLexicon.wnVerbExceptions[word])) {
    candidates.push(...verbLemmas(word));
  }
  if (!protectedConcept && isComparison(word, tags)) candidates.push(lemmatize.adjective(word));
  return [...new Set(candidates)].filter((candidate) =>
    candidate !== word && /^[a-z][a-z'-]*$/.test(candidate) && isKnownWord(candidate));
}

function distinctLemmas(word) {
  return attestedLemmas(word).sort();
}

function transformationFor(word, canonical) {
  const tags = winkLexicon.lexicon[word] || [];
  if (canonical !== word && looksPlural(word, tags) &&
      (canonical === nounLemma(word) || !verbLemmas(word).includes(canonical))) return "plural";
  if (isComparison(word, tags) && lemmatize.adjective(word) === canonical) return "comparison";
  if (tags.includes("VBG") || word.endsWith("ing")) return "participle";
  if (tags.includes("VBZ")) return "agreement";
  if (tags.includes("VBD") || tags.includes("VBN") || word.endsWith("ed")) return "past";
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

function looksPlural(word, tags) {
  return tags.includes("NNS") ||
    (tags.length === 0 && word.endsWith("s") && !word.endsWith("ss"));
}

function nounLemma(word) {
  if (winkLexicon.uninflectedNouns[word] ||
      (word.endsWith("s") && winkLexicon.uncountableNouns[word])) return word;
  return lemmatize.noun(word);
}

function isComparison(word, tags) {
  return tags.some((tag) => ["JJR", "JJS", "RBR", "RBS"].includes(tag)) ||
    Boolean(winkLexicon.wnAdjectiveExceptions[word] &&
      winkLexicon.wnAdjectiveExceptions[word] !== word) ||
    (tags.length === 0 && lemmatize.adjective(word) !== word);
}

function canBeTarget(word) {
  if (overrides.targetExcluded[word]) return false;
  if (invariantSingular.has(word) || winkLexicon.singularNouns[word]) return true;
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

  if (overrides.standalone[word] || invariantSingular.has(word)) {
    return {
      action: "standalone",
      canonical: word,
      targetEligible: canBeTarget(word),
      reason: overrides.standalone[word] || "Singular or invariant noun ending in s.",
      source: "override",
    };
  }

  // An irregular past can also be an independent noun or infinitive:
  // ground/grind, bore/bear, shot/shoot. Keep that base intact so boring does
  // not chain through bore into bear. The past form can still solve its verb
  // when the hidden answer supplies the context.
  const exceptionalBase = winkLexicon.wnVerbExceptions[word];
  if (exceptionalBase && exceptionalBase !== word &&
      !word.endsWith("ing") && !word.endsWith("ed") && hasIndependentBaseSense(word)) {
    return {
      action: "standalone", canonical: word, targetEligible: false,
      reason: `Independent noun or verb also serves as the past of ${exceptionalBase}.`,
      source: "ambiguous", review: true, candidates: [exceptionalBase],
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
  const singular = nounLemma(word);
  if (singular !== word && canonical === singular && looksPlural(word, tags)) {
    return {
      action: "alias",
      canonical,
      transformation: "plural",
      reason: `Ordinary plural of ${canonical}.`,
      source: "automatic",
    };
  }

  if (isComparison(word, tags)) {
    if (overrides.targetExcluded[word] || hasIndependentBaseSense(word)) {
      return {
        action: "standalone", canonical: word, targetEligible: false,
        reason: overrides.targetExcluded[word] || `Comparison has an independent noun or verb sense alongside ${canonical}.`, source: "ambiguous",
      };
    }
    return {
      action: "alias", canonical, transformation: "comparison",
      reason: `Attested comparison form of ${canonical}.`, source: "automatic",
    };
  }

  if (verbLemmas(word).includes(canonical) &&
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
    transformation: spellingDecision.action === "alias" ? "inflection" : "spelling-variant",
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

function validateAmbiguousOverrides(ambiguousOverrides, aliases) {
  const canonicalWords = new Set(Object.values(aliases).map((alias) => alias.canonical));
  for (const [surface, candidates] of Object.entries(ambiguousOverrides)) {
    if (!/^[a-z][a-z'-]*$/.test(surface) || !Array.isArray(candidates) || !candidates.length) {
      throw new Error(`Invalid ambiguous alias override for ${surface}.`);
    }
    if (Object.hasOwn(aliases, surface)) {
      throw new Error(`Ambiguous alias ${surface} conflicts with a direct alias.`);
    }
    for (const candidate of candidates) {
      if (typeof candidate !== "string" || candidate === surface ||
          (!isKnownWord(candidate) && !canonicalWords.has(candidate))) {
        throw new Error(`Ambiguous alias ${surface} points to unknown or invalid ${candidate}.`);
      }
    }
  }
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
    if (decision.action === "standalone" && decision.targetEligible) {
      conceptByKey.get(key).targetEligible = true;
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
      transformation: spellingDecision.action === "alias" ? "inflection" : "spelling-variant",
    };
  }

  // Use the same decision for guesses inside and outside the target vocabulary.
  // This includes dictionary-attested irregulars without accepting arbitrary stems.
  const dictionaryWords = new Set([
    ...Object.keys(winkLexicon.lexicon), ...Object.keys(winkLexicon.wnWords),
    ...Object.keys(winkLexicon.wnVerbExceptions),
    ...Object.keys(winkLexicon.wnNounExceptions),
    ...Object.keys(winkLexicon.wnAdjectiveExceptions),
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
  }

  // Inflections can compose (readings -> reading -> read). Emit direct aliases
  // and one representative so wins, ranks, hints and duplicate recall all agree.
  for (const [surfaceWord, alias] of Object.entries(aliases)) {
    const seen = new Set([surfaceWord]);
    const transformations = new Set([alias.transformation]);
    while (aliases[alias.canonical]) {
      if (seen.has(alias.canonical)) throw new Error(`Alias cycle at ${surfaceWord}.`);
      seen.add(alias.canonical);
      transformations.add(aliases[alias.canonical].transformation);
      alias.canonical = aliases[alias.canonical].canonical;
    }
    if (transformations.size > 1) alias.transformation = "inflection";
  }
  for (const [surfaceWord, alias] of Object.entries(aliases)) {
    conceptByKey.delete(surfaceWord);
    conceptByKey.get(alias.canonical).aliases.push(surfaceWord);
  }
  // Replace an inflected target with its scoreable base form when the final
  // base is outside words.json (ending -> end, readings -> reading -> read).
  for (const word of words) {
    const alias = aliases[word];
    if (!alias || wordSet.has(alias.canonical)) continue;
    const baseDecision = classify(alias.canonical);
    if (baseDecision.action === "standalone" && baseDecision.targetEligible) {
      conceptByKey.get(alias.canonical).targetEligible = true;
    }
  }

  const ambiguousAliases = {};
  const ambiguousOverrides = overrides.ambiguousAliases || {};
  validateAmbiguousOverrides(ambiguousOverrides, aliases);
  for (const surface of [...new Set([...words, ...dictionaryWords,
    ...Object.keys(ambiguousOverrides)])].sort()) {
    if (aliases[surface] || !/^[a-z][a-z'-]*$/.test(surface)) continue;
    const explicit = ambiguousOverrides[surface];
    if (invariantSingular.has(surface) && !explicit) continue;
    const protectedConcept = Boolean(overrides.standalone[surface] && !explicit);
    const attestedCandidates = attestedLemmas(surface, { protectedConcept })
      // A protected plural noun may refer to its genuine singular noun, but
      // not chain through a gerund into a verb (savings/saving/save).
      .filter((candidate) => !protectedConcept || !aliases[candidate] ||
        aliases[candidate].transformation === "spelling-variant");
    const candidates = [...new Set((explicit || attestedCandidates)
      .map((candidate) => aliases[candidate]?.canonical || candidate))]
      .filter((candidate) => candidate !== surface);
    if (!candidates.length) continue;
    ambiguousAliases[surface] = {
      candidates: candidates.sort(),
      transformations: Object.fromEntries(candidates.map((candidate) =>
        [candidate, transformationFor(surface, candidate)])),
    };
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
    ambiguousAliasCount: Object.keys(ambiguousAliases).length,
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
    "ambiguous-aliases.json": serializeJson({ version: summary.version, aliases: ambiguousAliases }),
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

if (require.main === module) main();
module.exports = { validateAmbiguousOverrides };
