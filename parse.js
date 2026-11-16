// Fast, byte-identical drop-in for marked 18.1.3 with its default options
// (gfm true, breaks false, pedantic false, async false).
//
// This is a specialized fork of marked's Lexer/Tokenizer/Parser (MIT licensed,
// see vendor/marked/LICENSE and NOTICE). It keeps marked's exact tokenizers,
// regex rules and semantics, but:
//   - block and inline rendering emit into a string-parts array joined once,
//     instead of token objects plus repeated string concatenation,
//   - emphasis/delimiter closer scans and link href encoding are memoized,
//   - repeated tab-expansion work in list items is avoided where possible.
// All block/inline regex rules are imported from the vendored marked build, so
// every match decision is identical to marked 18.1.3.

import { marked } from './vendor/marked/marked.esm.js';

const BlockRules = marked.Lexer.rules.block.gfm;
const InlineRules = marked.Lexer.rules.inline.gfm;
const Other = new marked.Lexer().tokenizer.rules.other;

// ---------- utils (mirrors marked src/utils.ts) ----------
const escapeMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeFn = (ch) => escapeMap[ch];

// P(a): the no-encode branch
function escapeNoEncode(s) {
  if (Other.escapeTestNoEncode.test(s)) return s.replace(Other.escapeReplaceNoEncode, escapeFn);
  return s;
}
// P(a, true): the encode branch
function escapeEncode(s) {
  if (Other.escapeTest.test(s)) return s.replace(Other.escapeReplace, escapeFn);
  return s;
}
// Ie(a): numeric character reference resolution on inline text
function resolveCharRefs(s) {
  if (!Other.numericCharacterReference.test(s)) return s;
  return s.replace(Other.numericCharacterReferenceOrAmpersand, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const cp = dec === undefined ? Number.parseInt(hex, 16) : Number.parseInt(dec, 10);
    if (cp === 0 || cp > 1114111 || (cp >= 55296 && cp <= 57343)) return '\uFFFD';
    if (cp === 38) return '&amp;';
    return String.fromCodePoint(cp);
  });
}
// he(a): cleanUrl
function cleanUrl(url) {
  try { return encodeURI(url).replace(Other.percentDecode, '%'); } catch { return null; }
}
// L(a, e, t): rtrim
function rtrimStr(s, ch, mask) {
  const len = s.length;
  if (len === 0) return '';
  let i = 0;
  while (i < len) {
    const c = s.charAt(len - i - 1);
    if (c === ch && !mask) i++;
    else if (c !== ch && mask) i++;
    else break;
  }
  return s.slice(0, len - i);
}
// ge(a): rtrim blank lines of an indented code block
function trimTrailingBlankLines(s) {
  const lines = s.split('\n');
  let t = lines.length - 1;
  for (; t >= 0 && Other.blankLine.test(lines[t]); t--);
  return lines.length - t <= 2 ? s : lines.slice(0, t + 1).join('\n');
}
// F(a): normalize label
function normalizeLabel(s) {
  return s.trim().replace(Other.multipleSpaceGlobal, ' ').toLowerCase().toUpperCase().toLowerCase();
}
// ke(a, e): indexOfUnescaped
function indexOfUnescaped(s, pair) {
  if (s.indexOf(pair[0]) === -1 && s.indexOf(pair[1]) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === pair[0]) depth++;
    else if (s[i] === pair[1] && (depth--, depth < 0)) return i;
  }
  return depth > 0 ? -2 : -1;
}
// J(a, e): expandTabsIn
function expandTabsIn(s, startCol = 0) {
  let col = startCol, out = '';
  for (const ch of s) {
    if (ch === '\t') { const add = 4 - col % 4; out += ' '.repeat(add); col += add; }
    else { out += ch; col++; }
  }
  return out;
}
// de(a, e): splitTableCells
function splitTableCells(s, width) {
  const masked = s.replace(Other.findPipe, (m, off, str) => {
    let esc = false, p = off;
    for (; --p >= 0 && str[p] === '\\';) esc = !esc;
    return esc ? '|' : ' |';
  });
  let cells = masked.split(Other.splitPipe);
  if (cells[0].trim() || cells.shift(), cells.length > 0 && !cells.at(-1)?.trim() && cells.pop(), width) {
    if (cells.length > width) cells.splice(width);
    else for (; cells.length < width;) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim().replace(Other.slashPipe, '|');
  return cells;
}
// Dt(a, e, t): removeIndentation for fenced code
function removeIndentation(fence, text) {
  const m = fence.match(Other.indentCodeCompensation);
  if (m === null) return text;
  const indent = m[1];
  return text.split('\n').map((line) => {
    const ws = line.match(Other.beginningSpace);
    if (ws === null) return line;
    return line.slice(Math.min(ws[0].length, indent.length));
  }).join('\n');
}
// Be(a, e, t, n): isBlockOfTags — a <tag inside the link label means "not a link"
function hasTagInside(src, label, offset) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') { i++; continue; }
    if (label[i] === '`') {
      const cm = InlineRules.code.exec(label.slice(i));
      if (cm) { i += cm[0].length - 1; continue; }
    }
    if (label[i] !== '<') continue;
    const rest = src.slice(offset + i);
    const tm = InlineRules.tag.exec(rest) || InlineRules.autolink.exec(rest);
    if (tm) {
      if (tm[0].length > label.length - i) return true;
      i += tm[0].length - 1;
    }
  }
  return false;
}

// link href encodeURI memo
const hrefCache = new Map();
function encodeHref(url) {
  let v = hrefCache.get(url);
  if (v === undefined) { v = cleanUrl(url); hrefCache.set(url, v); }
  return v;
}

