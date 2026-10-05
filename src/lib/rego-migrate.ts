/**
 * Rewrites that let `opa fmt --v0-v1` migrate a Rego v0 module it would
 * otherwise refuse.
 *
 * The formatter does the syntax: `if` before a body, `contains` for a partial
 * set, `:=` for a rule value, `import rego.v1`. It refuses two things a v0
 * module can legally hold:
 *
 *  - a name Rego v1 reserves: a rule called `contains`, `every`, `if` or `in`,
 *    or a local variable called one of the last three, which no longer parses;
 *  - a call to a built-in v1 removed (`re_match`, `all`, `any`, `set_diff`,
 *    `net.cidr_overlap`, the `cast_*` family), which fails type checking.
 *
 * Both are fixed here on the v0 text, at the locations `opa parse
 * --v0-compatible` reports, so every other character reaches the formatter as
 * written and line numbers do not move. A reserved name is renamed everywhere
 * in the module. A removed built-in with a same-behaving v1 counterpart is
 * renamed to it, unless the module calls both and mocks one with `with`; that
 * one, like each of the others, is replaced by a helper function appended to
 * the module, which returns what the built-in returned for every argument,
 * including undefined for one of the wrong type.
 */

/** A change made to the source, for the caller to review. */
export interface MigrationRewrite {
  /** Line in the original source. */
  line: number;
  from: string;
  to: string;
}

export interface MigrationPlan {
  /** The v0 source with the rewrites applied and any helpers appended. */
  source: string;
  rewrites: MigrationRewrite[];
  /** What was renamed or added and why, one sentence each. */
  notes: string[];
  /** Rules renamed because v1 reserves their name: old name to new. */
  renamedRules: Record<string, string>;
}

/**
 * Words v1 reserves that a v0 rule or local variable may be named. `contains`
 * still parses as a variable in some places (`contains := x`) but not in
 * others (`some contains`), so it is renamed wherever it names one.
 */
const RESERVED = new Set(['contains', 'every', 'if', 'in']);

interface Helper {
  /** Preferred function name. */
  name: string;
  /** The built-in the helper calls, which a `with` in the module must not mock. */
  calls?: string;
  /**
   * Module text defining the function, with NAME for its name and @IF@ where
   * a module that imports rego.v1 needs `if`; without that import it is v0.
   */
  body: string;
}

/**
 * A removed built-in is renamed to its v1 counterpart, or replaced by a
 * helper. A renamed one also carries helpers (`apart`), each calling a
 * different built-in, for a module where the rename would change what a call
 * reaches: one that mocks either name with `with` while calling both, since
 * in v0 each mock reached only calls made under its own name, and one that
 * binds the counterpart's first segment (a variable named `regex`), which
 * hides the built-in. The first helper whose built-in the module does not
 * mock is used.
 */
type Replacement = { rename: string; apart: Helper[] } | { helper: Helper };

const reMatchHelper = (calls: string, test: string): Helper => ({
  name: 're_match_',
  calls,
  body: `# re_match() was removed in Rego v1. NAME(pattern, value) returns what
# re_match(pattern, value) did, without calling regex.match.
NAME(pattern, value) = r@IF@ {
	r := ${test}
}
`,
});

const castHelper = (builtin: string, name: string, check: string, what: string): Helper => ({
  name,
  body: `# ${builtin}() was removed in Rego v1. NAME(x) returns what ${builtin}(x) did:
# x when it is ${what}, undefined otherwise.
NAME(x) = x@IF@ {
	${check}(x)
}
`,
});

/**
 * Built-ins Rego v1 removed, and what replaces each. Looked up only through
 * `removedBuiltin`, since a Rego name such as `constructor` is also a key of
 * every plain object.
 */
