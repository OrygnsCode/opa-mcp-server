/**
 * Which parts of `input` a set of Rego modules read, followed through the
 * bindings a policy actually uses.
 *
 * Collecting only references that start with `input` missed most of a real
 * policy: `some c in input.request.object.spec.containers` followed by
 * `c.image`, a rule `pod_spec := input.request.object.spec.template.spec`
 * read as `pod_spec.containers`, `object.get(c, ["securityContext",
 * "privileged"], false)`, and helpers such as `trusted(c)`. Here a variable,
 * a rule and a function parameter carry the input paths they stand for, so a
 * reference through any of them resolves to the input path underneath.
 *
 * A path is a list of segments: a string key, `null` for an element of an
 * array (`[_]`, `some x in`), or `*` for any key of an object or element of an
 * array (`some k, v in`, a key held in a variable). Rules and function
 * parameters are resolved by repeating the pass until nothing new turns up,
 * so their order in the module does not matter.
 */

type Segment = string | null;
/** A segment that may name any key of an object or any element of an array. */
export const ANY = '*';
export type InputPath = Segment[];

export type ScalarType = 'string' | 'number' | 'boolean' | 'null' | 'array' | 'object';

export interface InputShape {
  paths: InputPath[];
  /** Types the policy shows a path to have, by `JSON.stringify(path)`. */
  types: Map<string, Set<ScalarType>>;
}

interface Term {
  type?: string;
  value?: unknown;
}

interface Head {
  name?: string;
  ref?: Term[];
  args?: Term[];
  key?: Term;
  value?: Term;
}

interface Rule {
  head?: Head;
  body?: unknown[];
  default?: boolean;
  else?: Rule;
}

interface Module {
  package?: { path?: Term[] };
  rules?: Rule[];
}

/** Paths, deduplicated by their JSON form. */
class PathSet {
  readonly byKey = new Map<string, InputPath>();
  add(path: InputPath): boolean {
    const key = JSON.stringify(path);
    if (this.byKey.has(key)) return false;
    this.byKey.set(key, path);
    return true;
  }
  addAll(paths: Iterable<InputPath>): boolean {
    let changed = false;
    for (const p of paths) changed = this.add(p) || changed;
    return changed;
  }
  get list(): InputPath[] {
    return [...this.byKey.values()];
  }
}

const isTerm = (x: unknown): x is Term =>
  typeof x === 'object' && x !== null && !Array.isArray(x) && 'type' in x;

const TYPE_CHECKS: Record<string, ScalarType> = {
  is_string: 'string',
  is_number: 'number',
  is_boolean: 'boolean',
  is_null: 'null',
  is_array: 'array',
  is_object: 'object',
};

/** Built-ins whose first argument is a string. */
const STRING_FIRST = new Set([
  'startswith',
  'endswith',
  'contains',
  'lower',
  'upper',
  'trim',
  'trim_space',
  'trim_prefix',
  'trim_suffix',
  'trim_left',
  'trim_right',
  'split',
  'indexof',
  'replace',
  'substring',
  'strings.replace_n',
  'urlquery.decode',
]);

const COMPARISONS = new Set(['equal', 'neq', 'lt', 'gt', 'lte', 'gte', 'eq']);

function literalType(t: Term): ScalarType | undefined {
  switch (t.type) {
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'null':
      return 'null';
    default:
      return undefined;
  }
}

/** A ref made of a var and plain string keys, dotted: `object.get`, `data.p.allow`. */
function refName(t: Term | undefined): string | undefined {
  if (!t || t.type !== 'ref' || !Array.isArray(t.value)) return undefined;
  const parts: string[] = [];
  for (const [i, seg] of (t.value as Term[]).entries()) {
    if (i === 0 ? seg.type !== 'var' : seg.type !== 'string') return undefined;
    parts.push(String(seg.value));
  }
  return parts.join('.');
}

/** A variable's bindings in one rule body. */
interface Env {
  paths: Map<string, InputPath[]>;
  /** Variables known to hold one of a few string values: `some f in ["a", "b"]`. */
  literals: Map<string, string[]>;
}

const childEnv = (env: Env): Env => ({
  paths: new Map(env.paths),
  literals: new Map(env.literals),
});