// ---------- emphasis/del closer indexes (marked's fe/ze/Me, per inline pass) ----------
const closerStack = [];
function computeClosers(s) {
  const em = { '*': -1, _: -1 };
  let del = -1;
  const n = s.length;
  for (let i = 0; i < n; i++) {
    const c = s[i];
    if (c !== '*' && c !== '_' && c !== '~') continue;
    const prev = i === 0 ? '\n' : s[i - 1];
    let j = i + 1;
    for (; j < n && s[j] === c;) j++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (c === '~') del = i; else em[c] = i;
    }
    i = j - 1;
  }
  return { maskedSrc: s, em, del };
}

// ---------- inline lexer ----------
// Renders inline markdown directly into HTML string parts (no token objects).
// `plain` mode mirrors marked's TextRenderer: produces the bare text of the
// inline run, used for image alt text.
class InlineLexer {
  constructor(state) {
    this.state = state;
  }
  // returns the HTML parts for src
  run(src) {
    const st = this.state;
    const out = [];
    const masked = (src.includes('*') || src.includes('_') || src.includes('~')) ? this.#mask(src) : src;
    const closer = computeClosers(masked);
    closerStack.push(closer);
    try {
      this.#tokens(src, masked, out, false);
    } finally {
      closerStack.pop();
    }
    return out;
  }
  // returns the plain text of src (TextRenderer semantics)
  runPlain(src) {
    const out = [];
    this.#tokens(src, src, out, true);
    return out.join('');
  }

