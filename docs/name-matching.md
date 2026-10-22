# Name matching — `src/search.mjs`

The reasoning behind the five helpers that turn a tool name into something comparable. The code
carries one-line comments only; everything that explains *why* is here. For the plugin around these
functions, see [how-it-works.md](how-it-works.md).

The model asks to run a tool by name, that name is sometimes not in the catalogue, and
[`suggest()`](../src/search.mjs) fills in the `Closest: …` part of the error it gets back — which
decides whether the model recovers in one step or spends another turn guessing. Two places call it,
both in [`../src/index.mjs`](../src/index.mjs): `details()` for a bad name passed to `tool_details`,
and the `call_tool` error for a name that cannot be run.

## `words(text)` — one normalisation point

Every comparison in this file happens between words, so getting the split right is the whole job:

```
mcp__github__create_issue  ->  mcp, github, create, issue
postMessage-now            ->  post, message, now
```

Four steps, each removing one family of naming conventions:

| step | removes |
|---|---|
| insert a space at a lower-case-or-digit followed by a capital | camelCase and PascalCase |
| `toLowerCase()` | case, so nothing downstream compares case-sensitively |
| split on runs of non-alphanumerics | `__`, `-`, `.`, spaces |
| drop empty pieces | the blanks a leading or doubled separator leaves behind |

`String(text ?? '')` makes it total: `undefined`, `null` or a number comes back as an array instead
of throwing. That matters because the input is a name the model typed.

Known limits, both accepted because tool names don't do this in practice:

- **Acronym runs don't split.** The seam regex only fires on lower-then-upper, so `getHTTPResponse`
  becomes `gethttpresponse`, one unmatchable word. A second pass over `([A-Z]+)([A-Z][a-z])` fixes it
  if a real catalogue ever needs it.
- **Non-ASCII is dropped, not folded.** `café` yields `caf`; `cafe` and `café` will not match.

## `serverOf(name)` — reading the MCP prefix

The convention is `mcp__<server>__<tool>`, and the awkward part is that a server name may itself
contain single underscores (`my_db`). A lazy `.+?` up to the first `__` reads `mcp__github__a_b`
correctly by luck and gets the rest wrong.

```
^mcp__ ( [^_] (?: [^_] | _(?!_) )* ) __
```

The capture walks over an underscore only when the next character is not another underscore. So it
steps through `my_db`, stops dead on the first `_` of a `__`, and the `__` at the end of the pattern
then matches that separator. Two side effects worth knowing:

- The capture must start with a non-underscore, so `mcp____tool` — an empty server — matches nothing
  rather than producing `''`.
- Ambiguity resolves leftmost: `mcp__a__b__c` gives `a`, which is what the harness intends.

It returns `undefined` for anything that isn't that shape, and the caller decides what to do with
built-in tools (`src/index.mjs` groups them under `other`). The prefix is matched case-sensitively,
which is how the harness writes it.

Pathological encodings this rejects rather than guesses: a server named `_scratch` encodes as
`mcp___scratch__tool` and is refused by the leading `[^_]`; a server named `foo_` puts three
underscores in a row and gets sliced wrong. Both are impossible in practice, and refusing them is
better than inventing a server.

## `distance(a, b, max)` — a budget test, not a measurement

Edit distance: the fewest single-character operations that turn `a` into `b`. Insert, delete,
substitute, or swap two neighbours, each costing 1.

### The table

You can't count the edits of two whole words directly, so you solve every prefix pair and build up.
Rows are prefixes of `a`, columns prefixes of `b`, and each cell is the cheapest way to reach that
pair:

```
            ""    c     u     t
     ""      0    1     2     3      row 0: "" -> "cut" costs 3 insertions
     c       1    0     1     2      column 0: "cat" -> "" costs 3 deletions
     a       2    1     1     2
     t       3    2     2     1  <-  the answer is the last cell
```

Each cell comes from three neighbours, and the code names them: `deleteFromA` (the cell above, plus
one), `insertIntoA` (the cell to the left, plus one), `substitute` (the diagonal, plus nothing if the
two letters already agree). `cat`/`cut` ends at 1 — one replacement, with `t` matching `t` for free
on the way in.

Swapping two neighbours is a fourth way in, costing 1 instead of the 2 plain Levenshtein charges.
This is *optimal string alignment*, the restricted variant: the swap looks back two rows and two
columns, and only ever rewrites two adjacent letters. Models and keyboards produce swapped letters
constantly — `create` → `cerate`, `query` → `qurey` — and scoring that as 2 puts it outside every
budget this file uses. That is the reason the variant is here rather than the plain algorithm.

### Two early exits

Full distance is wasted work when the only question anyone asks is "within budget?".

**Length gap.** One edit changes the length by at most 1, so if the lengths already differ by more
than `max`, no alignment gets under the bar. Return without building any row. This kills the bulk of
a catalogue scan, where almost every pair is unrelated.

