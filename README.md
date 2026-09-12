# dsh-cost-pill

Shows what the current Session has cost, as a compact readout among the
composer's tool-row controls.

## What it reports

Three sources, in descending order of authority:

| Source | Cost | Meaning |
| --- | --- | --- |
| OpenRouter generation record | one lookup per generation, each done once | the amount actually billed |
| Live model rates × reported tokens | no requests | an estimate, used until the lookup settles |
| nothing | — | the step is unpriced; the total is a lower bound |

The generation record is authoritative because the provider settles it: it names
the upstream provider that served the request and the exact charge. A generation
is looked up once and kept forever, since a settled amount never changes.

## Reading the pill

| Shown | Meaning |
| --- | --- |
| `$0.0123` | every step is settled — the billed total |
| `≈ $0.0123 est.` | lookups still running, some steps estimated from live rates |
| `≥ $0.0123` | at least one step has no price, so this is a lower bound |

The tooltip carries the counts and the providers involved.

## Requirements

- The `web` capability must be composed, for `ctx.web.fetch` of the public rate
  table.
- `shell` and `credentials` must be composed for the billed lookup. Without
  them the pill still works, but only shows estimates.
- The OpenRouter key is read from the credential reference `OPENROUTER_API_KEY`
  at each lookup, never cached across lookups.

## Known limitations

- Lookups are serialized, one every four seconds, so a long Session backfills
  gradually. The pill says so while it catches up.
- Only OpenRouter routes can be settled; every other provider falls back to an
  estimate, and to a lower bound when its rates are unknown too.
- The rate table uses the first endpoint OpenRouter lists for a model, because
  the durable log does not record which upstream served a request. That matters
  only for the estimate, never for the settled amount.
