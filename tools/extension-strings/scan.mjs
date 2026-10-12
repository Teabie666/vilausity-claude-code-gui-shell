// A small scanner for minified JavaScript that finds string and template literals and the
// context they sit in (the object property they are the value of, a JSX children array, a
// call's arguments). Used by extract.mjs; heuristic where JavaScript is ambiguous (a `/`
// after `)` or `}` counts as division), which is fine for finding UI text.

/** Keywords after which a `/` starts a regular expression. */
const REGEX_AFTER_WORD = new Set([
  'return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'instanceof', 'yield', 'await',
]);
const IDENTIFIER_START = /[A-Za-z_$\u0080-￿]/;
const IDENTIFIER_PART = /[\w$\u0080-￿]/;

/** The value of a string literal's source between its quotes. */
export function cook(raw) {
  return raw.replace(/\\(u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|\r\n|[\s\S])/g, (match, escape, codePoint, unicode, hex) => {
    if (codePoint) return String.fromCodePoint(Number.parseInt(codePoint, 16));
    if (unicode) return String.fromCharCode(Number.parseInt(unicode, 16));
    if (hex) return String.fromCharCode(Number.parseInt(hex, 16));
    switch (escape) {
      case 'n':
        return '\n';
      case 't':
        return '\t';
      case 'r':
        return '\r';
      case 'b':
        return '\b';
      case 'f':
        return '\f';
      case 'v':
        return '\v';
      case '0':
        return '\0';
      case '\n':
      case '\r\n':
        return '';
      default:
        return escape;
    }
  });
}

/**
 * Calls `onLiteral(literal)` for every string and template literal in `source`:
 *   { kind: 'string', value, start, end, context }
 *   { kind: 'template', parts: [static text...], start, end, context }   (parts.length - 1 variables)
 * `context` is { property, after, children, elements, calls }: `property` is the name of the
 * object property whose value the literal is part of (at the same nesting level), `after` the
 * token before it (`return`, `?`...), `children` whether it is in a `children:[...]` array
 * (React renders each element as its own text node: a sentence in pieces), `elements` that
 * array's elements once the scan is done (a string for a literal alone, null for anything
 * else), `calls` the names of the calls it is inside (innermost last), and `localizeLike`
 * whether it is the second argument of a call whose first is a key or a number.
 */