  // marked's #n: mask reflinks/block-skips/punctuated code spans (length-preserving)
  #mask(src) {
    const links = this.state.links;
    let t = src;
    if (links && src.includes('[')) {
      const rs = InlineRules.reflinkSearch;
      const sub = (m) => {
        const idx = m.lastIndexOf('[');
        if (!Object.hasOwn(links, normalizeLabel(m.slice(idx + 1, -1)))) return m;
        if (idx > 1 && m.charAt(0) !== '!') {
          const inner = m.slice(1, idx - 1);
          if (this.#linkInText(inner)) return '[' + inner.replace(rs, sub) + '][' + 'a'.repeat(m.length - idx - 2) + ']';
        }
        return '[' + 'a'.repeat(m.length - 2) + ']';
      };
      t = t.replace(rs, sub);
    }
    if (t.includes('`') || t.includes('\\'))
      t = t.replace(InlineRules.anyPunctuationOutsideCode, (m, tick, ticked) => {
        if (ticked) return '+'.repeat(m.length);
        if (tick) return tick + m.slice(tick.length, -tick.length).replace(/`/g, '+') + tick;
        return m;
      });
    if (t.includes('[') || t.includes('`') || t.includes('<'))
      t = t.replace(InlineRules.blockSkip, (m, _, lead) => {
        const off = lead ? lead.length : 0;
        return m.slice(0, off) + '[' + 'a'.repeat(m.length - off - 2) + ']';
      });
    return t;
  }

  #linkInText(src) {
    if (!src.includes('[')) return false;
    const link = InlineRules.link;
    for (const m of src.matchAll(InlineRules.blockSkip)) {
      if (link.test(m[0]) && src.charAt(m.index - 1) !== '!') return true;
    }
    for (const m of src.matchAll(InlineRules.reflinkSearch)) {
      const s = m[0], idx = s.lastIndexOf('[');
      if (!(s.charAt(0) === '!' || !Object.hasOwn(this.state.links, normalizeLabel(s.slice(idx + 1, -1)))) &&
          !(idx > 1 && this.#linkInText(s.slice(1, idx - 1)))) return true;
    }
    return false;
  }

  // marked's #t loop. `plain` mirrors TextRenderer.
  #tokens(src, masked, out, plain) {
    const st = this.state;
    let lastChar = '', lastWasText = false, min = Infinity;
    for (;;) {
      if (!src) break;
      if (src.length >= min) throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
      min = src.length;
      if (!lastWasText) lastChar = '';
      lastWasText = false;

      // First-character dispatch: every inline rule is anchored, so a rule can
      // only match when src[0] is one of its possible starting characters.
      // Skipping impossible rules avoids most failed regex executions.
      const c0 = src.charCodeAt(0);
      let m;

      // escape (backslash)
      if (c0 === 92) {
        m = InlineRules.escape.exec(src);
        if (m) {
          if (plain) out.push(m[1]);
          else out.push(escapeNoEncode(m[1]));
          src = src.substring(m[0].length);
          continue;
        }
      }

      // html tag ('<')
      if (c0 === 60) {
        m = InlineRules.tag.exec(src);
        if (m) {
          if (!plain) {
            if (!st.inLink && Other.startATag.test(m[0])) st.inLink = true;
            else if (st.inLink && Other.endATag.test(m[0])) st.inLink = false;
            if (!st.inRawBlock && Other.startPreScriptTag.test(m[0])) st.inRawBlock = true;
            else if (st.inRawBlock && Other.endPreScriptTag.test(m[0])) st.inRawBlock = false;
          }
          out.push(m[0]);
          src = src.substring(m[0].length);
          continue;
        }
      }

      // link / reflink / nolink ('[' or '!')
      if (c0 === 91 || c0 === 33) {
      {
        m = InlineRules.link.exec(src);
        if (m) {
          const consumed = this.#link(src, m, out, false, null, plain);
          if (consumed >= 0) { src = src.substring(consumed); continue; }
        }
      }

      // reflink / nolink
      m = InlineRules.reflink.exec(src) || InlineRules.nolink.exec(src);
      if (m) {
        const ref = this.state.links[normalizeLabel(m[2] || m[1])];
        if (ref) {
          if (plain) {
            out.push(this.runPlain((m[0].charAt(0) === '!' ? m[0].slice(2, -1) : m[0].slice(1, -1)).replace(Other.outputLinkReplace, '$1')));
            src = src.substring(m[0].length);
            continue;
          }
          const consumed = this.#link(src, m, out, true, ref, plain);
          if (consumed >= 0) { src = src.substring(consumed); continue; }
        } else {
          const ch = m[0].charAt(0);
          if (plain) out.push(ch); else out.push(escapeNoEncode(ch));
          src = src.substring(1);
          continue;
        }
      }
      }

      // em / strong ('*' or '_')
      if (c0 === 42 || c0 === 95) {
      if (plain) {
        m = InlineRules.emStrongLDelim.exec(src);
        if (m && (m[1] || m[2] || m[3] || m[4])) {
          const r = this.#emStrongSpan(src, masked, m, lastChar);
          if (r) {
            out.push(this.runPlain(r.inner));
            src = src.substring(r.len);
            continue;
          }
        }
      } else {
        m = InlineRules.emStrongLDelim.exec(src);
        if (m) {
          const r = this.#emStrong(src, masked, m, lastChar);
          if (r) { out.push(r.html); src = src.substring(r.len); continue; }
        }
      }
      }

      // codespan (backtick)
      if (c0 === 96) {
        m = InlineRules.code.exec(src);
        if (m) {
          let text = m[2].replace(Other.newLineCharGlobal, ' ');
          if (Other.nonSpaceChar.test(text) && Other.startingSpaceChar.test(text) && Other.endingSpaceChar.test(text))
            text = text.substring(1, text.length - 1);
          if (plain) out.push(text);
          else out.push('<code>' + escapeEncode(text) + '</code>');
          src = src.substring(m[0].length);
          continue;
        }
      }

      // br (space or backslash)
      if (c0 === 32 || c0 === 92) {
        m = InlineRules.br.exec(src);
        if (m) {
          if (!plain) out.push('<br>');
          src = src.substring(m[0].length);
          continue;
        }
      }

      // del (tilde)
      if (c0 === 126) {
      m = InlineRules.delLDelim.exec(src);
      if (m && (!(m[1] || '') || !lastChar || InlineRules.punctuation.exec(lastChar))) {
        if (plain) {
          const r = this.#delSpan(src, masked, m);
          if (r) { out.push(this.runPlain(r.inner)); src = src.substring(r.len); continue; }
        } else {
          const r = this.#del(src, masked, m);
          if (r) { out.push(r.html); src = src.substring(r.len); continue; }
        }
      }
      }

      // autolink ('<')
      if (c0 === 60) {
        m = InlineRules.autolink.exec(src);
        if (m) {
          const text = m[1];
          const href = m[2] === '@' ? 'mailto:' + text : text;
          if (plain) out.push(text);
          else out.push(renderAutoLink(href, null, text));
          src = src.substring(m[0].length);
          continue;
        }
      }

      // extended autolink (url/email start chars)
      if (!st.inLink && ((c0 >= 97 && c0 <= 122) || (c0 >= 65 && c0 <= 90) || (c0 >= 48 && c0 <= 57) || c0 === 46 || c0 === 95 || c0 === 43 || c0 === 45)) {
        m = InlineRules.url.exec(src);
        if (m) {
          let raw = m[0], text, href;
          if (m[2] === '@') { text = raw; href = 'mailto:' + raw; }
          else {
            let prev;
            do { prev = raw; raw = InlineRules._backpedal.exec(raw)?.[0] ?? ''; } while (prev !== raw);
            text = raw;
            href = m[1] === 'www.' ? 'http://' + raw : raw;
          }
          out.push(renderAutoLink(href, null, text));
          src = src.substring(raw.length);
          continue;
        }
      }

      // plain text run
      m = InlineRules.text.exec(src);
      if (m) {
        const raw = m[0];
        if (plain) out.push(st.inRawBlock ? raw : resolveCharRefs(raw));
        else out.push(st.inRawBlock ? raw : escapeNoEncode(resolveCharRefs(raw)));
        src = src.substring(raw.length);
        lastWasText = true;
        if (raw.slice(-1) !== '_') lastChar = raw.slice(-1);
        continue;
      }
      if (src) throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
      break;
    }
  }

  // marked's link(): returns consumed length, or -1 when not a link.
  // Appends rendered HTML to out.
  #link(src, m, out, isRef, ref, plain) {
    const st = this.state;
    const isImage = m[0].charAt(0) === '!';
    const off = isImage ? 2 : 1;
    if (!isRef) {
      if (hasTagInside(src, m[1], off)) return -1;
      let dest = m[2].trim();
      if (Other.startAngleBracket.test(dest)) {
        if (!Other.endAngleBracket.test(dest)) return -1;
        const last = rtrimStr(dest.slice(0, -1), '\\');
        if ((dest.length - last.length) % 2 === 0) return -1;
      } else {
        const paren = indexOfUnescaped(m[2], '()');
        if (paren === -2) return -1;
        if (paren > -1) {
          const cut = (m[0].indexOf('!') === 0 ? 5 : 4) + m[1].length + paren;
          m[2] = m[2].substring(0, paren);
          m[0] = m[0].substring(0, cut).trim();
          m[3] = '';
          dest = m[2];
        }
      }
      const last = rtrimStr(m[0].slice(0, -1), '\\');
      if ((m[0].length - last.length) % 2 === 0) return -1;
      let href = m[2], title = '';
      title = m[3] ? m[3].slice(1, -1) : '';
      href = href.trim();
      if (Other.startAngleBracket.test(href)) href = href.slice(1, -1);
      href = href && href.replace(InlineRules.anyPunctuation, '$1');
      title = title && title.replace(InlineRules.anyPunctuation, '$1');
      const consumed = this.#emitLink(m[0], href, title, out, false, m[1], plain);
      return consumed;
    }
    // reflink: marked Be(e, n[1], s, rules)
    if (hasTagInside(src, m[1], off)) return -1;
    const consumed = this.#emitLink(m[0], ref.href, ref.title, out, false, m[1], plain);
    return consumed;
  }

  // marked's De(): renders a link/image from the inner text. Returns m[0].length
  // (the raw the caller must consume) or -1 when suppressed (link in link).
  #emitLink(raw, href, title, out, _, innerText, plain) {
    const st = this.state;
    const isImage = raw.charAt(0) === '!';
    const inner = innerText.replace(Other.outputLinkReplace, '$1');
    const savedInLink = st.inLink, savedEmitted = st.linkEmitted, savedRaw = st.inRawBlock;
    st.inLink = true;
    st.linkEmitted = false;
    const sub = new InlineLexer(st);
    const subParts = plain ? null : sub.run(inner);
    const emitted = st.linkEmitted;
    st.linkEmitted = savedEmitted;
    st.inLink = savedInLink;
    if (!isImage) {
      if (emitted) { st.inRawBlock = savedRaw; return -1; }
      st.linkEmitted = true;
    }
    if (plain) {
      // Plain output mirrors marked's TextRenderer over the html-mode tokens:
      // run an html-mode probe so link-in-link suppression and linkEmitted
      // bookkeeping match exactly, then emit the plain text of the inner run.
      st.linkEmitted = false;
      const probe = new InlineLexer(st);
      probe.run(inner);
      const emitted = st.linkEmitted;
      st.linkEmitted = savedEmitted;
      if (!isImage && emitted) { st.inRawBlock = savedRaw; return -1; }
      st.linkEmitted = savedEmitted;
      out.push(sub.runPlain(inner));
      return raw.length;
    }
    if (isImage) {
      const alt = sub.runPlain(inner);
      const enc = encodeHref(href);
      if (enc === null) { out.push(escapeNoEncode(alt)); return raw.length; }
      let img = `<img src="${escapeNoEncode(enc)}" alt="${escapeNoEncode(alt)}"`;
      if (title) img += ` title="${escapeNoEncode(title)}"`;
      out.push(img + '>');
      return raw.length;
    }
    const enc = encodeHref(href);
    if (enc === null) { out.push(...subParts); return raw.length; }
    let a = '<a href="' + escapeNoEncode(enc) + '"';
    if (title) a += ' title="' + escapeNoEncode(title) + '"';
    out.push(a + '>', ...subParts, '</a>');
    return raw.length;
  }

  // marked's emStrong(): returns {html, len} or null
  #emStrong(src, masked, m, lastChar) {
    if (!m[1] && !m[2] && !m[3] && !m[4]) return null;
    const delim = m[0][0];
    const runEnd = lastChar === delim;
    const i = masked.length - src.length;
    let l = i;
    for (; l > 0 && masked[l - 1] === delim;) l--;
    const p = masked.slice(Math.max(0, l - 2), l).slice(-1) ?? '';
    const pIsDelimOrPunct = p === '*' || p === '_' || !!InlineRules.punctuation.exec(p);
    let n = lastChar;
    if (l < i) n = p;
    const u = l < i ? pIsDelimOrPunct : !!InlineRules.punctuation.exec(n);
    if (m[4] && n.match(Other.unicodeAlphaNumeric)) return null;
    const d = m[1] || m[3] || '';
    if (!d || !n || u) {
      const k = [...m[0]].length - 1;
      let run = k, skip = 0;
      const y = i - l + k;
      const R = !!p.trim() && (!!d || (delim === '*' && !pIsDelimOrPunct));
      if (delim !== '*' && delim !== '_') return null;
      const rDelim = delim === '*' ? InlineRules.emStrongRDelimAst : InlineRules.emStrongRDelimUnd;
      const closer = this.#closer(masked, delim === '*' ? '*' : '_');
      const Q = masked.length - src.length + k;
      if (closer < Q) return null;
      const tail = masked.slice(-(src.length - k));
      const limit = closer - Q;
      rDelim.lastIndex = 0;
      let mm;
      while ((mm = rDelim.exec(tail)) !== null && !(mm.index > limit)) {
        const g = mm[1] || mm[2] || mm[3] || mm[4] || mm[5] || mm[6];
        if (!g) continue;
        const b0 = g.length;
        if (mm[3] || mm[4]) { run += b0; continue; }
        else if (mm[5] || mm[6] || R) {
          if (runEnd && (mm[5] || mm[6])) break;
          if (y % 3 && !((y + b0) % 3)) { skip += b0; continue; }
        }
        if ((run -= b0) > 0) continue;
        const b = Math.min(b0, b0 + run + skip);
        const firstLen = mm[0].codePointAt(0) >= 0x10000 ? 2 : 1;
        const whole = src.slice(0, k + mm.index + firstLen + b);
        const sub = new InlineLexer(this.state);
        if (Math.min(k, b) % 2) {
          const inner = whole.slice(1, -1);
          return { html: '<em>' + sub.run(inner).join('') + '</em>', len: whole.length };
        }
        const inner = whole.slice(2, -2);
        return { html: '<strong>' + sub.run(inner).join('') + '</strong>', len: whole.length };
      }
    }
    return null;
  }

