# Concept lexicon

Neuronauts scores concepts, not accidental spelling or inflection duplicates. The runtime loads committed generated artifacts; it does not perform linguistic analysis while a lobby is running.

## Build inputs

- `words.json`: the reference vocabulary
- `wink-lemmatizer` and `wink-lexicon`: lemma, part-of-speech, and independent-sense evidence
- `american-british-english-translator/data/british_spellings.json`: spelling pairs only; meaning and dialect-only tables are intentionally not used
- `lexicon-overrides.json`: reviewed aliases, standalone meanings, spelling exceptions, and target exclusions

The spelling package and its bundled spelling data are MIT-licensed. Its upstream source notes the source lists used to assemble the data.

## Classification order

1. Explicit overrides win.
2. A safe British spelling resolves to the canonical U.S. spelling. `jewellery` and `jewelry`, for example, share one concept.
3. Multiple possible lemmas remain separate and are excluded from targets.
4. Ordinary noun plurals and verb inflections share their base concept even when WordNet records an independent sense. `basics/basic`, `reading/read`, `studied/study`, and `written/write` are one answer each.
5. Explicit distinct concepts such as `booking/book`, `building/build`, `meeting/meet`, and `painting/paint` stay separate. Their plurals still resolve to the noun (`bookings/booking`, `buildings/building`).
6. Comparisons remain conservative: lexicalized words such as `better` stay distinct.
7. Plural-only nouns, ambiguous inflected homographs and unknown s-ending compounds are accepted as guesses but excluded from the answer pool. Singular mass/invariant nouns such as `physics`, `species` and `series` are explicit exceptions.
8. Input aliases use the same classifier outside `words.json`, including dictionary-attested irregulars. Alias chains are flattened (`readings/reading/read`) before artifacts are emitted.

Regional pairs with a meaning-changing homograph remain separate. The current explicit exceptions include `metre/meter`, `programme/program`, and `tyre/tire`.

## Generated inventories

- `generated/concepts.json`: canonical concepts, accepted aliases, and target eligibility
- `generated/targets.json`: reviewed canonical answer pool
- `generated/guess-aliases.json`: runtime input aliases, including accepted forms outside `words.json`
- `generated/lexicon-review.csv`: ambiguous and lexicalized cases for human review
- `generated/summary.json`: reproducible inventory counts

The target inventory is conservative. The guess inventory is broader. Ranking and hints use one canonical representative per concept family, so an alias cannot occupy another near-identical rank or hint slot.

## Workflow

```bash
npm run lexicon:build
npm run lexicon:check
npm test
```

Review decisions belong in `lexicon-overrides.json`, never in generated files. Regenerate and commit all artifacts after an override or source-vocabulary change. CI fails when generated output drifts.

The generator merges ordinary inflection families by default. Meaningful noun concepts and ambiguous homographs belong in explicit overrides. This is a versioned dictionary policy, not arbitrary suffix stripping: an unknown or misspelled input does not become a guessed stem. Modern compounds missing from the dictionary are target-excluded until reviewed.
