// Names for release packages — pure, so the word lists and the grammar are covered
// by tests rather than discovered on screen.
//
// Why at all: a release is referred to in conversation, in a stand-up and in a chat
// message, and `PKG-2026-0031` is not something anybody says out loud — so releases
// were being called "ten pakiet z wtorku", which stops working the moment there are
// two. A name that is easy to say and impossible to confuse with the next one is the
// whole point; it is a label, not an identifier (the id stays the id).
//
// The names are Polish and stay Polish whatever the UI language is, for the same
// reason the notification language is pinned per instance: a release is called one
// thing by everybody, and a name that changed with the reader's language would not
// be a name. That is also why an adjective is stored in all three genders — Polish
// agreement is not optional, and „zardzewiały syrena" reads as a bug.
//
// It is a *suggestion*: the editor fills the field and the person types over it.

const MASC = 0, FEM = 1, NEUT = 2;

// Adjective, in the three genders the nouns below need.
export const NAME_ADJECTIVES = [
  ['szybki', 'szybka', 'szybkie'],
  ['spokojny', 'spokojna', 'spokojne'],
  ['uparty', 'uparta', 'uparte'],
  ['zardzewiały', 'zardzewiała', 'zardzewiałe'],
  ['dostojny', 'dostojna', 'dostojne'],
  ['czujny', 'czujna', 'czujne'],
  ['nocny', 'nocna', 'nocne'],
  ['piątkowy', 'piątkowa', 'piątkowe'],
  ['świąteczny', 'świąteczna', 'świąteczne'],
  ['zaspany', 'zaspana', 'zaspane'],
  ['pracowity', 'pracowita', 'pracowite'],
  ['niecierpliwy', 'niecierpliwa', 'niecierpliwe'],
  ['odważny', 'odważna', 'odważne'],
  ['ostrożny', 'ostrożna', 'ostrożne'],
  ['zdecydowany', 'zdecydowana', 'zdecydowane'],
  ['tajemniczy', 'tajemnicza', 'tajemnicze'],
  ['dziarski', 'dziarska', 'dziarskie'],
  ['leniwy', 'leniwa', 'leniwe'],
  ['wesoły', 'wesoła', 'wesołe'],
  ['poważny', 'poważna', 'poważne'],
  ['skromny', 'skromna', 'skromne'],
  ['dumny', 'dumna', 'dumne'],
  ['zaradny', 'zaradna', 'zaradne'],
  ['gadatliwy', 'gadatliwa', 'gadatliwe'],
  ['milczący', 'milcząca', 'milczące'],
  ['punktualny', 'punktualna', 'punktualne'],
  ['spóźniony', 'spóźniona', 'spóźnione'],
  ['zahartowany', 'zahartowana', 'zahartowane'],
  ['wypoczęty', 'wypoczęta', 'wypoczęte'],
  ['zdyszany', 'zdyszana', 'zdyszane'],
  ['solidny', 'solidna', 'solidne'],
  ['przebiegły', 'przebiegła', 'przebiegłe'],
  ['życzliwy', 'życzliwa', 'życzliwe'],
  ['zamyślony', 'zamyślona', 'zamyślone'],
  ['gorliwy', 'gorliwa', 'gorliwe'],
  ['niezłomny', 'niezłomna', 'niezłomne'],
  ['jesienny', 'jesienna', 'jesienne'],
  ['zimowy', 'zimowa', 'zimowe'],
  ['poranny', 'poranna', 'poranne'],
  ['ostatni', 'ostatnia', 'ostatnie'],
];

