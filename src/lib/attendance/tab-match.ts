/**
 * Resolves which tab of an unconfigured file belongs to the signed-in person.
 *
 * A file with no `__APP_CONFIG` carries no mapping, so the app used to ask the
 * person to pick their tab by hand. In practice the answer is already written
 * on both sides: the tab is titled with the employee's full name, and the work
 * address is built from that same name. Reading one off the other removes a
 * step that only ever had one right answer.
 *
 * This is a convenience, never an access decision. A guess that is not certain
 * returns `null` so the chooser appears, and the attendance route re-authorizes
 * whatever tab is finally opened — matching here cannot reach a tab Google
 * would refuse.
 *
 * Pure by contract, like the rest of `attendance/` minus `service.ts`: no I/O,
 * no Google types, no React.
 */

export interface MatchableTab {
  readonly sheetId: string;
  readonly title: string;
}

/**
 * Comparable words of a name or an address.
 *
 * Decomposing first lets the combining-mark strip do the work for every
 * accented Vietnamese vowel at once; `đ` carries no combining mark, so it is
 * folded by hand. Everything that is not a letter or a digit separates words,
 * which collapses `.`, `_`, `-`, and runs of spaces to the same thing.
 */
function toTokens(text: string): readonly string[] {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/đ/g, "d")
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

/** The address without its domain, and without a `+tag` suffix. */
function toLocalPart(email: string): string | null {
  const at = email.indexOf("@");
  if (at <= 0) return null;

  const local = email.slice(0, at);
  const plus = local.indexOf("+");

  return plus === -1 ? local : local.slice(0, plus);
}

/**
 * The house style: given name, then the initials of everything before it.
 * `NGUYEN PHAN LINH` is `linh.np`, `THAI GIA HAN` is `han.tg`.
 */
function matchesGivenNameAndInitials(
  addressTokens: readonly string[],
  nameTokens: readonly string[],
): boolean {
  if (addressTokens.length !== 2 || nameTokens.length < 2) return false;

  const givenName = nameTokens[nameTokens.length - 1];
  const initials = nameTokens
    .slice(0, -1)
    .map((token) => token[0])
    .join("");

  return addressTokens[0] === givenName && addressTokens[1] === initials;
}

/**
 * The address spells the whole name out, in whatever order —
 * `nguyen.phan.linh` or `linh.nguyen.phan`.
 */
function matchesEveryNameWord(
  addressTokens: readonly string[],
  nameTokens: readonly string[],
): boolean {
  if (addressTokens.length < 2 || addressTokens.length !== nameTokens.length) return false;

  const sortedAddress = [...addressTokens].sort();
  const sortedName = [...nameTokens].sort();

  return sortedAddress.every((token, index) => token === sortedName[index]);
}

/**
 * Tried in order of how much they claim. The first rule that hits anything
 * decides: if it names exactly one tab that is the answer, and if it names
 * several the address genuinely does not distinguish them, so nothing is
 * opened rather than opening a colleague's sheet.
 */
const RULES = [matchesGivenNameAndInitials, matchesEveryNameWord] as const;

export function matchTabForEmail(
  email: string,
  tabs: readonly MatchableTab[],
): MatchableTab | null {
  const local = toLocalPart(email);
  if (local === null) return null;

  const addressTokens = toTokens(local);

  // A single word — `linh@` — says which person only if no colleague shares
  // that given name, and this function cannot know that. It is not enough.
  if (addressTokens.length < 2) return null;

  for (const rule of RULES) {
    const hits = tabs.filter((tab) => rule(addressTokens, toTokens(tab.title)));

    if (hits.length === 1) return hits[0];
    if (hits.length > 1) return null;
  }

  return null;
}
