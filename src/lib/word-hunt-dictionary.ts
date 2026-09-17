// Imported only by the server. Pin the package: updating a dictionary changes
// which submissions score. The package includes its source and MIT license.
import words from 'an-array-of-english-words/index.json';

const dictionary = new Set(words.filter((word) => /^[a-z]{3,32}$/.test(word)));

export function isWord(word: string): boolean {
  return dictionary.has(word.toLowerCase());
}