// Noun plus its gender. Deliberately concrete and harmless: an animal, a thing off a
// desk, a piece of Polish weather. Nothing here names a person, a client or a
// product — a release name ends up in a chat message read by people who were not in
// the room, and a joke at somebody's expense is not funny there.
export const NAME_NOUNS = [
  { word: 'żubr', gender: MASC },
  { word: 'bocian', gender: MASC },
  { word: 'borsuk', gender: MASC },
  { word: 'jeż', gender: MASC },
  { word: 'kot', gender: MASC },
  { word: 'łoś', gender: MASC },
  { word: 'wilk', gender: MASC },
  { word: 'rysio', gender: MASC },
  { word: 'wtorek', gender: MASC },
  { word: 'czwartek', gender: MASC },
  { word: 'termos', gender: MASC },
  { word: 'kompas', gender: MASC },
  { word: 'młotek', gender: MASC },
  { word: 'guzik', gender: MASC },
  { word: 'zeszyt', gender: MASC },
  { word: 'listopad', gender: MASC },
  { word: 'wiatr', gender: MASC },
  { word: 'grom', gender: MASC },
  { word: 'sokół', gender: MASC },
  { word: 'niedźwiedź', gender: MASC },
  { word: 'sowa', gender: FEM },
  { word: 'wydra', gender: FEM },
  { word: 'kaczka', gender: FEM },
  { word: 'żaba', gender: FEM },
  { word: 'wiewiórka', gender: FEM },
  { word: 'mewa', gender: FEM },
  { word: 'pszczoła', gender: FEM },
  { word: 'sarna', gender: FEM },
  { word: 'latarnia', gender: FEM },
  { word: 'kotwica', gender: FEM },
  { word: 'szufla', gender: FEM },
  { word: 'kanapka', gender: FEM },
  { word: 'herbata', gender: FEM },
  { word: 'mapa', gender: FEM },
  { word: 'chmura', gender: FEM },
  { word: 'zamieć', gender: FEM },
  { word: 'iskra', gender: FEM },
  { word: 'kredka', gender: FEM },
  { word: 'żarówka', gender: FEM },
  { word: 'lokomotywa', gender: FEM },
  { word: 'żurawie', gender: NEUT },
  { word: 'echo', gender: NEUT },
  { word: 'wiadro', gender: NEUT },
  { word: 'radio', gender: NEUT },
  { word: 'ognisko', gender: NEUT },
  { word: 'jezioro', gender: NEUT },
  { word: 'okno', gender: NEUT },
  { word: 'siodło', gender: NEUT },
  { word: 'pióro', gender: NEUT },
  { word: 'światło', gender: NEUT },
];

// How many combinations there are, which is also the ceiling on „give me a name
// nobody has used".
export function nameSpaceSize() {
  return NAME_ADJECTIVES.length * NAME_NOUNS.length;
}

const capitalise = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');

// One name, by index. Pure and total: any pair of indexes yields a name, so a caller
// may walk the space deterministically (which is how the tests check the grammar).
export function packageNameAt(adjIndex, nounIndex) {
  const adj = NAME_ADJECTIVES[((adjIndex % NAME_ADJECTIVES.length) + NAME_ADJECTIVES.length) % NAME_ADJECTIVES.length];
  const noun = NAME_NOUNS[((nounIndex % NAME_NOUNS.length) + NAME_NOUNS.length) % NAME_NOUNS.length];
  return `${capitalise(adj[noun.gender])} ${noun.word}`;
}

// Names are compared the way a person would: case and surrounding space are not what
// makes two names different.
export function normalizeName(name) {
  return String(name == null ? '' : name).trim().toLowerCase().replace(/\s+/g, ' ');
}

// A name nothing in `taken` is already called.
//
// `random` is injected so this is deterministic under test — the same reason
// versionCheck takes its clock. After a bounded number of tries it walks the space
// in order instead of rolling for ever (with 40×50 combinations and a few hundred
// packages, a run of collisions is unlikely but not impossible), and once every
// combination is taken it falls back to numbering: a suggestion that cannot be made
// must still be a name, because the alternative is an empty field with no
// explanation.
export function generatePackageName({ taken = [], random = Math.random, attempts = 60 } = {}) {
  const used = new Set((Array.isArray(taken) ? taken : []).map(normalizeName).filter(Boolean));
  const pick = () => Math.floor(random() * nameSpaceSize());
  for (let i = 0; i < attempts; i += 1) {
    const n = pick();
    const name = packageNameAt(Math.floor(n / NAME_NOUNS.length), n % NAME_NOUNS.length);
    if (!used.has(normalizeName(name))) return name;
  }
  // Deterministic sweep from a random starting point: still unpredictable, but it
  // cannot miss a free name that exists.
  const start = pick();
  for (let i = 0; i < nameSpaceSize(); i += 1) {
    const n = (start + i) % nameSpaceSize();
    const name = packageNameAt(Math.floor(n / NAME_NOUNS.length), n % NAME_NOUNS.length);
    if (!used.has(normalizeName(name))) return name;
  }
  for (let suffix = 2; ; suffix += 1) {
    const name = `${packageNameAt(Math.floor(start / NAME_NOUNS.length), start % NAME_NOUNS.length)} ${suffix}`;
    if (!used.has(normalizeName(name))) return name;
  }
}
