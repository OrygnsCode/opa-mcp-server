/**
 * Render OPA's JSON explain trace as readable lines.
 *
 * `opa eval --explain full --format json` carries every event's AST node, so
 * the trace of one admission request against a 60-line policy runs past
 * 300 KB of nested term objects: too large to return and unreadable as text.
 * The lines built here follow `opa eval --format pretty --var-values`: the
 * location, a bar per nesting level, the operation, the expression in Rego
 * syntax, and the values of the variables the expression names.
 *
 * Two departures from OPA's printer. Comparisons and membership print infix
 * (`x > 1`, `x in xs`) where OPA prints the call (`gt(x, 1)`). And `Redo`
 * events are left out unless asked for: OPA emits one for every backtrack,
 * often a third of the trace, and they say nothing about why a rule matched.
 */

interface Term {
  type?: string;
  value?: unknown;
}

interface TraceExpr {
  negated?: boolean;
  terms?: Term | Term[] | { symbols?: Term[] };
  with?: Array<{ target?: Term; value?: Term }>;
}

interface TraceRuleHead {
  name?: string;
  ref?: Term[];
  args?: Term[];
}

export interface TraceEvent {
  Op?: string;
  Node?: unknown;
  Location?: { file?: string; row?: number; col?: number };
  QueryID?: number;
  ParentID?: number;
  Message?: string;
  Locals?: Array<{ name?: string; type?: string; value?: unknown }>;
  /** Generated variable name -> the name the author wrote. */
  LocalMetadata?: Record<string, { name?: string }>;
  Ref?: Term[] | null;
}

export interface RenderedTrace {
  lines: string[];
  /** Events in the trace OPA returned, Redo included. */
  events: number;
  /** Redo events left out. */
  redoOmitted: number;
}

/** Longest expression text kept on one line. */
const MAX_TEXT = 240;
/** Longest variable value shown. */
const MAX_VALUE = 60;

const INFIX: Record<string, string> = {
  eq: '=',
  equal: '==',
  neq: '!=',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
};

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isTerm(x: unknown): x is Term {
  return typeof x === 'object' && x !== null && !Array.isArray(x) && 'type' in x;
}

/**
 * Renderers for one event. The compiler renames the variables a rule declares
 * (`role` becomes `__local2__`); `names` maps them back, as OPA's own printer
 * does with the event's `LocalMetadata`.
 */
