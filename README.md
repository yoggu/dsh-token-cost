# dsh-token-cost-estimate

Shows an estimated token cost for the current DSH Web session in the composer. Prices come from the installed pi-ai model catalogs; **this is not a bill**. Subscription routes show `(sub)`, and usage without a matching catalog entry remains unpriced rather than being treated as free.

## Install from GitHub

```sh
dsh plugin --profile web add https://github.com/yoggu/dsh-token-cost-estimate.git
```

Restart DSH Web if necessary and reload the page. No external price API or separate credentials are needed; the browser reads the local estimate over DSH's authenticated `/api` channel. If catalog discovery fails, `DSH_PI_AI_DATA` can point to the local pi-ai catalog directory.

To uninstall: `dsh plugin --profile web remove dsh-token-cost-estimate`.

## Limitations

List prices and actual charges can differ, especially for subscriptions. Routes with custom provider names need a matching catalog-provider mapping in the plugin or remain unpriced.

## License

MIT; see [LICENSE](LICENSE).
