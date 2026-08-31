# ali_summary

Per-model Alibaba Cloud Model Studio spend, at full precision, in USD and RUB.

`QueryAccountBalance` rounds everything to two decimal places, so a month of
cheap model calls reads as `0.00`. This reports the number underneath that.

```bash
bun install
bun run index.ts             # current billing cycle
bun run index.ts 2026-08     # a specific cycle
```

```
┌──────────────────────┬──────────────────────┬────┬─────┬────────┬───────────┬──────────┬────────┐
│                      │ product              │ in │ out │ cached │ USD       │ RUB      │ USD/1M │
├──────────────────────┼──────────────────────┼────┼─────┼────────┼───────────┼──────────┼────────┤
│        zhipu/glm-5.3 │ mpintl-mt9-dt26      │ 72 │ 395 │ 0      │ 0.0018388 │ 0.157403 │ 3.9375 │
│ glm-5.2-fast-preview │ sfm                  │ 14 │ 105 │ 0      │ 0.0009632 │ 0.082451 │ 8.0941 │
│              kimi-k3 │ sfm                  │ 0  │ 0   │ 0      │ 0.00      │ 0.00     │ —      │
│                TOTAL │ mpintl-mt9-dt26, sfm │ 86 │ 500 │ 0      │ 0.002802  │ 0.239853 │ 4.7816 │
└──────────────────────┴──────────────────────┴────┴─────┴────────┴───────────┴──────────┴────────┘
```

## Flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `[cycle]` | current month | Billing cycle, `YYYY-MM` |
| `--currency, -c` | `both` | `usd`, `rub`, or `both` |
| `--product, -p` | every product | Restrict to one product code |
| `--transport` | `http` | `http` signs requests directly; `cli` shells out to `aliyun` |
| `--json` | off | Machine-readable output; amounts stay decimal strings |
| `--nonzero` | off | Hide models that cost nothing this cycle |

## Credentials

`ALIBABA_CLOUD_ACCESS_KEY_ID` and `ALIBABA_CLOUD_ACCESS_KEY_SECRET` are used when
both are set. Otherwise the two values are read concurrently from the password
store:

```
pass show alibabacloud.com/vova/access_key_id
pass show alibabacloud.com/vova/access_key_secret
```

The `aliyun` binary is not required. Requests are signed locally (Signature
Version 1.0, HMAC-SHA1) and sent straight to `business.ap-southeast-1.aliyuncs.com`.
`--transport cli` remains as a fallback, and passes credentials through the
child environment rather than argv so they stay out of the process table.

## Notes on the numbers

- **`PretaxGrossAmount` is the real figure.** Alibaba computes the sub-cent
  amount, then rounds it down and discounts the remainder away, which is why the
  account balance stays at `0.00`. The report shows gross and charged separately.
- **The model name lives in `InstanceID`**, written two ways. Model Studio
  (`sfm`) uses `owner;workspace;model;token_type;…`, while Marketplace
  (`mpintl-*`), which resells third-party models, uses
  `order;VENDOR/MODEL;owner;workspace;region;channel;token_types;commodity` —
  the model stated outright and the token type pluralised. Neither segment
  count is stable, so the token type is found by pattern and the model is
  either the vendor-qualified segment or the one before the token type.
  Marketplace models keep their vendor (`zhipu/glm-5.3`) so a resold model
  never merges with a first-party one of the same name, and are lower-cased to
  match the rest of the column. Lines from products that do not bill for
  inference at all keep their raw identifier and have their usage counted as
  `untyped` rather than being dropped.
- **Scientific notation never reaches the screen.** Amounts arrive as `3.92E-5`,
  and `BigDecimal.format` itself switches to exponential at scale 16, so
  `Format.toPlainString` renders positionally and `Intl.NumberFormat` groups
  digits with spaces.
- **The FX rate is CBR**, which is the reference rate for anything denominated
  in roubles but publishes on business days only. `open.er-api.com` stands in if
  CBR is unreachable.
- **Token counts are metered in thousands**, spelled `1K tokens` by Model
  Studio and `KTokens` by Marketplace. Both are scaled to whole tokens; any
  other unit passes through unscaled rather than being misreported.
- **Bills settle with a lag** of a few hours, so very recent calls may not appear.

## Development

```bash
bun test          # includes Alibaba's documented signature test vector
bun run typecheck # tsgo (TypeScript 7)
```
