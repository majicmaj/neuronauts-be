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
3. Multiple possible lemmas remain separate and are excluded from targets pending review.
4. A dictionary-recorded independent sense remains standalone and enters review.
5. Recognized unambiguous plurals, participles, past-tense forms, agreement forms, and comparisons become aliases.
6. Unsupported or uncertain morphology remains standalone and enters review.

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

The generator intentionally prefers a missed merge to a false merge. Add an override only when the forms are safe to treat as one answer across the unsensed embedding used by the game.
