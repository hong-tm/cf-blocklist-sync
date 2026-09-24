// The add-only diff shared by the Cloudflare sync and both CDN mirrors:
// entries present in the reference set but missing from the current one, sorted.

/**
 * Entries in `reference` missing from `existing` (add-only diff), sorted.
 * @param {Set<string> | string[]} reference
 * @param {Set<string>} existing
 * @returns {string[]}
 */
export function computeToAdd(reference, existing) {
  const toAdd = [...reference].filter((e) => !existing.has(e));
  toAdd.sort();
  return toAdd;
}