function renderer(names: ReadonlyMap<string, string>) {
  const ref = (parts: Term[]): string => {
    if (parts.length === 0) return '';
    let out = term(parts[0]!);
    for (const part of parts.slice(1)) {
      if (part.type === 'string' && typeof part.value === 'string' && IDENT.test(part.value)) {
        out += `.${part.value}`;
      } else {
        out += `[${term(part)}]`;
      }
    }
    return out;
  };

  const call = (terms: Term[]): string => {
    const [op, ...args] = terms;
    const name = op?.type === 'ref' ? ref(op.value as Term[]) : term(op ?? {});
    const infix = INFIX[name];
    if (infix !== undefined && args.length === 2)
      return `${term(args[0]!)} ${infix} ${term(args[1]!)}`;
    if (name === 'internal.member_2' && args.length === 2)
      return `${term(args[0]!)} in ${term(args[1]!)}`;
    if (name === 'internal.member_3' && args.length === 3) {
      return `${term(args[0]!)}, ${term(args[1]!)} in ${term(args[2]!)}`;
    }
    return `${name}(${args.map(term).join(', ')})`;
  };

  const body = (exprs: unknown): string =>
    Array.isArray(exprs) ? exprs.map((e) => expr(e as TraceExpr)).join('; ') : '';

  const term = (t: Term): string => {
    const v = t.value;
    switch (t.type) {
      case 'null':
        return 'null';
      case 'boolean':
      case 'number':
        return String(v);
      case 'string':
        return JSON.stringify(v);
      case 'var': {
        const name = typeof v === 'string' ? (names.get(v) ?? v) : String(v);
        // Variables the compiler generates for a wildcard print as `_`, as OPA prints them.
        return name.startsWith('$') ? '_' : name;
      }
      case 'ref':
        return ref(Array.isArray(v) ? (v as Term[]) : []);
      case 'call':
        return call(Array.isArray(v) ? (v as Term[]) : []);
      case 'array':
        return `[${(Array.isArray(v) ? (v as Term[]) : []).map(term).join(', ')}]`;
      case 'set': {
        const items = Array.isArray(v) ? (v as Term[]) : [];
        return items.length === 0 ? 'set()' : `{${items.map(term).join(', ')}}`;
      }
      case 'object': {
        const pairs = Array.isArray(v) ? (v as Array<[Term, Term]>) : [];
        return `{${pairs.map(([k, val]) => `${term(k)}: ${term(val)}`).join(', ')}}`;
      }
      case 'arraycomprehension': {
        const c = (v ?? {}) as { term?: Term; body?: unknown };
        return `[${term(c.term ?? {})} | ${body(c.body)}]`;
      }
      case 'setcomprehension': {
        const c = (v ?? {}) as { term?: Term; body?: unknown };
        return `{${term(c.term ?? {})} | ${body(c.body)}}`;
      }
      case 'objectcomprehension': {
        const c = (v ?? {}) as { key?: Term; value?: Term; body?: unknown };
        return `{${term(c.key ?? {})}: ${term(c.value ?? {})} | ${body(c.body)}}`;
      }
      case 'every': {
        const e = (v ?? {}) as { key?: Term; value?: Term; domain?: Term; body?: unknown };
        const vars = e.key ? `${term(e.key)}, ${term(e.value ?? {})}` : term(e.value ?? {});
        return `every ${vars} in ${term(e.domain ?? {})} { ${body(e.body)} }`;
      }
      default:
        return t.type ? `<${t.type}>` : '<?>';
    }
  };

  const expr = (e: TraceExpr): string => {
    const t = e.terms;
    let text: string;
    if (Array.isArray(t)) text = call(t);
    else if (isTerm(t)) text = term(t);
    else if (t && typeof t === 'object' && Array.isArray(t.symbols)) {
      text = `some ${t.symbols.map(term).join(', ')}`;
    } else text = '<?>';
    if (e.negated) text = `not ${text}`;
    for (const w of e.with ?? []) text += ` with ${term(w.target ?? {})} as ${term(w.value ?? {})}`;
    return text;
  };

  /**
   * A rule prints as its full path, which OPA's trace does not repeat on the
   * rule node; the Index event that looked the rule up names it.
   */
  const rule = (head: TraceRuleHead, indexRef: Term[] | undefined): string => {
    const name = head.name ?? lastSegment(head.ref);
    const path =
      indexRef && name !== undefined && lastSegment(indexRef) === name
        ? ref(indexRef)
        : ref(head.ref ?? []) || (name ?? '<rule>');
    return head.args?.length ? `${path}(${head.args.map(term).join(', ')})` : path;
  };

  const node = (n: unknown, indexRef: Term[] | undefined): string => {
    if (Array.isArray(n)) return body(n);
    if (n && typeof n === 'object') {
      if ('head' in n) return rule((n as { head: TraceRuleHead }).head, indexRef);
      if ('terms' in n) return expr(n as TraceExpr);
      if (isTerm(n)) return term(n);
    }
    return '';
  };

  return { term, ref, node };
}

function lastSegment(ref: Term[] | null | undefined): string | undefined {
  const last = ref?.[ref.length - 1];
  return last && typeof last.value === 'string' ? last.value : undefined;
}

const plain = renderer(new Map());

/** A term (or a local variable's value) in Rego syntax. */
export const renderTerm = (term: Term): string => plain.term(term);

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

