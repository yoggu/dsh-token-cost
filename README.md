# dsh-cost-pill

Shows what the current Session has cost, as a compact readout among the
composer's tool-row controls.

## What it reports

Three sources, in descending order of authority:

| Source | Cost | Meaning |
| --- | --- | --- |
| OpenRouter generation record | one lookup per generation, each done once | the amount actually billed |
| OpenRouter live model rates | one refresh per model every five minutes | an estimate, used until the lookup settles |
| Published list price from the installed pi-ai catalogs | read once, no requests | an estimate for routes OpenRouter does not serve |

The generation record is authoritative because the provider settles it: it names
the upstream provider that served the request and the exact charge. A generation
is looked up once and kept forever, since a settled amount never changes.

A step no source can price stays unpriced rather than being shown as free, and
the total becomes a lower bound.

## Reading the pill

| Shown | Meaning |
| --- | --- |
| `$0.0123` | every step is settled — the billed total |
| `≈ $0.0123` | some steps are estimated, or their lookup is still running |
| `≥ $0.0123` | at least one step has no price, so this is a lower bound |
| `$—` | nothing can be priced yet |

The tooltip carries the counts, the providers involved, and which part of the
amount is an estimate at published list price rather than a billed charge.

## Requirements

- The `web` capability must be composed, for `ctx.web.fetch` of OpenRouter's
  public rate table.
- `shell` and `credentials` must be composed for the billed lookup. Without
  them the pill still works, but only shows estimates.
- The OpenRouter key is read from the credential reference `OPENROUTER_API_KEY`
  at each lookup, never cached across lookups, and handed to `curl` in the child
  process environment rather than on a command line.

## Known limitations

- Lookups are serialized, one every four seconds, so a long Session backfills
  gradually. The pill says so while it catches up.
- Only OpenRouter routes can be settled. Every other provider falls back to the
  published list price, and to a lower bound when no catalog states one.
- A list price is not a charge. On a subscription route the estimate says what
  the same tokens would cost at list price, which is not what the account pays,
  so the tooltip labels that part accordingly.
- OpenRouter's rate table uses the first endpoint listed for a model, because
  the durable log does not record which upstream served a request. That affects
  the estimate only, never the settled amount.
- List prices come from the installed pi-ai catalogs, found by searching upward
  from the running CLI. `DSH_PI_AI_DATA` overrides that search. With no catalog
  found, non-OpenRouter routes are simply unpriced.
