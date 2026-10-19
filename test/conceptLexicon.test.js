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

test("attested comparative spellings join their adjective and never become answers", () => {
  for (const [base, forms] of Object.entries({
    happy: ["happier", "happiest"], easy: ["easier", "easiest"],
    funny: ["funnier", "funniest"], hot: ["hotter", "hottest"],
    thin: ["thinner", "thinnest"], fast: ["faster", "fastest"],
  })) for (const form of forms) {
    assert.equal(defaultConceptLexicon.resolve(form, { targetWord: base }).canonicalWord, base, form);
    assert.equal(defaultConceptLexicon.isTargetEligible(form), false, form);
  }
});

test("noun and verb evidence keep ambiguous meanings and labels accurate", () => {
  for (const [form, target, label] of [["leaves", "leaf", "plural"],
    ["leaves", "leave", "agreement"], ["lives", "life", "plural"],
    ["lives", "live", "agreement"], ["people", "person", "plural"],
    ["media", "medium", "plural"], ["glasses", "glass", "plural"]]) {
    const result = defaultConceptLexicon.resolve(form, { targetWord: target });
    assert.equal(result.canonicalWord, target, `${form}/${target}`);
    assert.equal(result.transformation, label, `${form}/${target}`);
  }
  for (const [form, base] of [["believes", "believe"], ["proves", "prove"], ["reads", "read"]]) {
    assert.equal(defaultConceptLexicon.resolve(form).canonicalWord, base);
    assert.equal(defaultConceptLexicon.resolve(form).transformation, "agreement");
  }
  assert.notEqual(defaultConceptLexicon.resolve("believes", { targetWord: "belief" }).canonicalWord, "belief");
  assert.notEqual(defaultConceptLexicon.resolve("proves", { targetWord: "prof" }).canonicalWord, "prof");
  assert.equal(defaultConceptLexicon.resolve("corps").canonicalWord, "corps");
  assert.equal(defaultConceptLexicon.isTargetEligible("media"), false);
  for (const [plural, noun] of [["settings", "setting"], ["holdings", "holding"],
    ["findings", "finding"], ["belongings", "belonging"]]) {
    assert.equal(defaultConceptLexicon.resolve(plural).canonicalWord, noun);
  }
});

test("irregular homograph bases stop chains without blocking legitimate past guesses", () => {
  for (const [word, verb] of [["ground", "grind"], ["bore", "bear"], ["bit", "bite"],
    ["shot", "shoot"], ["felt", "feel"], ["spoke", "speak"], ["stole", "steal"]]) {
    assert.equal(defaultConceptLexicon.resolve(word).canonicalWord, word, word);
    assert.equal(defaultConceptLexicon.resolve(word, { targetWord: verb }).canonicalWord, verb, word);
    assert.equal(defaultConceptLexicon.isTargetEligible(word), false, word);
  }
  for (const form of ["boring", "bored", "bores"]) {
    assert.equal(defaultConceptLexicon.resolve(form, { targetWord: "bear" }).canonicalWord, "bore", form);
  }
  assert.equal(defaultConceptLexicon.resolve("grounded").canonicalWord, "ground");
  assert.equal(defaultConceptLexicon.resolve("singed", { targetWord: "sing" }).canonicalWord, "singe");
});

test("protected lexicalized nouns and comparisons retain their own meaning", () => {
  for (const [word, base] of [["lighter", "light"], ["cooler", "cool"],
    ["slicker", "slick"], ["thinner", "thin"]]) {
    assert.equal(defaultConceptLexicon.resolve(word).canonicalWord, word);
    assert.equal(defaultConceptLexicon.resolve(word, { targetWord: base }).canonicalWord, base);
    assert.equal(defaultConceptLexicon.isTargetEligible(word), false);
  }
  for (const [word, unrelated] of [["savings", "save"], ["winnings", "win"],
    ["leavings", "leave"], ["ethics", "ethic"], ["mechanics", "mechanic"],
    ["statistics", "statistic"]]) {
    assert.equal(defaultConceptLexicon.resolve(word, { targetWord: unrelated }).canonicalWord, word);
  }
  for (const word of ["constructor", "toString", "__proto__"]) {
    assert.equal(defaultConceptLexicon.resolve(word, { targetWord: "moon" }).canonicalWord, word);
  }
});
