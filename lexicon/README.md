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
6. Ambiguous forms retain their independent score unless an attested base is the current hidden answer: `leaves` can solve `leaf` or `leave`, `saw` can solve `see`, and `better/best` can solve `good`. Explicit protected concepts such as `booking/book` still stay separate. The answer pool excludes ambiguous comparisons such as `better` and `best`.
7. The game accepts plural-only nouns, ambiguous inflected homographs and unknown s-ending compounds as guesses. The answer pool excludes them. Singular mass/invariant nouns such as `physics`, `species` and `series` are explicit exceptions.
8. Input aliases use the same classifier outside `words.json`, including dictionary-attested irregulars. The generator flattens alias chains (`readings/reading/read`) before it emits artifacts.

Regional pairs with a meaning-changing homograph remain separate. The current explicit exceptions include `metre/meter`, `programme/program`, and `tyre/tire`.

## Generated inventories

- `generated/concepts.json`: canonical concepts, accepted aliases, and target eligibility
- `generated/targets.json`: reviewed canonical answer pool
- `generated/guess-aliases.json`: runtime input aliases, including accepted forms outside `words.json`
- `generated/ambiguous-aliases.json`: attested alternative lemmas that match only when the hidden answer supplies their context
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

The generator merges ordinary inflection families by default. Meaningful noun concepts and ambiguous homographs belong in explicit overrides. This is a versioned dictionary policy, not arbitrary suffix stripping: an unknown or misspelled input does not become a guessed stem. The target pool excludes modern compounds that the dictionary does not contain until a reviewer adds an override.

Verb reconstruction checks spelling in both directions and uses WordNet exception forms. For example, `hoping` must reconstruct from `hope`, while `hopping` reconstructs from `hop`; `riding/ridding`, `filing/filling`, and `staring/starring` stay separate. The classifier does not accept the lemmatizer's first valid stem when that stem cannot produce the submitted spelling. Unknown stress or spelling patterns remain separate instead of creating a speculative alias.