export function scanLiterals(source, onLiteral) {
  /** Bracket frames: { char, property, children, elements, element, call, template } */
  const frames = [{ char: '', property: undefined, children: false, call: undefined }];
  let previous = { type: 'start', value: '' };
  let beforePrevious = { type: 'start', value: '' };
  let thirdPrevious = { type: 'start', value: '' };
  /** The bracket frame closed last, and whether it was an object that opened a call's arguments. */
  let lastClosed = { firstArgument: false };
  let i = 0;
  const n = source.length;

  const top = () => frames[frames.length - 1];
  const push = (token) => {
    thirdPrevious = beforePrevious;
    beforePrevious = previous;
    previous = token;
  };
  const contextOf = () => {
    const frame = top();
    return {
      property: frame.property,
      after: previous.type === 'word' || previous.type === 'punct' ? previous.value : previous.type,
      children: frame.children,
      elements: frame.children ? frame.elements : undefined,
      calls: frames.map((f) => f.call).filter(Boolean),
      properties: frames.map((f) => f.property).filter(Boolean),
      // `f("someKey", <this>)`, `f(123, <this>)` or `f({key, comment}, <this>)`: how Monaco's
      // localize() calls look compiled.
      localizeLike:
        previous.value === ',' &&
        ((thirdPrevious.value === '(' &&
          (beforePrevious.type === 'number' || (beforePrevious.type === 'string' && /^[\w.$-]+$/.test(beforePrevious.value)))) ||
          (beforePrevious.value === '}' && lastClosed.firstArgument)),
    };
  };
  /** Records an element of a children array: a string (the literal alone) or null (anything else). */
  const markElement = (value) => {
    const frame = top();
    if (!frame.children) return;
    if (frame.element === undefined && value !== null) frame.element = value;
    else frame.element = null;
  };
  const closeElement = (frame) => {
    if (frame.children && frame.element !== undefined) frame.elements.push(frame.element);
    frame.element = undefined;
  };

  const readQuoted = (quote) => {
    const start = i;
    i++;
    let raw = '';
    while (i < n && source[i] !== quote) {
      if (source[i] === '\\') {
        raw += source.slice(i, i + 2);
        i += 2;
      } else {
        raw += source[i++];
      }
    }
    i++;
    return { start, raw };
  };

  // Template literals nest: a `${` frame resumes its template when it closes.
  const readTemplateChunk = (template) => {
    let raw = '';
    while (i < n) {
      const c = source[i];
      if (c === '\\') {
        raw += source.slice(i, i + 2);
        i += 2;
      } else if (c === '`') {
        i++;
        template.parts.push(cook(raw));
        return true;
      } else if (c === '$' && source[i + 1] === '{') {
        i += 2;
        template.parts.push(cook(raw));
        frames.push({ char: '${', property: undefined, children: false, call: undefined, template });
        return false;
      } else {
        raw += c;
        i++;
      }
    }
    template.parts.push(cook(raw));
    return true;
  };
  const finishTemplate = (template) => {
    template.end = i;
    markElement(template.parts.length === 1 ? template.parts[0] : null);
    onLiteral(template);
    push({ type: 'template', value: '`' });
  };

  while (i < n) {
    const c = source[i];
    if (c === ' ' || c === '\n' || c === '\r' || c === '\t') {
      i++;
      continue;
    }
    if (c === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i);
      i = end < 0 ? n : end;
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const context = contextOf();
      const { start, raw } = readQuoted(c);
      const value = cook(raw);
      markElement(value);
      onLiteral({ kind: 'string', value, start, end: i, context });
      push({ type: 'string', value });
      continue;
    }
    if (c === '`') {
      const template = { kind: 'template', parts: [], start: i, end: i, context: contextOf() };
      i++;
      if (readTemplateChunk(template)) finishTemplate(template);
      continue;
    }
    if (c === '/') {
      const regex =
        previous.type === 'start' ||
        (previous.type === 'punct' && !/^[)\]}]$/.test(previous.value)) ||
        (previous.type === 'word' && REGEX_AFTER_WORD.has(previous.value));
      if (regex) {
        i++;
        let inClass = false;
        while (i < n) {
          const r = source[i];
          if (r === '\\') i += 2;
          else if (r === '[') {
            inClass = true;
            i++;
          } else if (r === ']') {
            inClass = false;
            i++;
          } else if (r === '/' && !inClass) break;
          else if (r === '\n') break;
          else i++;
        }
        i++;
        while (i < n && /[a-z]/.test(source[i])) i++;
        markElement(null);
        push({ type: 'regex', value: '/' });
        continue;
      }
    }
    if (IDENTIFIER_START.test(c)) {
      let end = i + 1;
      while (end < n && IDENTIFIER_PART.test(source[end])) end++;
      const word = source.slice(i, end);
      i = end;
      markElement(null);
      push({ type: 'word', value: word });
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(source[i + 1] ?? ''))) {
      i++;
      while (i < n && /[\w.]/.test(source[i])) i++;
      markElement(null);
      push({ type: 'number', value: '0' });
      continue;
    }
    // Punctuation.
    i++;
    if (c === '(' || c === '[' || c === '{') {
      const isChildren = c === '[' && previous.value === ':' && beforePrevious.value === 'children';
      markElement(null);
      const call = c === '(' && previous.type === 'word' ? previous.value : undefined;
      frames.push({
        char: c,
        property: undefined,
        children: isChildren,
        elements: isChildren ? [] : undefined,
        element: undefined,
        call,
        firstArgument: c === '{' && previous.value === '(',
      });
      push({ type: 'punct', value: c });
      continue;
    }
    if (c === ')' || c === ']' || c === '}') {
      const frame = top();
      if (frame.char === '${' && c === '}') {
        frames.pop();
        if (readTemplateChunk(frame.template)) finishTemplate(frame.template);
        continue;
      }
      if (frames.length > 1) {
        closeElement(frame);
        frames.pop();
        lastClosed = { firstArgument: frame.firstArgument === true };
      }
      push({ type: 'punct', value: c });
      continue;
    }
    if (c === ',') {
      const frame = top();
      closeElement(frame);
      frame.property = undefined;
      push({ type: 'punct', value: c });
      continue;
    }
    if (c === ':') {
      // `name:` starts a property only right after `{` or `,` (else it is a ternary's `:`).
      const frame = top();
      const name = previous.type === 'word' || previous.type === 'string' ? previous.value : undefined;
      if (name !== undefined && (beforePrevious.value === '{' || beforePrevious.value === ',')) {
        frame.property = name;
        frame.element = undefined;
      }
      push({ type: 'punct', value: c });
      continue;
    }
    if (c === ';') {
      top().property = undefined;
    }
    markElement(null);
    push({ type: 'punct', value: c });
  }
}
