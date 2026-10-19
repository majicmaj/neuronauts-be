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

test("ordinary plurals and verb inflections share a base even with dictionary senses", () => {
  const families = {
    basic: ["basics"], dog: ["dogs"], child: ["children"], woman: ["women"],
    read: ["reading", "readings", "reads"], run: ["running", "runs", "ran"],
    swim: ["swimming", "swims", "swam", "swum"],
    study: ["studies", "studying", "studied"],
    write: ["writing", "writes", "wrote", "written"],
    bus: ["buses", "busses"], screenshot: ["screenshots"],
  };
  for (const [canonical, surfaces] of Object.entries(families)) {
    for (const surface of surfaces) {
      assert.equal(defaultConceptLexicon.resolve(surface).canonicalWord, canonical, surface);
      assert.equal(defaultConceptLexicon.isTargetEligible(surface), false, surface);
    }
  }
});

test("distinct noun concepts retain their own plural family", () => {
  for (const [word, plural, different] of [
    ["booking", "bookings", "book"], ["building", "buildings", "build"],
    ["meeting", "meetings", "meet"], ["painting", "paintings", "paint"],
  ]) {
    assert.equal(defaultConceptLexicon.resolve(word).canonicalWord, word);
    assert.equal(defaultConceptLexicon.resolve(plural).canonicalWord, word);
    assert.notEqual(defaultConceptLexicon.resolve(word).canonicalWord, different);
    assert.equal(defaultConceptLexicon.isTargetEligible(plural), false);
  }
});

test("plural-only, unresolved plurals and ambiguous inflections are never hidden answers", () => {
  for (const word of ["glasses", "clothes", "goods", "customs", "savings", "shorts",
    "earnings", "bacteria", "others", "celebs", "stats", "leaves", "axes",
    "saw", "found", "wound", "lying"]) {
    assert.equal(defaultConceptLexicon.isTargetEligible(word), false, word);
  }
  for (const word of ["physics", "species", "series", "business"]) {
    assert.equal(defaultConceptLexicon.resolve(word).canonicalWord, word, word);
    assert.equal(defaultConceptLexicon.isTargetEligible(word), true, word);
  }
});

test("verb spelling reconstruction separates silent-e stems and doubled consonants", () => {
  for (const [form, base] of Object.entries({
    hoping: "hope", hopping: "hop", hoped: "hope", hopped: "hop",
    riding: "ride", ridding: "rid", filing: "file", filling: "fill",
    caring: "care", carrying: "carry", dying: "die", dyeing: "dye",
    staring: "stare", starring: "star", scaring: "scare", scarring: "scar",
    taping: "tape", tapping: "tap", mating: "mate", matting: "mat",
  })) assert.equal(defaultConceptLexicon.resolve(form).canonicalWord, base, form);
});

test("context accepts ambiguous inflections only for an attested answer", () => {
  for (const [surface, target] of [["leaves", "leaf"], ["leaves", "leave"],
    ["axes", "ax"], ["axes", "axis"], ["saw", "see"], ["rose", "rise"],
    ["better", "good"], ["best", "good"], ["worse", "bad"], ["worst", "bad"]]) {
    assert.equal(defaultConceptLexicon.resolve(surface, { targetWord: target }).canonicalWord, target);
    assert.equal(defaultConceptLexicon.resolve(surface, { targetWord: "moon" }).canonicalWord, surface);
  }
  for (const [surface, target] of [["booking", "book"], ["building", "build"],
    ["painting", "paint"], ["evening", "even"], ["rating", "rat"],
    ["dining", "din"], ["dive", "diva"]]) {
    assert.equal(defaultConceptLexicon.resolve(surface, { targetWord: target }).canonicalWord, surface);
  }
});