**Row minimum.** As you go down the table, the cheapest cell in each row never gets cheaper. Every
cell is built from `above + 0 or + 1`, or from the cell to its left `+ 1`, and never from anything
smaller; the row's first cell is `i`, which is above the previous row's minimum by construction. So
once a row's minimum is past `max`, the answer can't recover and the search ends — usually within
three rows.

Two consequences of bailing early, both easy to trip over:

- **The return value past budget is `max + 1`, not the true distance.** `distance('github', 'slack',
  2)` returns 3; the honest number is 6. So the output domain is exactly `{0 … max} ∪ {max + 1}`, and
  the only correct way to read it is `distance(a, b, budget) <= budget`. The clamp on the way out is
  what guarantees this: the row-minimum exit is opportunistic, and without it a pair can reach the
  last row and return its true distance — 7 where the docs promise 5. Fuzzing found that; it predates
  the swap support, and no caller was harmed by it because they all compare against `max`.
- **`max` is not a courtesy default.** Every caller passes a budget explicitly. Anyone reaching for
  this as a real metric gets a sentinel and should be pointed at a plain Levenshtein instead.

### Memory

The table above is the mental model, not the data structure. Row `i` depends only on row `i-1`, row
`i-2` and its own left neighbour, so three arrays rotate: `rowAbove`, `rowBefore`, and the `row` being
filled. O(len(b)) space instead of O(len(a) × len(b)). `rowAbove` is called "above" rather than
"previous" because the naive naming reads wrong at the return — after the last swap, the variable
holding the newest row is the one named for the old one.

## `closeSpelling(a, b)` — how forgiving the matcher is

This is where the judgement lives, and it is three decisions:

**Judge by the shorter word.** Using the longer one would hand a 2-edit budget to the pair
`metadata`/`ate`, where almost nothing is shared to go wrong. The shorter word is the honest measure
of how much evidence survives.

**Never fuzz below 4 letters.** A 4-letter word already has about 75 one-substitution neighbours
against a catalogue vocabulary of a few hundred words; at 3 letters, `run`/`urn`, `on`/`one` and
`id`/`ip` all pair up and "within one edit" stops selecting anything. The floor is what keeps the
mechanism from becoming noise.

The failure mode is graceful, which is why the floor is affordable: a mistyped short word usually
still surfaces, because the other words in the name match exactly and carry the candidate in.

**Two edits from 8 letters up, one below.** Longer words tolerate more absolute mistakes at about the
same error rate. This is a cliff, not a curve, and it has a price: `instance` and `distance` are
exactly 2 apart at 8 letters, so they claim each other as typos. Accepted, because
[`suggest()`](#suggesttools-wanted-limit) ranks an exact word hit above a mistyped one, so a stray
match only changes the result when nothing matched exactly — which is the case where the alternative
is an empty suggestion list.

## `suggest(tools, wanted, limit)` — scoring

For every catalogue tool, count how many of the wanted words the name contains, then normalise.

```
score = shared / max(wanted word count, name word count)
```

`shared` adds 1 for a word present verbatim and 0.75 for one that `closeSpelling` claims as a typo.
The 0.25 gap is load-bearing: it means a name that actually contains `issue` always outscores one
whose `issues` merely resembles `isue`, so a real name can never be overtaken by a guess about it.

Dividing by the **longer** of the two word counts is what makes partial matches rank sensibly:
matching 2 of 2 words scores 1.0, while matching 2 of 5 scores 0.4. Dividing by the wanted count
instead would let a three-word typo sit above the one tool it was trying to name.

`mcp` is filtered out of both sides before comparing. It is a marker on every MCP tool, so it
contributes no evidence about which tool is meant — and leaving it in would let any two MCP tools
look one word alike.

Ties break on name, so the same catalogue always produces the same list. Nothing in the ranking is
tuned per-model; changing the numbers means changing the tiers above, and the tests in
[`tests/search.spec.mjs`](../tests/search.spec.mjs) pin each of them.

## Tuning, if suggestions misbehave

| symptom | knob |
|---|---|
| suggestions too eager, unrelated tools offered | raise `MIN_FUZZY_LENGTH`, or drop the 2-edit tier |
| a clear typo returns no suggestion | lower `MIN_SECOND_EDIT_LENGTH`, or raise the tier's budget |
| the right tool ranks second | check whether an exact word hit is being outscored, then the denominator |
| a server-named word refuses to match | look at `words()` limits above — acronyms and non-ASCII |

## Verifying changes to `distance`

The DP is worth re-checking against a dumb implementation after any edit, because both early exits
are silent: they return a plausible number rather than an error.

```js
// Full optimal-string-alignment matrix: no budget, no pruning, no row reuse.
function reference(a, b) {
  const d = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
  for (let i = 0; i <= a.length; i++) d[i][0] = i
  for (let j = 0; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1)
  }
  return d[a.length][b.length]
}

// distance(a, b, max) must equal the true distance when it fits, and max + 1 when it does not.
const want = reference(a, b) <= max ? reference(a, b) : max + 1
```

Random short pairs over a small alphabet, several budgets each: 120,000 such checks is the current
regression test for this file and runs in about a second. The alphabet matters — wide alphabets make
every pair unrelated and only exercise the length filter.