  // plain-mode emphasis span finder: returns {inner, len} or null
  #emStrongSpan(src, masked, m, lastChar) {
    const r = this.#emStrong(src, masked, m, lastChar);
    if (!r) return null;
    // recover inner: html is <em>..</em> or <strong>..</strong>; recompute raw from len
    const raw = src.slice(0, r.len);
    const k = [...m[0]].length - 1;
    // inner length equals raw minus both delimiter runs; closing run mirrors opening
    const openLen = m[0].length - 1 + 1; // full opening run length (m[0] includes run + maybe punct)
    // safer: strip leading delimiter run and trailing run of the same chars
    const delim = m[0][0];
    let startIdx = 0;
    while (startIdx < raw.length && raw[startIdx] === delim) startIdx++;
    let endIdx = raw.length;
    while (endIdx > startIdx && raw[endIdx - 1] === delim) endIdx--;
    return { inner: raw.slice(startIdx, endIdx), len: r.len };
  }

  // marked's del(): returns {html, len} or null
  #del(src, masked, m) {
    const o = [...m[0]].length - 1;
    const closer = this.#closerDel(masked);
    const d = masked.length - src.length + o;
    if (closer < d) return null;
    const tail = masked.slice(-(src.length - o));
    const limit = closer - d;
    let p = o;
    InlineRules.delRDelim.lastIndex = 0;
    let mm;
    while ((mm = InlineRules.delRDelim.exec(tail)) !== null && !(mm.index > limit)) {
      const g = mm[1] || mm[2] || mm[3] || mm[4] || mm[5] || mm[6];
      if (!g) continue;
      const l0 = g.length;
      if (l0 !== o) continue;
      if (mm[3] || mm[4]) { p += l0; continue; }
      if ((p -= l0) > 0) continue;
      const l = Math.min(l0, l0 + p);
      const firstLen = [...mm[0]][0].length;
      const whole = src.slice(0, o + mm.index + firstLen + l);
      const inner = whole.slice(o, -o);
      const sub = new InlineLexer(this.state);
      return { html: '<del>' + sub.run(inner).join('') + '</del>', len: whole.length };
    }
    return null;
  }

  // plain-mode del span finder
  #delSpan(src, masked, m) {
    const r = this.#del(src, masked, m);
    if (!r) return null;
    const raw = src.slice(0, r.len);
    const o = [...m[0]].length - 1;
    return { inner: raw.slice(o, raw.length - o), len: r.len };
  }

  #closer(masked, ch) {
    const top = closerStack[closerStack.length - 1];
    return top && top.maskedSrc === masked ? top.em[ch] : computeClosers(masked).em[ch];
  }
  #closerDel(masked) {
    const top = closerStack[closerStack.length - 1];
    return top && top.maskedSrc === masked ? top.del : computeClosers(masked).del;
  }
}

