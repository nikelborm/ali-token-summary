/**
 * `ali-summary` - per-model Alibaba Cloud Model Studio spend, at full precision.
 */
import { BunHttpClient, BunRuntime, BunServices } from '@effect/platform-bun'
import {
  BigDecimal,
  Console,
  DateTime,
  Effect,
  identity,
  Layer,
  Option,
  References,
  Schema,
} from 'effect'
import { Argument, Command, Flag } from 'effect/unstable/cli'

import { type AliyunApiLayer, layerCli, layerHttp } from './Aliyun.ts'
import * as Bill from './Bill.ts'
import * as Credentials from './Credentials.ts'
import * as Format from './Format.ts'
import * as Fx from './Fx.ts'
import * as Report from './Report.ts'

const BillingCycle = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^\d{4}-(0[1-9]|1[0-2])$/, {
      message: 'Expected a billing cycle of the form YYYY-MM, e.g. 2026-08',
    }),
  ),
)

const cycle = Argument.string('cycle').pipe(
  Argument.withDescription(
    'Billing cycle to report on, as YYYY-MM (default: the current month)',
  ),
  Argument.withSchema(BillingCycle),
  Argument.optional,
)

const currency = Flag.choice('currency', ['usd', 'rub', 'both']).pipe(
  Flag.withAlias('c'),
  Flag.withDescription('Which currency columns to print'),
  Flag.withDefault('rub'),
)

const product = Flag.string('product').pipe(
  Flag.withAlias('p'),
  Flag.withDescription(
    'Restrict the report to one product code (default: every product)',
  ),
  Flag.optional,
)

const transport = Flag.choice('transport', ['http', 'cli']).pipe(
  Flag.withDescription(
    'Reach the API directly, or shell out to the `aliyun` binary',
  ),
  Flag.withDefault('http'),
)

const json = Flag.boolean('json').pipe(
  Flag.withDescription('Emit the aggregate as JSON instead of a table'),
  Flag.withDefault(false),
)

const nonzero = Flag.boolean('nonzero').pipe(
  Flag.withDescription('Hide models that cost nothing this cycle'),
  Flag.withDefault(false),
)

/** The billing cycle containing "now", used when none is given. */
const currentCycle = Effect.map(DateTime.now, now =>
  DateTime.formatIsoDateUtc(now).slice(0, 7),
)

/**
 * Everything the handler needs that the command line does not choose. It hangs
 * off the command rather than the runtime so that `--help` and a rejected
 * argument still work on a machine with no access key.
 */
const AppLayer = Credentials.layer.pipe(
  Layer.provideMerge(Fx.layer),
  Layer.provideMerge(BunHttpClient.layer),
  Layer.provideMerge(BunServices.layer),
)

const command = Command.make(
  'ali-summary',
  { cycle, currency, product, transport, json, nonzero },
  Effect.fn(function* (input) {
    const billingCycle = Option.isSome(input.cycle)
      ? input.cycle.value
      : yield* currentCycle
    const quiet = input.json

    const program = Effect.gen(function* () {
      const bill = yield* Bill.Bill
      const fx = yield* Fx.Fx
      const credentials = yield* Credentials.Credentials

      // The rate is a nicety, not a dependency: a report in dollars is still
      // worth printing when every FX source is down.
      const rate =
        input.currency === 'usd'
          ? Effect.succeed(Option.none<Fx.Rate>())
          : fx.usdToRub.pipe(
              Effect.map(Option.some),
              Effect.catch(error =>
                Effect.logWarning(
                  `No exchange rate available (${error.message}); showing USD only`,
                ).pipe(Effect.as(Option.none<Fx.Rate>())),
              ),
            )

      const [items, quote] = yield* Effect.all(
        [
          bill.instanceBill({
            cycle: billingCycle,
            productCode: input.product.pipe(Option.getOrUndefined),
          }),
          rate,
        ],
        { concurrency: 2 },
      )

      const all = Report.aggregate(items)
      const rows = input.nonzero
        ? all.filter(row => !BigDecimal.isZero(row.gross))
        : all

      if (input.json) {
        return yield* Console.log(
          JSON.stringify(
            Report.toJson(rows, { cycle: billingCycle, rate: quote }),
            null,
            2,
          ),
        )
      }

      if (rows.length === 0) {
        return yield* Console.log(
          `No billed usage for ${billingCycle}.\n` +
            'Daily settlement lags by a few hours, so very recent calls may not have landed yet.',
        )
      }

      yield* Console.log(
        `Alibaba Cloud Model Studio - billing cycle ${billingCycle}` +
          `  (via ${input.transport === 'cli' ? 'aliyun CLI' : 'signed HTTP'}, keys from ${credentials.source})`,
      )

      if (Option.isSome(quote)) {
        const line = `Rate: ${Format.fixed(quote.value.rubPerUsd, 4)} RUB/USD  (${quote.value.source}, ${quote.value.asOf})`
        yield* quote.value.stale
          ? // CBR publishes on business days only, so a weekend run is expected
            // to be behind. Say so instead of implying the number is live.
            Console.log(`${line}  [stale - no newer quote published]`)
          : Console.log(line)
      }

      yield* Console.log('')
      yield* Console.table(
        Report.toTable([...rows, Report.totalOf(rows)], {
          currency: input.currency,
          rate: quote,
        }),
      )

      const total = Report.totalOf(rows)
      yield* Console.log(
        `\nGross ${Format.money(total.gross, 8)} USD` +
          (Option.isSome(quote)
            ? ` / ${Format.money(BigDecimal.multiply(total.gross, quote.value.rubPerUsd), 4)} RUB`
            : '') +
          `, of which ${Format.money(total.charged, 8)} USD is actually charged.`,
      )

      if (BigDecimal.isZero(total.charged) && !BigDecimal.isZero(total.gross)) {
        yield* Console.log(
          'Sub-cent totals are rounded down and waived, which is why the account balance still reads 0.00.',
        )
      }
    })

    yield* program.pipe(
      // In JSON mode stdout must stay parseable, so warnings are dropped.
      quiet
        ? Effect.provideService(References.MinimumLogLevel, 'None')
        : identity,
    )
  }),
).pipe(
  Command.withDescription(
    'Report Alibaba Cloud Model Studio spend per model, at full precision',
  ),
  Command.provide(Bill.layer),
  // The one layer the command line chooses, so the one layer built fresh per
  // invocation and torn down with the handler.
  Command.provide(
    ({ transport }): AliyunApiLayer =>
      transport === 'cli' ? layerCli : layerHttp,
    { local: true },
  ),
)

command.pipe(
  Command.run({ version: '0.1.0' }),
  Effect.provide(AppLayer),
  BunRuntime.runMain,
)
