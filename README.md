# dsh-cost-pill

Shows the current Session's estimated token cost, as a compact readout among the
composer's tool-row controls. It follows the pi coding-agent style:
`$0.000` for a normal route and `$0.000 (sub)` for a subscription route.

## What it reports

The pill uses the published model prices from the installed pi-ai catalogs. For
each Assistant message it applies the route's input, output, cache-read, and
cache-write rates to the durable token counts. This is always an estimate, not
an account charge: it does not contact OpenRouter, resolve an API key, or try
to settle a generation record.

A step with no matching provider/model catalog stays unpriced rather than being
shown as free. The tooltip reports the number of priced and unpriced steps, the
routes involved, and whether the route is subscription-covered.

## Reading the pill

| Shown | Meaning |
| --- | --- |
| `$0.004` | estimated at pi-ai's published list price |
| `$0.004 (sub)` | same estimate for a subscription route; not an account charge |
| `$0.000` | no priced usage yet, or the priced usage rounds below $0.0005 |

The amount is formatted to three decimal places to match the pi coding agent.
Hover the pill for the exact interpretation and route details.

## Requirements

No credentials, shell, or network capability is required. The plugin reads the
installed pi-ai catalogs locally. `DSH_PI_AI_DATA` can override the catalog
directory when the runtime cannot discover it automatically.

## Known limitations

- A list price is not a charge. On a subscription route the estimate says what
  the same tokens would cost at list price, while the account may pay through a
  plan instead.
- List prices come from the installed pi-ai catalogs, found by searching upward
  from the running CLI. With no catalog found, usage is shown as unpriced.
- One model id can be described by many catalog files, because the same model is
  served by OpenAI, Azure, Copilot, OpenCode, and gateways in between. The
  catalogs are therefore indexed by provider, then by model id. Nothing is
  chosen by directory order, so a route cannot be priced from an unrelated
  provider that happens to sort first.
- A route is a deployment's own name, while a catalog names the provider that
  serves it: this deployment's ChatGPT routes `codex-personal` and
  `codex-business` are both priced by `openai-codex`. That binding lives in the
  plugin that owns the route, not in the durable log, and is stated explicitly
  in `CATALOG_PROVIDER_BY_ROUTE`. A route missing from that table is priced only
  when its name is already a catalog provider name (`openrouter` is); otherwise
  it remains unpriced.