export function inputShape(modules: unknown[]): InputShape {
  const seen = new PathSet();
  const types = new Map<string, Set<ScalarType>>();
  // Rules are shared by every module of a package, so the tables are keyed by
  // the package path and the rule name.
  const values = new Map<string, PathSet>(); // a complete rule's value, or a function's
  const elems = new Map<string, PathSet>(); // a multi-value rule's elements
  const params = new Map<string, PathSet[]>(); // a function's parameters
  const functions = new Set<string>();

  const pkgOf = (m: Module): string =>
    (m.package?.path ?? [])
      .slice(1)
      .map((t) => String(t.value))
      .join('.');

  const table = <T>(map: Map<string, T>, key: string, make: () => T): T => {
    let v = map.get(key);
    if (v === undefined) {
      v = make();
      map.set(key, v);
    }
    return v;
  };

  const addType = (paths: InputPath[], type: ScalarType): void => {
    for (const p of paths) {
      if (p.length === 0) continue;
      table(types, JSON.stringify(p), () => new Set<ScalarType>()).add(type);
    }
  };

  const record = (paths: InputPath[]): InputPath[] => {
    for (const p of paths) if (p.length > 0) seen.add(p);
    return paths;
  };

  const extend = (bases: InputPath[], segs: Segment[][]): InputPath[] => {
    let out = bases;
    for (const alternatives of segs) {
      out = out.flatMap((b) => alternatives.map((s) => [...b, s]));
    }
    return out;
  };

  for (let pass = 0; pass < 8; pass++) {
    let changed = false;

    for (const raw of modules) {
      const mod = raw as Module;
      const pkg = pkgOf(mod);
      const ruleKey = (name: string) => `${pkg}\u0000${name}`;
      const ruleNames = new Set(
        (mod.rules ?? []).map((r) => r.head?.name ?? refName(r.head?.ref?.[0] as Term) ?? ''),
      );
      for (const r of mod.rules ?? []) {
        if (r.head?.args?.length && r.head.name) functions.add(ruleKey(r.head.name));
      }

      /** The rule a name or a `data.<pkg>.<name>` ref reaches, and the segments left after it. */
      const ruleRef = (terms: Term[]): { key: string; rest: Term[] } | undefined => {
        const head = terms[0];
        if (head?.type !== 'var') return undefined;
        if (head.value !== 'data' && ruleNames.has(String(head.value))) {
          return { key: ruleKey(String(head.value)), rest: terms.slice(1) };
        }
        if (head.value === 'data') {
          const segs = pkg.split('.');
          const named = terms.slice(1, 1 + segs.length);
          if (named.length === segs.length && named.every((t, i) => t.value === segs[i])) {
            const rule = terms[1 + segs.length];
            if (rule?.type === 'string' && ruleNames.has(String(rule.value))) {
              return { key: ruleKey(String(rule.value)), rest: terms.slice(2 + segs.length) };
            }
          }
        }
        return undefined;
      };

      /** The alternatives one ref segment can be. */
      const segment = (t: Term, env: Env): Segment[] => {
        if (t.type === 'string') return [String(t.value)];
        if (t.type === 'var') {
          const lits = env.literals.get(String(t.value));
          if (lits) return lits;
          return [String(t.value).startsWith('$') || t.value === '_' ? null : ANY];
        }
        // A computed key, such as another ref: its own paths are recorded.
        pathsOf(t, env);
        return [ANY];
      };

      /** The input paths a term stands for, recording each path it reads. */
      const pathsOf = (t: unknown, env: Env): InputPath[] => {
        if (!isTerm(t)) return [];
        switch (t.type) {
          case 'var': {
            const name = String(t.value);
            const bound = env.paths.get(name);
            if (bound) return bound;
            if (ruleNames.has(name)) return values.get(ruleKey(name))?.list ?? [];
            return [];
          }
          case 'ref': {
            const terms = t.value as Term[];
            const head = terms[0];
            let bases: InputPath[];
            let rest: Term[];
            if (head?.type === 'var' && head.value === 'input') {
              bases = [[]];
              rest = terms.slice(1);
            } else if (head?.type === 'var' && env.paths.has(String(head.value))) {
              bases = env.paths.get(String(head.value))!;
              rest = terms.slice(1);
            } else {
              const rule = ruleRef(terms);
              if (rule) {
                // A ref into a multi-value rule picks one of its elements.
                const elements = elems.get(rule.key)?.list ?? [];
                if (elements.length > 0 && rule.rest.length > 0) {
                  bases = elements;
                  rest = rule.rest.slice(1);
                  pathsOf(rule.rest[0], env);
                } else {
                  bases = values.get(rule.key)?.list ?? [];
                  rest = rule.rest;
                }
              } else {
                for (const seg of terms.slice(1)) if (seg.type !== 'string') pathsOf(seg, env);
                return [];
              }
            }
            return record(
              extend(
                bases,
                rest.map((s) => segment(s, env)),
              ),
            );
          }
          case 'call': {
            const [op, ...args] = t.value as Term[];
            const name = refName(op);
            if (name === 'object.get' && args.length >= 2) {
              const bases = pathsOf(args[0], env);
              const key = args[1]!;
              pathsOf(args[2], env);
              let keys: Segment[][];
              if (key.type === 'array' && Array.isArray(key.value)) {
                keys = (key.value as Term[]).map((k) => segment(k, env));
              } else {
                keys = [segment(key, env)];
              }
              return record(extend(bases, keys));
            }
            hint(name, args, env);
            const fn = op?.type === 'ref' ? ruleRef(op.value as Term[]) : undefined;
            if (fn && functions.has(fn.key)) {
              const slots = table(params, fn.key, () => [] as PathSet[]);
              args.forEach((a, i) => {
                const slot = (slots[i] ??= new PathSet());
                if (slot.addAll(pathsOf(a, env))) changed = true;
              });
              return values.get(fn.key)?.list ?? [];
            }
            for (const a of args) pathsOf(a, env);
            return [];
          }
          case 'array':
          case 'set':
            for (const item of (t.value as unknown[]) ?? []) pathsOf(item, env);
            return [];
          case 'object':
            for (const pair of (t.value as unknown[][]) ?? []) {
              pathsOf(pair[0], env);
              pathsOf(pair[1], env);
            }
            return [];
          case 'templatestring': {
            // `$"container {name(c)}"`: each `{...}` part is an expression.
            const parts = (t.value as { parts?: unknown[] } | undefined)?.parts ?? [];
            for (const part of parts) {
              const terms = (part as { terms?: unknown }).terms;
              if (Array.isArray(terms)) pathsOf({ type: 'call', value: terms }, env);
              else pathsOf(terms ?? part, env);
            }
            return [];
          }
          case 'arraycomprehension':
          case 'setcomprehension':
          case 'objectcomprehension': {
            const c = (t.value ?? {}) as {
              term?: Term;
              key?: Term;
              value?: Term;
              body?: unknown[];
            };
            const inner = childEnv(env);
            body(c.body, inner);
            pathsOf(c.term, inner);
            pathsOf(c.key, inner);
            pathsOf(c.value, inner);
            return [];
          }
          default:
            return [];
        }
      };

      /** The paths of the elements of a collection term. */
      const elementsOf = (domain: Term | undefined, env: Env, seg: Segment): InputPath[] => {
        if (!domain) return [];
        if (domain.type === 'ref' || domain.type === 'var') {
          const terms = domain.type === 'ref' ? (domain.value as Term[]) : [domain];
          const rule = ruleRef(terms);
          if (rule && rule.rest.length === 0) {
            const elements = elems.get(rule.key)?.list;
            if (elements && elements.length > 0) return elements;
          }
          return record(pathsOf(domain, env).map((p) => [...p, seg]));
        }
        if (domain.type === 'arraycomprehension' || domain.type === 'setcomprehension') {
          const c = (domain.value ?? {}) as { term?: Term; body?: unknown[] };
          const inner = childEnv(env);
          body(c.body, inner);
          return pathsOf(c.term, inner);
        }
        if (domain.type === 'call') return record(pathsOf(domain, env).map((p) => [...p, seg]));
        pathsOf(domain, env);
        return [];
      };

      /** Bind a declared variable to the elements of a collection, or to literal strings. */
      const bindElement = (
        v: Term | undefined,
        domain: Term | undefined,
        env: Env,
        seg: Segment,
      ): void => {
        if (v?.type !== 'var') {
          if (v) pathsOf(v, env);
          return;
        }
        const name = String(v.value);
        if (domain?.type === 'array' || domain?.type === 'set') {
          const items = (domain.value as Term[]) ?? [];
          if (items.length > 0 && items.every((i) => i.type === 'string')) {
            env.literals.set(
              name,
              items.map((i) => String(i.value)),
            );
            return;
          }
        }
        env.paths.set(name, elementsOf(domain, env, seg));
      };

      /** Type evidence from a call: comparisons with literals, is_* checks, string built-ins. */
      const hint = (name: string | undefined, args: Term[], env: Env): void => {
        if (name === undefined) return;
        if (TYPE_CHECKS[name] && args[0]) addType(pathsOf(args[0], env), TYPE_CHECKS[name]);
        else if (STRING_FIRST.has(name) && args[0]) addType(pathsOf(args[0], env), 'string');
        else if (name === 'regex.match' && args[1]) addType(pathsOf(args[1], env), 'string');
        else if (COMPARISONS.has(name) && args.length === 2) {
          const [a, b] = args as [Term, Term];
          const la = literalType(a);
          const lb = literalType(b);
          if (lb !== undefined && la === undefined) addType(pathsOf(a, env), lb);
          if (la !== undefined && lb === undefined) addType(pathsOf(b, env), la);
          if (['lt', 'gt', 'lte', 'gte'].includes(name) && la === undefined && lb === undefined) {
            pathsOf(a, env);
            pathsOf(b, env);
          }
        }
      };

      const expr = (e: unknown, env: Env): void => {
        if (typeof e !== 'object' || e === null) return;
        const terms = (e as { terms?: unknown }).terms;
        if (Array.isArray(terms)) {
          const [op, ...args] = terms as Term[];
          const name = refName(op);
          if ((name === 'assign' || name === 'eq') && args.length === 2) {
            const [lhs, rhs] = args as [Term, Term];
            if (lhs.type === 'var' && !env.paths.has(String(lhs.value))) {
              env.paths.set(String(lhs.value), pathsOf(rhs, env));
              const lit = literalType(rhs);
              if (lit === undefined) return;
            } else if (rhs.type === 'var' && !env.paths.has(String(rhs.value))) {
              env.paths.set(String(rhs.value), pathsOf(lhs, env));
              return;
            }
          }
          pathsOf({ type: 'call', value: terms }, env);
          return;
        }
        if (isTerm(terms)) {
          pathsOf(terms, env);
          return;
        }
        if (terms && typeof terms === 'object') {
          const decl = terms as { symbols?: Term[] };
          if (Array.isArray(decl.symbols)) {
            for (const sym of decl.symbols) {
              if (sym.type !== 'call') continue;
              const [op, ...args] = sym.value as Term[];
              const name = refName(op);
              if (name === 'internal.member_2') bindElement(args[0], args[1], env, null);
              else if (name === 'internal.member_3') {
                if (args[0]?.type === 'var') env.paths.delete(String(args[0].value));
                bindElement(args[1], args[2], env, ANY);
              }
            }
            return;
          }
          const every = terms as {
            key?: Term | null;
            value?: Term;
            domain?: Term;
            body?: unknown[];
          };
          if (every.domain) {
            const inner = childEnv(env);
            bindElement(every.value, every.domain, inner, every.key ? ANY : null);
            body(every.body, inner);
          }
        }
      };

      const body = (exprs: unknown[] | undefined, env: Env): void => {
        for (const e of exprs ?? []) expr(e, env);
      };

      const rule = (r: Rule): void => {
        const head = r.head ?? {};
        const name = head.name ?? '';
        const key = ruleKey(name);
        const env: Env = { paths: new Map(), literals: new Map() };
        (head.args ?? []).forEach((a, i) => {
          if (a.type === 'var') env.paths.set(String(a.value), params.get(key)?.[i]?.list ?? []);
          else pathsOf(a, env);
        });
        body(r.body, env);
        if (head.key !== undefined) {
          if (table(elems, key, () => new PathSet()).addAll(pathsOf(head.key, env))) changed = true;
          if (head.value !== undefined) pathsOf(head.value, env);
        } else if (head.value !== undefined) {
          const value = head.value;
          if (value.type === 'arraycomprehension' || value.type === 'setcomprehension') {
            const elements = elementsOf(value, env, null);
            if (table(elems, key, () => new PathSet()).addAll(elements)) changed = true;
          } else if (table(values, key, () => new PathSet()).addAll(pathsOf(value, env))) {
            changed = true;
          }
        }
        if (r.else) rule({ ...r.else, head: { ...r.else.head, name } });
      };

      for (const r of mod.rules ?? []) rule(r);
    }
    if (!changed) break;
  }

  // Every reference that names `input` directly counts too, wherever it sits
  // in the tree (a `with`, an import, a shape not modelled above), so the
  // analysis can add to what a plain walk finds but never miss any of it.
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const t = node as Term;
    if (t.type === 'ref' && Array.isArray(t.value)) {
      const [head, ...rest] = t.value as Term[];
      if (head?.type === 'var' && head.value === 'input') {
        const path: InputPath = [];
        for (const seg of rest) {
          if (seg.type === 'string') path.push(String(seg.value));
          else if (seg.type === 'var')
            path.push(String(seg.value).startsWith('$') || seg.value === '_' ? null : ANY);
          else break;
        }
        if (path.length > 0) seen.add(path);
      }
    }
    for (const value of Object.values(node)) walk(value);
  };
  walk(modules);

  return { paths: seen.list, types };
}