function renderAutoLink(href, title, text) {
  const enc = encodeHref(href);
  if (enc === null) return escapeEncode(text);
  let a = '<a href="' + escapeEncode(enc) + '"';
  if (title) a += ' title="' + escapeNoEncode(title) + '"';
  return a + '>' + escapeEncode(text) + '</a>';
}

// ---------- block lexer ----------
class BlockLexer {
  constructor() {
    this.tokens = [];
    this.tokens.links = Object.create(null);
    this.inlineQueue = [];
    this.state = { inLink: false, inRawBlock: false, linkEmitted: false, top: true };
    this.inline = new InlineLexer(this.state);
    this.state.links = this.tokens.links;
  }

  lex(src) {
    src = src.replace(Other.carriageReturn, '\n');
    this.#blocks(src, this.tokens, false);
    for (let i = 0; i < this.inlineQueue.length; i++) {
      const q = this.inlineQueue[i];
      this.state.inRawBlock = false;
      const parts = this.inline.run(q.srcStr);
      q.parts.push(...parts);
    }
    this.inlineQueue.length = 0;
    return this.tokens;
  }

  inlineRef(src) {
    const holder = { parts: [], srcStr: src };
    this.inlineQueue.push(holder);
    return holder;
  }

  #blocks(src, out, isItem) {
    let min = Infinity;
    for (;;) {
      if (!src) break;
      if (src.length >= min) throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
      min = src.length;

      // space / newline
      let m = BlockRules.newline.exec(src);
      if (m && m[0].length > 0) {
        const prev = out.at(-1);
        if (m[0].length === 1 && prev !== undefined) prev.raw += '\n';
        else out.push({ type: 'space', raw: m[0] });
        src = src.substring(m[0].length);
        continue;
      }
      // indented code
      m = BlockRules.code.exec(src);
      if (m) {
        const raw = trimTrailingBlankLines(m[0]);
        const text = raw.replace(Other.codeRemoveIndent, '');
        const prev = out.at(-1);
        if (prev?.type === 'paragraph' || prev?.type === 'text') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + raw;
          prev.text += '\n' + text;
          this.inlineQueue.at(-1).srcStr = prev.text;
        } else {
          out.push({ type: 'code', raw, codeBlockStyle: 'indented', text });
        }
        src = src.substring(m[0].length);
        continue;
      }
      // fenced code
      m = BlockRules.fences.exec(src);
      if (m) {
        out.push({
          type: 'code',
          raw: m[0],
          lang: m[2] ? m[2].trim().replace(InlineRules.anyPunctuation, '$1') : m[2],
          text: removeIndentation(m[0], m[3] || ''),
        });
        src = src.substring(m[0].length);
        continue;
      }
      // ATX heading
      m = BlockRules.heading.exec(src);
      if (m) {
        let text = m[2].trim();
        if (Other.endingHash.test(text)) {
          const trimmed = rtrimStr(text, '#');
          if (!trimmed || Other.endingSpaceTabChar.test(trimmed)) text = trimmed.trim();
        }
        out.push({ type: 'heading', raw: rtrimStr(m[0], '\n'), depth: m[1].length, text, ref: this.inlineRef(text) });
        src = src.substring(m[0].length);
        continue;
      }
      // hr
      m = BlockRules.hr.exec(src);
      if (m) { out.push({ type: 'hr', raw: rtrimStr(m[0], '\n') }); src = src.substring(m[0].length); continue; }
      // blockquote
      m = BlockRules.blockquote.exec(src);
      if (m) {
        const bq = this.#blockquote(m, out);
        src = src.substring(bq.raw.length);
        continue;
      }
      // list
      m = BlockRules.list.exec(src);
      if (m) { src = this.#list(src, out); continue; }
      // html block
      m = BlockRules.html.exec(src);
      if (m) {
        const raw = trimTrailingBlankLines(m[0]);
        out.push({ type: 'html', block: true, raw, pre: m[1] === 'pre' || m[1] === 'script' || m[1] === 'style', text: raw });
        src = src.substring(m[0].length);
        continue;
      }
      // link reference definition
      m = BlockRules.def.exec(src);
      if (m) {
        if (!Other.startAngleBracket.test(m[2]) && indexOfUnescaped(m[2], '()') !== -1) {
          // marked: def() returns undefined, nothing consumed; fall through
        } else {
          const tag = normalizeLabel(m[1]);
          const href = m[2] ? m[2].replace(Other.hrefBrackets, '$1').replace(InlineRules.anyPunctuation, '$1') : '';
          const title = m[3] ? m[3].substring(1, m[3].length - 1).replace(InlineRules.anyPunctuation, '$1') : m[3];
          const raw = rtrimStr(m[0], '\n');
          const prev = out.at(-1);
          if (prev?.type === 'paragraph' || prev?.type === 'text') {
            prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + raw;
            prev.text += '\n' + raw;
            this.inlineQueue.at(-1).srcStr = prev.text;
          } else {
            if (!this.tokens.links[tag]) this.tokens.links[tag] = { href, title };
            out.push({ type: 'def', tag, raw, href, title });
          }
          src = src.substring(m[0].length);
          continue;
        }
      }
      // table
      m = BlockRules.table.exec(src);
      if (m && Other.tableDelimiter.test(m[2])) {
        const header = splitTableCells(m[1]);
        const alignCells = m[2].replace(Other.tableAlignChars, '').split('|');
        const rowLines = m[3]?.trim() ? m[3].replace(Other.tableRowBlankLine, '').split('\n') : [];
        if (header.length === alignCells.length) {
          const token = { type: 'table', raw: rtrimStr(m[0], '\n'), header: [], align: [], rows: [] };
          for (const c of alignCells) {
            if (Other.tableAlignRight.test(c)) token.align.push('right');
            else if (Other.tableAlignCenter.test(c)) token.align.push('center');
            else if (Other.tableAlignLeft.test(c)) token.align.push('left');
            else token.align.push(null);
          }
          for (let i = 0; i < header.length; i++)
            token.header.push({ text: header[i], ref: this.inlineRef(header[i]), header: true, align: token.align[i] });
          for (const line of rowLines)
            token.rows.push(splitTableCells(line, token.header.length).map((cell, i) => ({
              text: cell, ref: this.inlineRef(cell), header: false, align: token.align[i],
            })));
          out.push(token);
          src = src.substring(m[0].length);
          continue;
        }
      }
      // setext heading
      m = BlockRules.lheading.exec(src);
      if (m) {
        const text = m[1].trim();
        out.push({ type: 'heading', raw: rtrimStr(m[0], '\n'), depth: m[2].charAt(0) === '=' ? 1 : 2, text, ref: this.inlineRef(text) });
        src = src.substring(m[0].length);
        continue;
      }
      // paragraph
      m = BlockRules.paragraph.exec(src);
      if (m && this.state.top) {
        const text = m[1].charAt(m[1].length - 1) === '\n' ? m[1].slice(0, -1) : m[1];
        const ref = this.inlineRef(text);
        const prev = out.at(-1);
        if (isItem && prev?.type === 'paragraph') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + m[0];
          prev.text += '\n' + text;
          this.inlineQueue.pop();
          this.inlineQueue.at(-1).srcStr = prev.text;
        } else {
          out.push({ type: 'paragraph', raw: m[0], text, ref });
        }
        isItem = false; // marked: n = o.length !== e.length, false without extensions
        src = src.substring(m[0].length);
        continue;
      }
      // text
      m = BlockRules.text.exec(src);
      if (m) {
        const ref2 = this.inlineRef(m[0]);
        const prev = out.at(-1);
        if (prev?.type === 'text') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + m[0];
          prev.text += '\n' + m[0];
          this.inlineQueue.pop();
          this.inlineQueue.at(-1).srcStr = prev.text;
        } else {
          out.push({ type: 'text', raw: m[0], text: m[0], ref: ref2 });
        }
        src = src.substring(m[0].length);
        continue;
      }
      if (src) throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
      break;
    }
    this.state.top = true;
  }

  // marked's blockquote(): the regex match m is passed in; token pushed to out
  #blockquote(m, out) {
    let lines = rtrimStr(m[0], '\n').split('\n');
    let raw = '', text = '';
    const tokens = [];
    for (;;) {
      const group = [];
      let p = 0, found = false;
      for (p = 0; p < lines.length; p++) {
        if (Other.blockquoteStart.test(lines[p])) { group.push(lines[p]); found = true; }
        else if (!found) group.push(lines[p]);
        else break;
      }
      lines = lines.slice(p);
      const joined = group.join('\n');
      const inner = joined
        .replace(Other.blockquoteMarkerWhitespace, (g, marks, ws) => marks + expandTabsIn(ws, marks.length))
        .replace(Other.blockquoteSetextReplace, '\n    $1')
        .replace(Other.blockquoteSetextReplace2, '');
      raw = raw ? `${raw}\n${joined}` : joined;
      text = text ? `${text}\n${inner}` : inner;
      const top = this.state.top;
      this.state.top = true;
      this.#blocks(inner, tokens, true);
      this.state.top = top;
      if (lines.length === 0) break;
      const last = tokens.at(-1);
      if (last?.type === 'code' || last?.type === 'heading' || last?.type === 'hr' || last?.type === 'html' || last?.type === 'table') break;
      if (last?.type === 'blockquote') {
        const next = last;
        const rest = lines.join('\n');
        const merged = next.raw + '\n' + rest.replace(Other.blockquoteSetextReplace2, '');
        const mm = BlockRules.blockquote.exec(merged);
        if (mm) {
          const redoTokens = [];
          const saved = lines;
          this.#blockquote(mm, redoTokens);
          const redo = redoTokens[0];
          if (redo) {
            tokens[tokens.length - 1] = redo;
            const trailing = merged.substring(redo.raw.length).replace(/^\n/, '');
            const trailingCount = trailing ? trailing.split('\n').length : 0;
            const consumed = trailingCount ? saved.slice(0, -trailingCount) : saved;
            if (consumed.length > 0) raw = `${raw}\n${consumed.join('\n')}`;
            text = text.substring(0, text.length - next.text.length) + redo.text;
            lines = saved.slice(consumed.length);
            if (lines.length > 0 && Other.blockquoteStart.test(lines[0])) continue;
          }
        }
        break;
      } else if (last?.type === 'list') {
        const prev = last;
        const merged = prev.raw + '\n' + lines.join('\n');
        const mm = BlockRules.list.exec(merged);
        if (mm) {
          const redoTokens = [];
          const saved = lines;
          const after = this.#list(merged, redoTokens);
          const redo = redoTokens[0];
          if (redo) {
            tokens[tokens.length - 1] = redo;
            const extra = redo.raw.length > prev.raw.length
              ? merged.slice(prev.raw.length + 1, redo.raw.length).split('\n').length : 0;
            if (extra > 0) {
              const consumedLines = saved.slice(0, extra).join('\n');
              raw = `${raw}\n${consumedLines}`;
              text = `${text}\n${consumedLines}`;
            }
            lines = saved.slice(extra);
            continue;
          }
        }
        break;
      }
      // marked: any other last token (paragraph etc.) loops again to collect
      // lazy continuation lines
    }
    const token = { type: 'blockquote', raw, tokens, text };
    out.push(token);
    return token;
  }

  // marked's list(): e is the full remaining source starting with the list.
  // Returns the source after the list.
  #list(e, out) {
    const n = e;
    const e0 = e;
    const s = () => n.length - e.length;
    let m = BlockRules.list.exec(e);
    if (!m) return e;
    const r0 = m[1].trim();
    const ordered = r0.length > 1;
    const token = { type: 'list', raw: '', ordered, start: ordered ? +r0.slice(0, -1) : '', loose: false, items: [] };
    let r = ordered ? `\\d{1,9}\\${r0.slice(-1)}` : `\\${r0}`;
    const itemRe = Other.listItemRegex(r);
    let loosePending = false;
    for (;;) {
      let blank = false, d = '';
      m = itemRe.exec(e);
      if (!m || BlockRules.hr.test(e)) break;
      const k = s();
      e = e.substring(m[0].length);
      const g = m[2].split('\n', 1)[0];
      const b = m[1].length;
      let mm = g.replace(Other.leadingSpaceTab, (v) => expandTabsIn(v, b));
      let f = e.split('\n', 1)[0];
      let y = !mm.trim();
      let R = 0;
      if (y) R = b + 1;
      else {
        R = mm.search(Other.nonSpaceChar);
        R = R > 4 ? 1 : R;
        d = mm.slice(R);
        R += b;
      }
      if (y && Other.blankLine.test(f)) { e = e.substring(f.length + 1); blank = true; }
      if (!blank) {
        const nextBullet = Other.nextBulletRegex(R);
        const hrRe = Other.hrRegex(R);
        const fencesRe = Other.fencesBeginRegex(R);
        const headingRe = Other.headingBeginRegex(R);
        const htmlRe = Other.htmlBeginRegex(R);
        const bqRe = Other.blockquoteBeginRegex(R);
        for (;;) {
          if (!e) break;
          const U = e.split('\n', 1)[0];
          f = U;
          const Z = f.replace(Other.leadingSpaceTab, (v) => expandTabsIn(v));
          if (fencesRe.test(f) || headingRe.test(f) || htmlRe.test(f) || bqRe.test(f) || nextBullet.test(f) || hrRe.test(f)) break;
          if (Z.search(Other.nonSpaceChar) >= R || !f.trim()) {
            d += '\n' + Z.slice(R);
          } else {
            if (y || mm.replace(Other.tabCharGlobal, '    ').search(Other.nonSpaceChar) >= 4 ||
                fencesRe.test(mm) || headingRe.test(mm) || htmlRe.test(mm) || hrRe.test(mm)) break;
            const qe = /^ {0,3}(?:=+|-+) *$/.test(f) && BlockRules.lheading.test(`${mm}\n${f}`)
              ? `    ${Z.replace(/^ {0,3}/, '')}` : f;
            d += '\n' + qe;
          }
          y = !f.trim();
          e = e.substring(U.length + 1);
          mm = Z.slice(R);
          if (!e) break;
        }
      }
      const A = n.slice(k, s());
      if (!token.loose) {
        if (loosePending) token.loose = true;
        else if (Other.doubleBlankLine.test(A)) loosePending = true;
      }
      token.items.push({
        type: 'list_item', raw: A,
        task: Other.listIsTask.test(d), loose: false,
        text: d, tokens: [],
      });
      if (!e) break;
    }
    const last = token.items.at(-1);
    if (last) {
      last.raw = last.raw.trimEnd();
      last.text = last.text.trimEnd();
    } else {
      return e;
    }
    token.raw = n.slice(0, s()).trimEnd();
    for (const item of token.items) {
      this.state.top = false;
      item.parts = { parts: [] };
      const subOut = [];
      this.#blocks(item.text, subOut, false);
      item.tokens = subOut;
      if (!token.loose) {
        const spaces = subOut.filter((t) => t.type === 'space');
        token.loose = spaces.length > 0 && spaces.some((t) => Other.anyLine.test(t.raw));
      }
    }
    for (const item of token.items) {
      const first = item.tokens[0];
      if (item.task && (first?.type === 'text' || first?.type === 'paragraph')) {
        item.text = item.text.replace(Other.listReplaceTask, '');
        first.raw = first.raw.replace(Other.listReplaceTask, '');
        first.text = first.text.replace(Other.listReplaceTask, '');
        for (let i = this.inlineQueue.length - 1; i >= 0; i--) {
          if (Other.listIsTask.test(this.inlineQueue[i].srcStr)) {
            this.inlineQueue[i].srcStr = this.inlineQueue[i].srcStr.replace(Other.listReplaceTask, '');
            break;
          }
        }
        const cb = Other.listTaskCheckbox.exec(item.raw);
        if (cb) {
          const checkbox = { type: 'checkbox', raw: cb[0] + ' ', checked: cb[0] !== '[ ]' };
          item.checked = checkbox.checked;
          if (token.loose) {
            if (first && (first.type === 'paragraph' || first.type === 'text')) {
              first.raw = checkbox.raw + first.raw;
              first.text = checkbox.raw + first.text;
              if (first.ref) first.ref.parts.unshift('<input ' + (checkbox.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ');
              else if (first.tokens) first.tokens.unshift(checkbox);
              else first.tokens = [checkbox];
            } else {
              item.tokens.unshift({ type: 'paragraph', raw: checkbox.raw, text: checkbox.raw, tokens: [checkbox] });
            }
          } else {
            item.tokens.unshift(checkbox);
          }
        }
      } else if (item.task) {
        item.task = false;
      }
    }
    if (token.loose) {
      for (const item of token.items) {
        item.loose = true;
        for (const t of item.tokens) if (t.type === 'text') t.type = 'paragraph';
      }
    }
    out.push(token);
    return e0.substring(token.raw.length);
  }
}