const REMOVED_BUILTINS: Record<string, Replacement> = {
  re_match: {
    rename: 'regex.match',
    apart: [
      reMatchHelper('regex.find_n', 'count(regex.find_n(pattern, value, 1)) > 0'),
      reMatchHelper(
        'regex.find_all_string_submatch_n',
        'count(regex.find_all_string_submatch_n(pattern, value, 1)) > 0',
      ),
    ],
  },
  'net.cidr_overlap': {
    rename: 'net.cidr_contains',
    apart: [
      {
        name: 'cidr_overlap',
        calls: 'net.cidr_contains_matches',
        body: `# net.cidr_overlap() was removed in Rego v1. NAME(cidr, cidr_or_ip) returns
# what net.cidr_overlap(cidr, cidr_or_ip) did, without calling
# net.cidr_contains.
NAME(cidr, cidr_or_ip) = r@IF@ {
	is_string(cidr)
	is_string(cidr_or_ip)
	r := count(net.cidr_contains_matches(cidr, cidr_or_ip)) > 0
}
`,
      },
    ],
  },
  all: {
    helper: {
      name: 'all_true',
      body: `# all() was removed in Rego v1. NAME(xs) returns what all(xs) did: true when
# every element of the array or set is true, so also when it is empty, false
# otherwise, and undefined for anything but an array or a set.
NAME(xs) = r@IF@ {
	{"array", "set"}[type_name(xs)]
	r := count([x | x := xs[_]; x != true]) == 0
}
`,
    },
  },
  any: {
    helper: {
      name: 'any_true',
      body: `# any() was removed in Rego v1. NAME(xs) returns what any(xs) did: true when
# some element of the array or set is true, false otherwise (so also when it is
# empty), and undefined for anything but an array or a set.
NAME(xs) = r@IF@ {
	{"array", "set"}[type_name(xs)]
	r := count([x | x := xs[_]; x == true]) > 0
}
`,
    },
  },
  set_diff: {
    helper: {
      name: 'set_difference',
      body: `# set_diff() was removed in Rego v1. NAME(a, b) returns what set_diff(a, b)
# did: the elements of set a that are not in set b, undefined unless both are
# sets.
NAME(a, b) = r@IF@ {
	is_set(a)
	is_set(b)
	r := a - b
}
`,
    },
  },
  cast_array: {
    helper: {
      name: 'as_array',
      body: `# cast_array() was removed in Rego v1. NAME(x) returns what cast_array(x)
# did: an array unchanged, a set as an array of its elements, undefined
# otherwise.
NAME(x) = x@IF@ {
	is_array(x)
}

NAME(x) = r@IF@ {
	is_set(x)
	r := [e | e := x[_]]
}
`,
    },
  },
  cast_set: {
    helper: {
      name: 'as_set',
      body: `# cast_set() was removed in Rego v1. NAME(x) returns what cast_set(x) did:
# a set unchanged, an array as the set of its elements, undefined otherwise.
NAME(x) = x@IF@ {
	is_set(x)
}

NAME(x) = r@IF@ {
	is_array(x)
	r := {e | e := x[_]}
}
`,
    },
  },
  cast_string: { helper: castHelper('cast_string', 'as_string', 'is_string', 'a string') },
  cast_boolean: { helper: castHelper('cast_boolean', 'as_boolean', 'is_boolean', 'a boolean') },
  cast_null: { helper: castHelper('cast_null', 'as_null', 'is_null', 'null') },
  cast_object: { helper: castHelper('cast_object', 'as_object', 'is_object', 'an object') },
};

const removedBuiltin = (name: string): Replacement | undefined =>
  Object.hasOwn(REMOVED_BUILTINS, name) ? REMOVED_BUILTINS[name] : undefined;

interface Term {
  type: string;
  value: unknown;
  location?: { row?: number; col?: number; text?: string };
}

