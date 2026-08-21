const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { defaultConceptLexicon } = require("../conceptLexicon");
const generatedAliases = require("../lexicon/generated/guess-aliases.json");
const generatedConcepts = require("../lexicon/generated/concepts.json");

test("resolves spelling variants before gameplay", () => {
  assert.deepEqual(defaultConceptLexicon.resolve("jewellery"), {
    submittedWord: "jewellery",
    canonicalWord: "jewelry",
    transformed: true,
    transformation: "spelling-variant",
  });
  assert.equal(defaultConceptLexicon.resolve("colour").canonicalWord, "color");
  assert.equal(defaultConceptLexicon.resolve("jewelry").transformed, false);
});

test("keeps meaning-changing regional homographs separate", () => {
  assert.equal(defaultConceptLexicon.resolve("programme").canonicalWord, "programme");
  assert.equal(defaultConceptLexicon.resolve("tyre").canonicalWord, "tyre");
  assert.equal(defaultConceptLexicon.resolve("metre").canonicalWord, "metre");
});

test("merges plain inflections while preserving reviewed lexicalized words", () => {
  assert.equal(defaultConceptLexicon.resolve("cultures").canonicalWord, "culture");
  assert.equal(defaultConceptLexicon.resolve("climbed").canonicalWord, "climb");
  assert.equal(defaultConceptLexicon.resolve("glasses").canonicalWord, "glasses");
  assert.equal(defaultConceptLexicon.resolve("better").canonicalWord, "better");
  assert.equal(defaultConceptLexicon.isTargetEligible("cultures"), false);
  assert.equal(defaultConceptLexicon.isConceptTargetEligible("culture"), true);
});

test("generated aliases are direct and point to scoreable concepts", () => {
  const conceptKeys = new Set(generatedConcepts.concepts.map((concept) => concept.key));
  for (const [surface, alias] of Object.entries(generatedAliases.aliases)) {
    assert.notEqual(surface, alias.canonical);
    assert.equal(generatedAliases.aliases[alias.canonical], undefined);
    assert.ok(conceptKeys.has(alias.canonical), `${surface} points to missing ${alias.canonical}`);
  }
});

test("committed lexicon artifacts match the deterministic generator", () => {
  const root = path.resolve(__dirname, "..");
  const result = spawnSync(process.execPath, ["scripts/build-concept-lexicon.js", "--check"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