// ---------- renderer ----------
function renderInlineParts(ref, out) {
  const parts = ref.parts;
  if (!parts) { out.push(''); return; }
  for (const p of parts) out.push(p);
}
function renderInlineHtml(ref, out) {
  const parts = ref.parts;
  if (!parts) { out.push(''); return; }
  for (const p of parts) out.push(p);
}
function renderBlocks(tokens, out) {
  for (const t of tokens) {
    switch (t.type) {
      case 'space': break;
      case 'hr': out.push('<hr>\n'); break;
      case 'heading': out.push(`<h${t.depth}>`); renderInlineParts(t.ref, out); out.push(`</h${t.depth}>\n`); break;
      case 'code': {
        const lang = t.lang ? t.lang.match(Other.notSpaceStart)?.[0] : null;
        const text = t.text ? t.text.replace(Other.endingNewline, '') + '\n' : '';
        if (lang) out.push('<pre><code class="language-' + escapeNoEncode(lang) + '">' + escapeEncode(text) + '</code></pre>\n');
        else out.push('<pre><code>' + escapeEncode(text) + '</code></pre>\n');
        break;
      }
      case 'table': {
        let head = '', body = '';
        for (const cell of t.header) head += renderCell(cell);
        head = `<tr>\n${head}</tr>\n`;
        for (const row of t.rows) {
          let r = '';
          for (const cell of row) r += renderCell(cell);
          body += `<tr>\n${r}</tr>\n`;
        }
        if (body) body = `<tbody>${body}</tbody>`;
        out.push(`<table>\n<thead>\n${head}</thead>\n${body}</table>\n`);
        break;
      }
      case 'blockquote': out.push('<blockquote>\n'); renderBlocks(t.tokens, out); out.push('</blockquote>\n'); break;
      case 'list': {
        const tag = t.ordered ? 'ol' : 'ul';
        const startAttr = t.ordered && t.start !== 1 ? ` start="${t.start}"` : '';
        out.push(`<${tag}${startAttr}>\n`);
        for (const item of t.items) {
          out.push('<li>');
          renderBlocks(item.tokens, out);
          out.push('</li>\n');
        }
        out.push(`</${tag}>\n`);
        break;
      }
      case 'html': out.push(t.text); break;
      case 'def': break;
      case 'paragraph': out.push('<p>'); if (t.ref) renderInlineParts(t.ref, out); else renderInlineTokens(t.tokens, out); out.push('</p>\n'); break;
      case 'checkbox': out.push('<input ' + (t.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> '); break;
      case 'text': {
        if ('ref' in t && t.ref) renderInlineParts(t.ref, out);
        else if ('tokens' in t && t.tokens) renderInlineTokens(t.tokens, out);
        else if ('escaped' in t && t.escaped) out.push(t.text);
        else out.push(escapeNoEncode(t.text));
        break;
      }
      default: throw new Error('Token with "' + t.type + '" type was not found.');
    }
  }
}

function renderInlineTokens(tokens, out) {
  for (const t of tokens) {
    switch (t.type) {
      case 'escape': out.push(escapeNoEncode(t.text)); break;
      case 'html': out.push(t.text); break;
      case 'checkbox': out.push('<input ' + (t.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> '); break;
      case 'text': {
        if ('tokens' in t && t.tokens) renderInlineTokens(t.tokens, out);
        else if ('escaped' in t && t.escaped) out.push(t.text);
        else out.push(escapeNoEncode(t.text));
        break;
      }
      default: throw new Error('Token with "' + t.type + '" type was not found.');
    }
  }
}
function renderCell(cell) {
  const tag = cell.header ? 'th' : 'td';
  const open = cell.align ? `<${tag} align="${cell.align}">` : `<${tag}>`;
  const parts = [];
  renderInlineParts(cell.ref, parts);
  return open + parts.join('') + `</${tag}>\n`;
}

// ---------- entry ----------
export function parse(markdown) {
  const lexer = new BlockLexer();
  const tokens = lexer.lex(markdown);
  const out = [];
  renderBlocks(tokens, out);
  return out.join('');
}
