# dsh-token-cost

Shows an estimated token cost for the current DSH Web session in the composer. Prices come from the installed pi-ai model catalogs; **this is not a bill**. Subscription routes show `(sub)`, and usage without a matching catalog entry remains unpriced rather than being treated as free.

## Install

Install the tagged GitHub release into your DSH Web profile:

```sh
dsh plugin --profile web add 'https://github.com/yoggu/dsh-token-cost.git#v0.2.1'
```

Or download the source and link the local checkout:

```sh
git clone --branch v0.2.1 --depth 1 https://github.com/yoggu/dsh-token-cost.git
cd dsh-token-cost
dsh plugin --profile web add "link:$(pwd)"
```

Keep a linked checkout in place while the plugin is installed. Use the profile you actually run if it is not `web`.

Restart DSH Web if necessary and reload the page. No external price API or separate credentials are needed: the host publishes the estimate as a Session projection and the readout renders it, so the plugin requests nothing and polls nothing. An idle session produces no traffic at all. If catalog discovery fails, `DSH_PI_AI_DATA` can point to the local pi-ai catalog directory.

To uninstall: `dsh plugin --profile web remove dsh-token-cost`.

## Limitations

List prices and actual charges can differ, especially for subscriptions. Routes with custom provider names need a matching catalog-provider mapping in the plugin or remain unpriced.

## License

MIT; see [LICENSE](LICENSE).