interface Edit {
  row: number;
  col: number;
  /** The text OPA reports at that location, which must be what is there. */
  expected: string;
  replacement: string;
  from: string;
  to: string;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isTerm = (v: unknown): v is Term =>
  isObject(v) && typeof v['type'] === 'string' && 'value' in v;

const decode = (text: string | undefined): string | undefined =>
  text === undefined ? undefined : Buffer.from(text, 'base64').toString('utf8');

/** Every value in the tree, depth first. */
function* walk(node: unknown): Generator<unknown> {
  yield node;
  if (Array.isArray(node)) {
    for (const child of node) yield* walk(child);
  } else if (isObject(node)) {
    for (const child of Object.values(node)) yield* walk(child);
  }
}

/** The dotted name of a ref made of a var and plain string segments. */
function refName(term: Term): string | undefined {
  if (term.type !== 'ref' || !Array.isArray(term.value)) return undefined;
  const parts: string[] = [];
  for (const [i, seg] of (term.value as unknown[]).entries()) {
    if (!isTerm(seg) || typeof seg.value !== 'string') return undefined;
    if (i === 0 ? seg.type !== 'var' : seg.type !== 'string') return undefined;
    parts.push(seg.value);
  }
  return parts.join('.');
}

/**
 * Refs in operator position: the function of a call, and the target of a
 * `with`. A var at the head of one names a function, so a reserved word there
 * that is not a rule of this module is the built-in (`contains("abc", "b")`),
 * which keeps its name.
 */
function operatorRefs(ast: unknown): Set<Term> {
  const out = new Set<Term>();
  for (const node of walk(ast)) {
    if (!isObject(node)) continue;
    if (Array.isArray(node['terms']) && isTerm(node['terms'][0])) out.add(node['terms'][0]);
    if (isTerm(node) && node.type === 'call' && Array.isArray(node.value)) {
      const fn = (node.value as unknown[])[0];
      if (isTerm(fn)) out.add(fn);
    }
    if (Array.isArray(node['with'])) {
      for (const w of node['with'] as unknown[]) {
        if (isObject(w) && isTerm(w['target'])) out.add(w['target']);
      }
    }
  }
  return out;
}

/** The dotted name of a var or of a ref made of a var and plain strings. */
const termName = (term: Term): string | undefined =>
  term.type === 'var' && typeof term.value === 'string' ? term.value : refName(term);

/** The names a module calls or mocks: every function it names in operator position. */
export function calledNames(ast: unknown): Set<string> {
  const names = new Set<string>();
  for (const term of operatorRefs(ast)) {
    const name = termName(term);
    if (name !== undefined) names.add(name);
  }
  return names;
}

/**
 * Names the module binds itself: its rules, its imports, and its variables,
 * function arguments included. A var at the head of a call or of a `with`
 * target names a function there, so it does not count.
 */
function boundNames(ast: unknown): Set<string> {
  const names = new Set([...ruleNames(ast), ...importBindings(ast)]);
  const operatorHeads = new Set<unknown>();
  for (const term of operatorRefs(ast)) {
    operatorHeads.add(
      term.type === 'ref' && Array.isArray(term.value) ? (term.value as unknown[])[0] : term,
    );
  }
  for (const node of walk(ast)) {
    if (isTerm(node) && node.type === 'var' && typeof node.value === 'string') {
      if (!operatorHeads.has(node)) names.add(node.value);
    }
  }
  return names;
}

/** The variables a pattern binds: a var, or those inside an array or object. */
function patternVars(term: unknown, out: Set<string>): void {
  if (!isTerm(term)) return;
  if (term.type === 'var' && typeof term.value === 'string') {
    out.add(term.value);
  } else if (term.type === 'array' && Array.isArray(term.value)) {
    for (const item of term.value as unknown[]) patternVars(item, out);
  } else if (term.type === 'object' && Array.isArray(term.value)) {
    for (const pair of term.value as unknown[]) {
      if (Array.isArray(pair)) patternVars(pair[1], out);
    }
  }
}

/**
 * The variables a body declares at its own level: the target of `:=` and the
 * names `some` introduces. Nested bodies (comprehensions, `every`) declare
 * their own.
 */
function declaredIn(body: unknown): Set<string> {
  const out = new Set<string>();
  if (!Array.isArray(body)) return out;
  for (const expr of body as unknown[]) {
    const terms = isObject(expr) ? expr['terms'] : undefined;
    if (Array.isArray(terms)) {
      const op: unknown = terms[0];
      if (isTerm(op) && refName(op) === 'assign') patternVars(terms[1], out);
    } else if (isObject(terms) && Array.isArray(terms['symbols'])) {
      for (const symbol of terms['symbols'] as unknown[]) {
        // `some k, v in xs` is a call whose last argument is the collection.
        if (isTerm(symbol) && symbol.type === 'call' && Array.isArray(symbol.value)) {
          for (const arg of (symbol.value as unknown[]).slice(1, -1)) patternVars(arg, out);
        } else {
          patternVars(symbol, out);
        }
      }
    }
  }
  return out;
}

/**
 * The refs that start with a local variable of their rule: a function
 * argument, or a variable declared in the body or in an enclosing one. In v0 a
 * local may reuse the name an import binds, and then `name.field` reads the
 * local, not the imported document.
 */
function localRefs(ast: unknown): Set<Term> {
  const out = new Set<Term>();
  const visit = (node: unknown, scope: ReadonlySet<string>): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child, scope);
      return;
    }
    if (!isObject(node)) return;
    if (isTerm(node)) {
      if (node.type === 'ref' && Array.isArray(node.value)) {
        const head = (node.value as unknown[])[0];
        if (isTerm(head) && head.type === 'var' && scope.has(head.value as string)) out.add(node);
      }
      if (node.type.endsWith('comprehension') && isObject(node.value)) {
        const inner = new Set([...scope, ...declaredIn(node.value['body'])]);
        for (const child of Object.values(node.value)) visit(child, inner);
        return;
      }
    }
    // `every k, v in domain { body }`
    if ('domain' in node && Array.isArray(node['body'])) {
      visit(node['domain'], scope);
      const inner = new Set([...scope, ...declaredIn(node['body'])]);
      patternVars(node['key'], inner);
      patternVars(node['value'], inner);
      visit(node['body'], inner);
      return;
    }
    for (const child of Object.values(node)) visit(child, scope);
  };
  const visitRule = (rule: unknown, args: ReadonlySet<string>): void => {
    if (!isObject(rule)) return;
    const head = isObject(rule['head']) ? rule['head'] : undefined;
    const own = new Set(args);
    for (const arg of Array.isArray(head?.['args']) ? (head['args'] as unknown[]) : []) {
      patternVars(arg, own);
    }
    const scope = new Set([...own, ...declaredIn(rule['body'])]);
    visit(head, scope);
    visit(rule['body'], scope);
    // An `else` shares its function's arguments.
    if (rule['else'] !== undefined) visitRule(rule['else'], own);
  };
  const rules = isObject(ast) && Array.isArray(ast['rules']) ? (ast['rules'] as unknown[]) : [];
  for (const rule of rules) visitRule(rule, new Set());
  return out;
}

