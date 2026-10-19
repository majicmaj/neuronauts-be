const definitions = require('./categories.json');
const { defaultConceptLexicon } = require('./conceptLexicon');
const targetInventory = new Set(require('./lexicon/generated/targets.json').targets);
const defaultWords = require('./words.json');

const ALL_WORDS = Object.freeze({
  id: 'all', label: 'All words', difficulty: 'hardest',
  description: 'The full word map. No topic to narrow the search.',
});
const categories = new Map([[ALL_WORDS.id, ALL_WORDS]]);
const pools = new Map();
const eligibleInventory = new Set(defaultWords.map(word => defaultConceptLexicon.resolve(word).canonicalWord));
for (const { words, ...metadata } of definitions) {
  if (categories.has(metadata.id)) throw new Error(`Duplicate category: ${metadata.id}`);
  if (!words.length || new Set(words).size !== words.length) throw new Error(`Invalid pool: ${metadata.id}`);
  for (const word of words) {
    if (!targetInventory.has(word) || !eligibleInventory.has(word) ||
        defaultConceptLexicon.resolve(word).canonicalWord !== word) {
      throw new Error(`Category ${metadata.id} contains an ineligible target: ${word}`);
    }
  }
  categories.set(metadata.id, Object.freeze(metadata));
  pools.set(metadata.id, Object.freeze([...words]));
}

function getCategory(id) {
  return categories.get(id === undefined ? 'all' : id) || null;
}
function getTargetPool(id) {
  const category = getCategory(id);
  if (!category) throw new Error('Unknown category. Choose a category and try again.');
  return pools.get(category.id) || null;
}
function getCategoryCatalog() {
  // Return metadata only. Target lists and embeddings remain server-owned.
  return Array.from(categories.values());
}
module.exports = { ALL_WORDS, getCategory, getTargetPool, getCategoryCatalog };
