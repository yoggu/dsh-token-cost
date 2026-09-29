# dsh-token-cost

Shows **estimated** cost for the current DSH Web session, never an invoice. DSH logs each Assistant settlement's provider route, model ID and disjoint input/output/cache-read/cache-write token counts. The Host projection folds that durable log and prices it using the physically resolved pi-ai catalog and `calculateCost` belonging to the shipped `@deepseek-ai/dsh-llm-pi-ai` adapter. It makes no paid inference, opens no HTTP endpoint, and needs no `dsh-model-pricing` service or account credentials.

## Installation

Install the latest tagged GitHub release:

```sh
dsh plugin --profile web add 'https://github.com/yoggu/dsh-token-cost.git#v0.2.2'
```

Or clone and link a checkout:

```sh
git clone --branch v0.2.2 --depth 1 https://github.com/yoggu/dsh-token-cost.git
cd dsh-token-cost
dsh plugin --profile web add "link:$(pwd)"
```

Keep linked checkouts in place while installed. Restart DSH after replacing an installed package version, then refresh the browser. Uninstall with `dsh plugin --profile web remove dsh-token-cost`; this removes the readout, not session logs or credentials.

The shipped `llm-pi-ai` adapter and its pi-ai dependency must be resolvable from the running Harness process. No process-wide search, cwd fallback, consumer-local pi-ai copy or arbitrary filesystem override is accepted; the old `DSH_PI_AI_DATA` override is no longer used. If owner resolution or catalog validation fails, settlements show **unpriced**, not free. The current implementation is tested with pi-ai **0.99.1**, without changing the shipped adapter or its dependency.

## Price mapping and provenance

- Exact `openrouter` routes use the installed pi-ai `openrouter` catalog. Custom gateway aliases are not inferred.
- Exact built-in `openai-codex` routes use `openai-codex`; displayed USD is an **API-equivalent subscription estimate**, not a ChatGPT subscription invoice.
- Historical `codex-business` and `codex-personal` log routes retain **legacy** subscription estimates from today's shipped pi-ai `openai-codex` catalog after the old account adapter is removed. This is a lookup of old event IDs only, not new-route admission or attestation that the historical adapter used this exact version.
- Exact `deepseek-official` routes use the `deepseek` catalog as an **independent list-price estimate**. Its Messages endpoint is not served by pi-ai and its billing parity is not attested by this plugin. An unknown model ID or gateway route stays unpriced.

For each valid entry, the Host report retains pi-ai package name, version, catalog-file SHA-256 digest, exact route binding label, and the number of contributing settlements; the Web tooltip only says “Estimated cost” (and “subscription” on subscription routes). The displayed cost is calculated using **the currently installed catalog**; the DSH log stores counts, not an original USD charge or historical price. If prices change after a pi-ai upgrade, intentionally increase the projection `stateVersion` and cold-replay events before claiming newly repriced history; a catalog revision alone does not invalidate checkpoints. This version supports pi-ai 0.99.1's typed `chat:<model-id>` catalog keys (as well as legacy bare keys), while looking up the bare model IDs recorded by DSH. Image/classifier entries are never used for chat pricing. It uses `stateVersion: 6` to replay checkpoints from versions 1–5 and recover estimates previously skipped by the new catalog format. There is no catalog filesystem I/O in the fold.

`calculateCost` selects the applicable request-wide tier using uncached input plus cache reads and writes. Reasoning is already part of output. Incomplete/non-finite/negative prices and ambiguous duplicate model entries fail closed. DSH lacks the `cacheWrite1h` bucket; models with duration-specific write rates or Anthropic-protocol cache writes are unpriced when their accounting cannot be faithfully reconstructed. The readout dims estimates with partial coverage rather than interpreting unpriced calls as $0.

**Limits:** Explicit route IDs do not prove custom endpoint ownership or actual billing; profile owners must not repoint reviewed routes silently. The estimate doesn't include non-model charges. DeepSeek parity and historical subscription prices are specifically caveated.

Run `npm test` for the complete offline suite. MIT; see [LICENSE](<LICENSE>).