/** The names a module mocks with `with`. */
function mockedNames(ast: unknown): Set<string> {
  const names = new Set<string>();
  for (const node of walk(ast)) {
    if (!isObject(node) || !Array.isArray(node['with'])) continue;
    for (const w of node['with'] as unknown[]) {
      const name = isObject(w) && isTerm(w['target']) ? termName(w['target']) : undefined;
      if (name !== undefined) names.add(name);
    }
  }
  return names;
}

/** Names of the rules this module defines. */
function ruleNames(ast: unknown): Set<string> {
  const names = new Set<string>();
  const rules = isObject(ast) && Array.isArray(ast['rules']) ? (ast['rules'] as unknown[]) : [];
  for (const rule of rules) {
    const head = isObject(rule) && isObject(rule['head']) ? rule['head'] : undefined;
    if (!head) continue;
    if (typeof head['name'] === 'string' && head['name'].length > 0) names.add(head['name']);
    const ref = Array.isArray(head['ref']) ? (head['ref'] as unknown[]) : [];
    if (isTerm(ref[0]) && ref[0].type === 'var' && typeof ref[0].value === 'string') {
      names.add(ref[0].value);
    }
  }
  return names;
}

/** The dotted path of each import, e.g. `rego.v1`, `data.lib.re_match`. */
function importPaths(ast: unknown): Array<{ path: string[]; alias?: string }> {
  const imports = isObject(ast) && Array.isArray(ast['imports']) ? ast['imports'] : [];
  const out: Array<{ path: string[]; alias?: string }> = [];
  for (const imp of imports as unknown[]) {
    if (!isObject(imp)) continue;
    const segs = isTerm(imp['path']) && Array.isArray(imp['path'].value) ? imp['path'].value : [];
    const path = (segs as unknown[]).map((seg) =>
      isTerm(seg) && typeof seg.value === 'string' ? seg.value : '',
    );
    out.push({ path, ...(typeof imp['alias'] === 'string' ? { alias: imp['alias'] } : {}) });
  }
  return out;
}

/**
 * The names imports bind: an alias, or else the last segment of the path. A
 * name imported this way shadowed the built-in of the same name in v0.
 */
function importBindings(ast: unknown): Set<string> {
  const names = new Set<string>();
  for (const { path, alias } of importPaths(ast)) {
    if (path[0] !== 'data' && path[0] !== 'input') continue;
    const name = alias ?? path.at(-1);
    if (name) names.add(name);
  }
  return names;
}

/** Every identifier the module uses, so a new name cannot capture one. */
function usedNames(ast: unknown): Set<string> {
  const names = new Set([...ruleNames(ast), ...importBindings(ast)]);
  for (const node of walk(ast)) {
    if (isTerm(node) && node.type === 'var' && typeof node.value === 'string') {
      names.add(node.value);
    }
  }
  return names;
}

/** The names of the module's rules that take arguments (`functions`) or do not. */
function rulesByKind(ast: unknown, functions: boolean): string[] {
  const names = new Set<string>();
  const rules = isObject(ast) && Array.isArray(ast['rules']) ? (ast['rules'] as unknown[]) : [];
  for (const rule of rules) {
    const head = isObject(rule) && isObject(rule['head']) ? rule['head'] : undefined;
    if (!head || (Array.isArray(head['args']) && head['args'].length > 0) !== functions) continue;
    const ref = Array.isArray(head['ref']) ? (head['ref'] as unknown[]) : [];
    const name =
      isTerm(ref[0]) && typeof ref[0].value === 'string'
        ? ref[0].value
        : typeof head['name'] === 'string'
          ? head['name']
          : undefined;
    if (name) names.add(name);
  }
  return [...names].sort();
}

/**
 * The rules this module defines that are documents rather than functions, so
 * each has a value under the package to compare.
 */
export const documentRules = (ast: unknown): string[] => rulesByKind(ast, false);

/** The functions this module defines, which have no value without arguments. */
export const functionRules = (ast: unknown): string[] => rulesByKind(ast, true);

