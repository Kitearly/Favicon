/**
 * HTML character reference decoding.
 *
 * The original implementation parsed pages with JSDOM, which decodes character
 * references while parsing. `HTMLRewriter` hands out the raw source instead,
 * so the decoding has to happen explicitly to keep the results identical.
 */

/** Named references: the HTML 4 set plus the most common HTML 5 additions. */
const NAMED_ENTITIES: Record<string, string> = {
  // Latin-1
  nbsp: " ", iexcl: "¡", cent: "¢", pound: "£", curren: "¤",
  yen: "¥", brvbar: "¦", sect: "§", uml: "¨", copy: "©",
  ordf: "ª", laquo: "«", not: "¬", shy: "­", reg: "®",
  macr: "¯", deg: "°", plusmn: "±", sup2: "²", sup3: "³",
  acute: "´", micro: "µ", para: "¶", middot: "·", cedil: "¸",
  sup1: "¹", ordm: "º", raquo: "»", frac14: "¼", frac12: "½",
  frac34: "¾", iquest: "¿", Agrave: "À", Aacute: "Á", Acirc: "Â",
  Atilde: "Ã", Auml: "Ä", Aring: "Å", AElig: "Æ", Ccedil: "Ç",
  Egrave: "È", Eacute: "É", Ecirc: "Ê", Euml: "Ë", Igrave: "Ì",
  Iacute: "Í", Icirc: "Î", Iuml: "Ï", ETH: "Ð", Ntilde: "Ñ",
  Ograve: "Ò", Oacute: "Ó", Ocirc: "Ô", Otilde: "Õ", Ouml: "Ö",
  times: "×", Oslash: "Ø", Ugrave: "Ù", Uacute: "Ú", Ucirc: "Û",
  Uuml: "Ü", Yacute: "Ý", THORN: "Þ", szlig: "ß", agrave: "à",
  aacute: "á", acirc: "â", atilde: "ã", auml: "ä", aring: "å",
  aelig: "æ", ccedil: "ç", egrave: "è", eacute: "é", ecirc: "ê",
  euml: "ë", igrave: "ì", iacute: "í", icirc: "î", iuml: "ï",
  eth: "ð", ntilde: "ñ", ograve: "ò", oacute: "ó", ocirc: "ô",
  otilde: "õ", ouml: "ö", divide: "÷", oslash: "ø", ugrave: "ù",
  uacute: "ú", ucirc: "û", uuml: "ü", yacute: "ý", thorn: "þ",
  yuml: "ÿ",

  // Greek
  Alpha: "Α", Beta: "Β", Gamma: "Γ", Delta: "Δ", Epsilon: "Ε",
  Zeta: "Ζ", Eta: "Η", Theta: "Θ", Iota: "Ι", Kappa: "Κ",
  Lambda: "Λ", Mu: "Μ", Nu: "Ν", Xi: "Ξ", Omicron: "Ο",
  Pi: "Π", Rho: "Ρ", Sigma: "Σ", Tau: "Τ", Upsilon: "Υ",
  Phi: "Φ", Chi: "Χ", Psi: "Ψ", Omega: "Ω", alpha: "α",
  beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", zeta: "ζ",
  eta: "η", theta: "θ", iota: "ι", kappa: "κ", lambda: "λ",
  mu: "μ", nu: "ν", xi: "ξ", omicron: "ο", pi: "π",
  rho: "ρ", sigmaf: "ς", sigma: "σ", tau: "τ", upsilon: "υ",
  phi: "φ", chi: "χ", psi: "ψ", omega: "ω", thetasym: "ϑ",
  upsih: "ϒ", piv: "ϖ",

  // Symbols
  fnof: "ƒ", bull: "•", hellip: "…", prime: "′", Prime: "″",
  oline: "‾", frasl: "⁄", weierp: "℘", image: "ℑ", real: "ℜ",
  trade: "™", alefsym: "ℵ", larr: "←", uarr: "↑", rarr: "→",
  darr: "↓", harr: "↔", crarr: "↵", lArr: "⇐", uArr: "⇑",
  rArr: "⇒", dArr: "⇓", hArr: "⇔", forall: "∀", part: "∂",
  exist: "∃", empty: "∅", nabla: "∇", isin: "∈", notin: "∉",
  ni: "∋", prod: "∏", sum: "∑", minus: "−", lowast: "∗",
  radic: "√", prop: "∝", infin: "∞", ang: "∠", and: "∧",
  or: "∨", cap: "∩", cup: "∪", int: "∫", there4: "∴",
  sim: "∼", cong: "≅", asymp: "≈", ne: "≠", equiv: "≡",
  le: "≤", ge: "≥", sub: "⊂", sup: "⊃", nsub: "⊄",
  sube: "⊆", supe: "⊇", oplus: "⊕", otimes: "⊗", perp: "⊥",
  sdot: "⋅", lceil: "⌈", rceil: "⌉", lfloor: "⌊", rfloor: "⌋",
  lang: "〈", rang: "〉", loz: "◊", spades: "♠", clubs: "♣",
  hearts: "♥", diams: "♦",

  // Markup-significant and ISO special
  quot: '"', amp: "&", apos: "'", lt: "<", gt: ">",
  OElig: "Œ", oelig: "œ", Scaron: "Š", scaron: "š", Yuml: "Ÿ",
  circ: "ˆ", tilde: "˜", ensp: " ", emsp: " ", thinsp: " ",
  zwnj: "‌", zwj: "‍", lrm: "‎", rlm: "‏", ndash: "–",
  mdash: "—", lsquo: "‘", rsquo: "’", sbquo: "‚", ldquo: "“",
  rdquo: "”", bdquo: "„", dagger: "†", Dagger: "‡", permil: "‰",
  lsaquo: "‹", rsaquo: "›", euro: "€",
};

/** Code points that browsers remap when they appear in a numeric reference. */
const NUMERIC_REPLACEMENTS: Record<number, number> = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026,
  0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160,
  0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019,
  0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
  0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153,
  0x9e: 0x017e, 0x9f: 0x0178,
};

const REFERENCE = /&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g;

/**
 * Decode every character reference in a string. Unknown references are left
 * untouched, which is what browsers do as well.
 */
export function decodeEntities(input: string): string {
  if (!input.includes("&")) return input;

  return input.replace(REFERENCE, (match, body: string) => {
    if (body.startsWith("#")) {
      const isHex = body[1] === "x" || body[1] === "X";
      const codePoint = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      if (!Number.isFinite(codePoint) || codePoint <= 0) return "�";

      const mapped = NUMERIC_REPLACEMENTS[codePoint] ?? codePoint;
      if (mapped > 0x10ffff || (mapped >= 0xd800 && mapped <= 0xdfff)) return "�";
      return String.fromCodePoint(mapped);
    }

    return NAMED_ENTITIES[body] ?? match;
  });
}
