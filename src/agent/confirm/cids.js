// @ts-check
// The CIDs a confirmation summary mentions, so the window can show each one in full next
// to the sentence. The summary is the server's text and is shown verbatim as well; this
// only finds the content addresses in it (CIDv0 `Qm...`, and CIDv1 in base32 `b...`).

const CID_PATTERN = /(?<![A-Za-z0-9])(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,120})(?![A-Za-z0-9])/g
const MAX_CIDS = 8

/**
 * @param {string} text
 * @returns {string[]} distinct, in order of appearance
 */
function extractCids (text) {
  const found = new Set()
  for (const match of text.matchAll(CID_PATTERN)) {
    found.add(match[1])
    if (found.size >= MAX_CIDS) break
  }
  return [...found]
}

module.exports = { extractCids }