/** The first of `base`, then `base_2`, `base_3`, ... that is not in use. */
function freeName(base: string, taken: Set<string>): string {
  const stem = base.endsWith('_') ? base : `${base}_`;
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${stem}${n}`;
  taken.add(name);
  return name;
}

/** The package path as plain segments after `data`, or undefined. */
function packagePath(ast: unknown): string[] | undefined {
  const pkg = isObject(ast) && isObject(ast['package']) ? ast['package'] : undefined;
  const path = pkg && Array.isArray(pkg['path']) ? (pkg['path'] as unknown[]) : undefined;
  if (!path) return undefined;
  const out: string[] = [];
  for (const seg of path.slice(1)) {
    if (!isTerm(seg) || seg.type !== 'string' || typeof seg.value !== 'string') return undefined;
    out.push(seg.value);
  }
  return out;
}

/**
 * Whether the module reads the data document outside its own package, through
 * a reference or an import such as `data.roles[input.user]`. Evaluated with no
 * data loaded, every such reference is undefined on both sides of a
 * comparison, which then agrees about nothing.
 */
export function readsExternalData(ast: unknown): boolean {
  const own = packagePath(ast);
  let found = false;
  const visit = (node: unknown): void => {
    if (found || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const term = node as { type?: unknown; value?: unknown };
    if (term.type === 'ref' && Array.isArray(term.value)) {
      const [head, ...rest] = term.value as Array<{ type?: unknown; value?: unknown }>;
      if (head?.type === 'var' && head.value === 'data') {
        const inside =
          own !== undefined &&
          own.every((seg, i) => rest[i]?.type === 'string' && rest[i]?.value === seg);
        if (!inside) {
          found = true;
          return;
        }
      }
    }
    for (const value of Object.values(node)) visit(value);
  };
  visit(ast);
  return found;
}

/** The query that reads this module's package document, e.g. `data["k8s"]["admission"]`. */
export function packageQuery(ast: unknown): string | undefined {
  const path = packagePath(ast);
  if (path === undefined) return undefined;
  return 'data' + path.map((seg) => `[${JSON.stringify(seg)}]`).join('');
}

/**
 * `expr` with each `data.<package>.<rule>` that names a renamed rule, in dot
 * form, given the rule's new name, so an expression written against the
 * original reaches the same rule in the migrated module.
 */
export function renameRuleRefs(
  expr: string,
  ast: unknown,
  renamed: Readonly<Record<string, string>>,
): string {
  const path = packagePath(ast);
  if (path === undefined) return expr;
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let out = expr;
  for (const [from, to] of Object.entries(renamed)) {
    const ref = ['data', ...path, from].map(escape).join('\\s*\\.\\s*');
    out = out.replace(
      new RegExp(`(?<![\\w.])(${ref})(?!\\w)`, 'g'),
      (m) => m.slice(0, m.length - from.length) + to,
    );
  }
  return out;
}

/** The value a string term's text spells: a bare word, a JSON string or a raw string. */
function stringValue(text: string): string | undefined {
  if (text.startsWith('`') && text.endsWith('`')) return text.slice(1, -1);
  if (text.startsWith('"')) {
    try {
      const value: unknown = JSON.parse(text);
      return typeof value === 'string' ? value : undefined;
    } catch {
      return undefined;
    }
  }
  return text;
}

/** A ref's text in dotted form, so `net["cidr_overlap"]` reads as `net.cidr_overlap`. */
const dotted = (text: string): string =>
  text
    .replace(/\[\s*"([^"]*)"\s*\]/g, '.$1')
    .replace(/\[\s*`([^`]*)`\s*\]/g, '.$1')
    .replace(/\s+/g, '');

/**
 * Apply edits at OPA's row/column locations.
 *
 * OPA counts a column in characters (Unicode code points) from 1, not in
 * bytes or UTF-16 units, so each edit is placed by walking the code points of
 * its line. An edit whose target text is not exactly what OPA reported is
 * refused rather than guessed at.
 */
function applyEdits(source: string, edits: Edit[]): string | undefined {
  const lines = source.split('\n');
  const byLine = new Map<number, Edit[]>();
  for (const e of edits) {
    const list = byLine.get(e.row) ?? [];
    list.push(e);
    byLine.set(e.row, list);
  }
  for (const [row, list] of byLine) {
    const line = lines[row - 1];
    if (line === undefined) return undefined;
    const chars = Array.from(line);
    // Right to left, so earlier columns stay valid.
    list.sort((a, b) => b.col - a.col);
    let lastStart = Number.POSITIVE_INFINITY;
    for (const e of list) {
      const start = e.col - 1;
      const expected = Array.from(e.expected);
      const end = start + expected.length;
      if (start < 0 || end > chars.length || end > lastStart) return undefined;
      if (chars.slice(start, end).join('') !== e.expected) return undefined;
      chars.splice(start, expected.length, ...Array.from(e.replacement));
      lastStart = start;
    }
    lines[row - 1] = chars.join('');
  }
  return lines.join('\n');
}

/**
 * Work out the rewrites `source` needs before `opa fmt --v0-v1` will take it,
 * from the AST `opa parse --v0-compatible --json-include locations` printed.
 * Returns undefined when a location cannot be matched to the text, in which
 * case the source should be formatted as it is.
 */
export function planV0Migration(source: string, ast: unknown): MigrationPlan | undefined {
  const rules = ruleNames(ast);
  // A rule or an imported name shadowed the built-in of the same name in v0.
  const shadowing = new Set([...rules, ...importBindings(ast)]);
  const importsRegoV1 = importPaths(ast).some((i) => i.path.join('.') === 'rego.v1');
  const taken = usedNames(ast);
  const operators = operatorRefs(ast);
  // Vars at the head of a call to the built-in `contains`, which keep their name.
  const builtinHeads = new Set<Term>();
  const pkgPath = packagePath(ast);
  const edits: Edit[] = [];
  const notes: string[] = [];
  const renamedRules = new Map<string, string>();
  const renamedVars = new Map<string, string>();

  for (const name of [...rules].filter((n) => RESERVED.has(n)).sort()) {
    renamedRules.set(name, freeName(`${name}_`, taken));
  }

  // An import of `data` or `input` binds its alias, or else the last segment
  // of its path. v1 refuses two such names: a keyword (`import input.in`,
  // `import input.user as in`) and the name of a removed built-in (`import
  // data.lib.re_match`, which in v0 shadowed the built-in). An import without
  // an alias gains one, an alias is renamed, and every use in the module
  // follows. `future.keywords` and `rego.v1` imports bind nothing and cannot
  // take an alias, so they are left as they are.
  const renamedImports = new Map<string, string>();
  const renamedAliases = new Set<string>();
  const importsToAlias: Array<{ path: Term; name: string; aliased: boolean }> = [];
  const imports = isObject(ast) && Array.isArray(ast['imports']) ? ast['imports'] : [];
  for (const imp of imports as unknown[]) {
    if (!isObject(imp)) continue;
    const path = imp['path'];
    if (!isTerm(path) || !Array.isArray(path.value)) continue;
    const segs = path.value as unknown[];
    const root = segs[0];
    if (!isTerm(root) || (root.value !== 'data' && root.value !== 'input')) continue;
    const alias = typeof imp['alias'] === 'string' ? imp['alias'] : undefined;
    const last = segs.at(-1);
    const name =
      alias ??
      (segs.length >= 2 && isTerm(last) && typeof last.value === 'string' ? last.value : undefined);
    if (name === undefined || (!RESERVED.has(name) && removedBuiltin(name) === undefined)) continue;
    renamedImports.set(name, renamedImports.get(name) ?? freeName(`${name}_`, taken));
    if (alias !== undefined) renamedAliases.add(alias);
    importsToAlias.push({ path, name, aliased: alias !== undefined });
  }
  /** The new name of a rule or an import this module renamed. */
  const renamedBinding = (name: string): string | undefined =>
    renamedRules.get(name) ?? renamedImports.get(name);

  // OPA repeats some terms at one location (the key of a partial set is both
  // `head.key` and part of `head.ref`; an `else` repeats its function's
  // head), so an edit already made there is not made twice. It also gives a
  // copy it made up a location that holds other text: the second body of a
  // chained `f(x) { ... } { ... }` carries the head's arguments at the text of
  // that whole body. The occurrence the copy was made from is edited where it
  // stands, so a copy whose text is not the name is left alone.
  const seen = new Set<string>();
  const addEdit = (
    term: Term,
    replacement: string,
    from: string,
    to: string,
    textIsThis: (text: string) => boolean,
  ): boolean => {
    const { row, col } = term.location ?? {};
    const expected = decode(term.location?.text);
    if (typeof row !== 'number' || typeof col !== 'number' || expected === undefined) return false;
    if (!textIsThis(expected)) return true;
    const key = `${row}:${col}:${expected}`;
    if (seen.has(key)) return true;
    seen.add(key);
    edits.push({ row, col, expected, replacement, from, to });
    return true;
  };

  const sourceLines = source.split('\n');
  for (const { path, name, aliased } of importsToAlias) {
    const to = renamedImports.get(name)!;
    const text = decode(path.location?.text) ?? '';
    if (!aliased) {
      const endsInName = (t: string) => dotted(t).endsWith(`.${name}`);
      if (!addEdit(path, `${text} as ${to}`, name, to, endsInName)) return undefined;
      continue;
    }
    // OPA locates the path of an import, not its alias, which follows it.
    const { row, col } = path.location ?? {};
    if (typeof row !== 'number' || typeof col !== 'number') return undefined;
    const chars = Array.from(sourceLines[row - 1] ?? '');
    const pathEnd = col - 1 + Array.from(text).length;
    const gap = /^(\s+as\s+)(\S+)/.exec(chars.slice(pathEnd).join(''));
    if (!gap || gap[2] !== name) return undefined;
    const alias: Term = {
      type: 'var',
      value: name,
      location: {
        row,
        col: pathEnd + 1 + Array.from(gap[1]!).length,
        text: Buffer.from(name).toString('base64'),
      },
    };
    if (!addEdit(alias, to, name, to, (t) => t === name)) return undefined;
  }

  // Removed built-ins kept apart from their v1 counterpart (see Replacement),
  // and why: the module mocks one while calling both, or binds the first
  // segment of the counterpart's name itself.
  const called = calledNames(ast);
  const mocked = mockedNames(ast);
  const bound = boundNames(ast);
  const apart = new Map<string, 'mocked' | 'bound'>();
  for (const [fn, replacement] of Object.entries(REMOVED_BUILTINS)) {
    if (!('rename' in replacement) || shadowing.has(fn.split('.')[0]!)) continue;
    const { rename } = replacement;
    if (bound.has(rename.split('.')[0]!)) {
      apart.set(fn, 'bound');
    } else if (called.has(fn) && called.has(rename) && (mocked.has(fn) || mocked.has(rename))) {
      apart.set(fn, 'mocked');
    }
  }
  /** The helper a removed built-in is replaced by. */
  const helperFor = (replacement: Replacement): Helper =>
    'rename' in replacement
      ? (replacement.apart.find((h) => !mocked.has(h.calls!)) ?? replacement.apart[0]!)
      : replacement.helper;

  const helpersUsed = new Map<string, string>();
  const renamedBuiltins = new Set<string>();
  /** The name a removed built-in becomes, adding its helper when it has one. */
  const replacementFor = (fn: string, replacement: Replacement): string => {
    if ('rename' in replacement && !apart.has(fn)) {
      renamedBuiltins.add(fn);
      return replacement.rename;
    }
    const to = helpersUsed.get(fn) ?? freeName(helperFor(replacement).name, taken);
    helpersUsed.set(fn, to);
    return to;
  };

  // Refs that reach this package: `data.<package>`, and the name an import of
  // the package, or of one above it, binds. After `import data.policy.ingress`,
  // `ingress.contains` refers to the rule `contains` here.
  const packageRefs: Array<{ head: string; rest: string[] }> = [];
  const locals = localRefs(ast);
  if (pkgPath) {
    packageRefs.push({ head: 'data', rest: pkgPath });
    for (const { path, alias } of importPaths(ast)) {
      const within = path.slice(1);
      if (path[0] !== 'data' || within.length === 0 || within.length > pkgPath.length) continue;
      if (within.some((seg, i) => seg !== pkgPath[i])) continue;
      packageRefs.push({ head: alias ?? path.at(-1)!, rest: pkgPath.slice(within.length) });
    }
  }

  for (const node of walk(ast)) {
    if (!isTerm(node)) continue;

    // A reserved name: a rule of this module wherever it is referred to, or a
    // local variable. At the head of an operator ref and not a rule of this
    // module, it is the built-in `contains` and keeps its name.
    if (node.type === 'ref' && Array.isArray(node.value)) {
      const head = (node.value as unknown[])[0];
      if (
        isTerm(head) &&
        head.type === 'var' &&
        typeof head.value === 'string' &&
        renamedBinding(head.value) === undefined &&
        operators.has(node)
      ) {
        builtinHeads.add(head);
      }
      // `data.<this package>.<renamed rule>` or `<import>.<renamed rule>`, in
      // dot or bracket form.
      const segs = node.value as unknown[];
      const first = segs[0];
      for (const { head: prefix, rest } of packageRefs) {
        if (!isTerm(first) || first.type !== 'var' || first.value !== prefix) continue;
        // A local that reuses the import's name is not the package.
        if (prefix !== 'data' && locals.has(node)) continue;
        if (segs.length <= rest.length + 1) continue;
        const matches = rest.every((p, i) => {
          const seg = segs[i + 1];
          return isTerm(seg) && seg.type === 'string' && seg.value === p;
        });
        const target = segs[rest.length + 1];
        if (
          matches &&
          isTerm(target) &&
          target.type === 'string' &&
          typeof target.value === 'string' &&
          renamedRules.has(target.value)
        ) {
          const name = target.value;
          const to = renamedRules.get(name)!;
          const text = decode(target.location?.text) ?? '';
          const replacement = text.startsWith('"')
            ? JSON.stringify(to)
            : text.startsWith('`')
              ? `\`${to}\``
              : to;
          // Compared by value, so an escaped key such as "con\u0074ains" is
          // recognised as the rule it names.
          const isName = (t: string) => stringValue(t) === name;
          if (!addEdit(target, replacement, name, to, isName)) return undefined;
          break;
        }
      }

      // A call to (or `with` on) a built-in v1 removed, unless a rule of this
      // module or an import binds that name, which shadowed the built-in in v0.
      const fn = refName(node);
      const replacement = fn !== undefined ? removedBuiltin(fn) : undefined;
      if (fn !== undefined && replacement !== undefined && !shadowing.has(fn.split('.')[0]!)) {
        const to = replacementFor(fn, replacement);
        if (!addEdit(node, to, fn, to, (t) => dotted(t) === fn)) return undefined;
      }
      continue;
    }

    if (node.type === 'var' && typeof node.value === 'string') {
      const name = node.value;
      if (builtinHeads.has(node)) continue;
      const isName = (t: string) => t === name;

      // `with re_match as mock`: OPA gives a one-word `with` target as a var.
      if (operators.has(node)) {
        const builtin = removedBuiltin(name);
        const to =
          renamedBinding(name) ??
          (builtin !== undefined && !shadowing.has(name)
            ? replacementFor(name, builtin)
            : undefined);
        if (to !== undefined && !addEdit(node, to, name, to, isName)) return undefined;
        continue;
      }

      let to = renamedBinding(name);
      if (to === undefined && RESERVED.has(name)) {
        to = renamedVars.get(name) ?? freeName(`${name}_`, taken);
        renamedVars.set(name, to);
      }
      if (to !== undefined && !addEdit(node, to, name, to, isName)) return undefined;
    }
  }

  let rewritten = applyEdits(source, edits);
  if (rewritten === undefined) return undefined;

  for (const [from, to] of renamedRules) {
    notes.push(
      `Renamed the rule \`${from}\` to \`${to}\`: \`${from}\` is a keyword in Rego v1 and cannot name a rule. Update any other module that refers to it` +
        (from === 'contains'
          ? '; in another module of this package, a call to `contains` left unchanged would reach the built-in string function instead.'
          : '.'),
    );
  }
  for (const [from, to] of renamedImports) {
    const why = RESERVED.has(from)
      ? `\`${from}\` is a keyword in Rego v1`
      : `in Rego v1 \`${from}\` names a removed built-in`;
    notes.push(
      renamedAliases.has(from)
        ? `Renamed the import alias \`${from}\` to \`${to}\`: ${why}.`
        : RESERVED.has(from)
          ? `Imported \`${from}\` as \`${to}\`: an import path cannot end in \`${from}\`, a keyword in Rego v1, without an alias.`
          : `Imported \`${from}\` as \`${to}\`: ${why}, so the import needs another name.`,
    );
  }
  for (const [from, to] of renamedVars) {
    notes.push(
      `Renamed the local variable \`${from}\` to \`${to}\`: \`${from}\` is a keyword in Rego v1.`,
    );
  }
  for (const fn of Object.keys(REMOVED_BUILTINS)) {
    const replacement = REMOVED_BUILTINS[fn]!;
    const name = helpersUsed.get(fn);
    if ('rename' in replacement && !shadowing.has(fn.split('.')[0]!)) {
      const { rename } = replacement;
      if (renamedBuiltins.has(fn)) {
        notes.push(
          `Replaced \`${fn}\` with \`${rename}\`, which Rego v1 keeps in its place and which behaves the same.`,
        );
      }
      // A mock reaches every call made under the name it mocks, in whatever
      // module, and Rego v1 has one name where v0 had two.
      if (name !== undefined && mocked.has(fn)) {
        notes.push(
          `\`with ${fn}\` now mocks \`${name}()\`, so it no longer reaches calls to \`${fn}\` in other modules.`,
        );
      }
      if (mocked.has(rename) || (mocked.has(fn) && name === undefined)) {
        notes.push(
          `Rego v1 has \`${rename}\` in place of \`${fn}\`, so once the other modules are migrated, a \`with\` here that mocks either one also reaches their calls to the other.`,
        );
      }
    }
    if (name === undefined) continue;
    const helper = helperFor(replacement);
    if (!rewritten.endsWith('\n')) rewritten += '\n';
    rewritten +=
      '\n' + helper.body.replaceAll('NAME', name).replaceAll('@IF@', importsRegoV1 ? ' if' : '');
    if (!('rename' in replacement)) {
      notes.push(
        `Replaced \`${fn}()\`, which Rego v1 removed, with \`${name}()\`, added at the end of the module, which returns what \`${fn}()\` did for every argument.`,
      );
      continue;
    }
    const { rename } = replacement;
    const segment = rename.split('.')[0]!;
    notes.push(
      `Replaced \`${fn}()\`, which Rego v1 removed, with \`${name}()\`, added at the end of the module, which returns what \`${fn}()\` did without calling \`${rename}\`: ` +
        (apart.get(fn) === 'bound'
          ? `this module binds the name \`${segment}\` itself, which would hide the built-in.`
          : 'this module mocks one of the two, and renaming would have let the mock reach calls made under the other name.'),
    );
    if (helper.calls !== undefined && mocked.has(helper.calls)) {
      notes.push(
        `A \`with\` here mocks \`${helper.calls}\`, which \`${name}()\` calls, so it now also reaches what were calls to \`${fn}\`.`,
      );
    }
  }

  const rewrites = edits
    .map((e) => ({ line: e.row, from: e.from, to: e.to }))
    .sort((a, b) => a.line - b.line);
  return { source: rewritten, rewrites, notes, renamedRules: Object.fromEntries(renamedRules) };
}