/** The values of the local variables a line's text names. */
function renderLocals(
  text: string,
  locals: TraceEvent['Locals'],
  names: ReadonlyMap<string, string>,
): string {
  const shown: string[] = [];
  for (const local of locals ?? []) {
    const name = local.name !== undefined ? (names.get(local.name) ?? local.name) : undefined;
    if (!name || name === '_' || name.startsWith('$')) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!new RegExp(`(^|[^A-Za-z0-9_.])${escaped}([^A-Za-z0-9_]|$)`).test(text)) continue;
    shown.push(`${name}: ${cut(renderTerm({ type: local.type, value: local.value }), MAX_VALUE)}`);
  }
  return shown.length > 0 ? `  {${shown.join(', ')}}` : '';
}

/**
 * Short names for the files in a trace: the base name, unless two files share
 * one, in which case those keep their full path.
 */
function locationNames(events: TraceEvent[]): Map<string, string> {
  const byBase = new Map<string, Set<string>>();
  for (const e of events) {
    const file = e.Location?.file;
    if (!file) continue;
    const base = file.split(/[\\/]/).pop() ?? file;
    if (!byBase.has(base)) byBase.set(base, new Set());
    byBase.get(base)!.add(file);
  }
  const names = new Map<string, string>();
  for (const [base, files] of byBase) {
    for (const file of files) names.set(file, files.size === 1 ? base : file);
  }
  return names;
}

export function renderTrace(
  events: TraceEvent[],
  opts: { keepRedo?: boolean } = {},
): RenderedTrace {
  const files = locationNames(events);
  // Nesting as OPA's pretty printer computes it: a query sits one level below
  // the query that started it.
  const depths = new Map<number, number>();
  // The ref each query last looked up; a rule entered from that query is named by it.
  const indexRefs = new Map<number, Term[]>();
  const rows: Array<{ location: string; rest: string }> = [];
  let redoOmitted = 0;

  for (const e of events) {
    const qid = e.QueryID ?? 0;
    let depth = depths.get(qid) ?? 0;
    if (depth === 0) {
      depth = (depths.get(e.ParentID ?? 0) ?? 0) + 1;
      depths.set(qid, depth);
    }
    const op = e.Op ?? '?';
    if (op === 'Index' && Array.isArray(e.Ref)) indexRefs.set(qid, e.Ref);
    if (op === 'Redo' && !opts.keepRedo) {
      redoOmitted += 1;
      continue;
    }

    const file = e.Location?.file ?? '';
    const location = file
      ? `${files.get(file) ?? file}:${e.Location?.row ?? 0}`
      : `query:${e.Location?.row ?? 1}`;
    const isExpr = typeof e.Node === 'object' && e.Node !== null && 'terms' in e.Node;
    const spaces = op === 'Enter' || (op === 'Redo' && !isExpr) ? depth : depth + 1;
    const bars = '| '.repeat(Math.max(0, spaces - 1));

    const names = new Map<string, string>();
    for (const [generated, meta] of Object.entries(e.LocalMetadata ?? {})) {
      if (meta?.name) names.set(generated, meta.name);
    }
    const r = renderer(names);

    let text: string;
    if (op === 'Note') text = JSON.stringify(e.Message ?? '');
    else if (op === 'Index' && Array.isArray(e.Ref)) {
      // OPA prints the ref being looked up and how many rules matched it.
      text = `${r.ref(e.Ref)}${e.Message ? ` ${e.Message}` : ''}`;
    } else {
      text = cut(r.node(e.Node, indexRefs.get(e.ParentID ?? 0)), MAX_TEXT);
      // Such as `early` on the Exit of a rule that stopped at its first value.
      if (e.Message) text += ` ${e.Message}`;
    }
    rows.push({ location, rest: `${bars}${op} ${text}${renderLocals(text, e.Locals, names)}` });
  }

  const width = rows.reduce((w, r) => Math.max(w, r.location.length), 0);
  return {
    lines: rows.map((r) => `${r.location.padEnd(width)} ${r.rest}`),
    events: events.length,
    redoOmitted,
  };
}
