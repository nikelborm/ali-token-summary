/**
 * USD to RUB conversion.
 *
 * The Central Bank of Russia rate is the reference figure for anything
 * denominated in roubles, so it is preferred. It is published on business days
 * only, which means a Sunday run legitimately returns Friday's number - the
 * `stale` flag exists so the report can say so rather than quietly implying the
 * rate is current. If CBR is unreachable, a market aggregate stands in.
 */
import * as BigDecimal from 'effect/BigDecimal'
import * as Context from 'effect/Context'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as HttpClient from 'effect/unstable/http/HttpClient'
import * as HttpClientRequest from 'effect/unstable/http/HttpClientRequest'
import * as HttpIncomingMessage from 'effect/unstable/http/HttpIncomingMessage'

export class FxError extends Schema.TaggedError<FxError>()('FxError', {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface Rate {
  readonly rubPerUsd: BigDecimal.BigDecimal
  readonly source: string
  readonly asOf: string
  /** True when the quote is more than a day old. */
  readonly stale: boolean
}

const CBR_URL = 'https://www.cbr-xml-daily.ru/daily_json.js'
const ER_API_URL = 'https://open.er-api.com/v6/latest/USD'

const CbrResponse = Schema.Struct({
  Date: Schema.String,
  Valute: Schema.Struct({
    USD: Schema.Struct({
      // The rate is quoted per `Nominal` units of the foreign currency.
      Nominal: Schema.Number,
      Value: Schema.Number,
    }),
  }),
})

const ErApiResponse = Schema.Struct({
  result: Schema.String,
  time_last_update_utc: Schema.String,
  rates: Schema.Struct({ RUB: Schema.Number }),
})

const DAY_MILLIS = 24 * 60 * 60 * 1000

const decimalOf = (value: number, label: string) =>
  Option.match(BigDecimal.fromNumber(value), {
    onNone: () =>
      Effect.fail(
        new FxError({ message: `${label} is not a usable number: ${value}` }),
      ),
    onSome: Effect.succeed,
  })

export class Fx extends Context.Service<
  Fx,
  {
    readonly usdToRub: Effect.Effect<Rate, FxError>
  }
>()('ali_summary/Fx') {}

export const layer = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient

  const fetchJson = Effect.fnUntraced(function* <S extends Schema.Struct<any>>(
    url: string,
    schema: S,
    label: string,
  ) {
    const response = yield* client
      .execute(HttpClientRequest.get(url))
      .pipe(
        Effect.mapError(
          cause => new FxError({ message: `${label} is unreachable`, cause }),
        ),
      )
    if (response.status >= 400) {
      return yield* new FxError({
        message: `${label} responded with HTTP ${response.status}`,
      })
    }
    return yield* HttpIncomingMessage.schemaBodyJson(schema)(response).pipe(
      Effect.mapError(
        cause =>
          new FxError({
            message: `${label} returned an unexpected shape`,
            cause,
          }),
      ),
    )
  })

  const stalenessOf = Effect.fnUntraced(function* (quotedAt: string) {
    const now = yield* DateTime.now
    const quoted = DateTime.make(quotedAt)
    if (Option.isNone(quoted)) return false
    const age =
      DateTime.toDateUtc(now).getTime() -
      DateTime.toDateUtc(quoted.value).getTime()
    return age > DAY_MILLIS
  })

  const fromCbr = Effect.gen(function* () {
    const body = yield* fetchJson(CBR_URL, CbrResponse, 'CBR')
    const value = yield* decimalOf(body.Valute.USD.Value, 'CBR USD rate')
    const nominal = yield* decimalOf(body.Valute.USD.Nominal, 'CBR USD nominal')

    const rubPerUsd = yield* Option.match(BigDecimal.divide(value, nominal), {
      onNone: () =>
        Effect.fail(new FxError({ message: 'CBR quoted a zero nominal' })),
      onSome: Effect.succeed,
    })

    return {
      rubPerUsd,
      source: 'CBR',
      asOf: body.Date,
      stale: yield* stalenessOf(body.Date),
    } satisfies Rate
  })

  const fromErApi = Effect.gen(function* () {
    const body = yield* fetchJson(ER_API_URL, ErApiResponse, 'open.er-api.com')
    if (body.result !== 'success') {
      return yield* new FxError({
        message: `open.er-api.com reported "${body.result}"`,
      })
    }
    const rubPerUsd = yield* decimalOf(
      body.rates.RUB,
      'open.er-api.com RUB rate',
    )

    return {
      rubPerUsd,
      source: 'open.er-api.com',
      asOf: body.time_last_update_utc,
      stale: yield* stalenessOf(body.time_last_update_utc),
    } satisfies Rate
  })

  const usdToRub = fromCbr.pipe(
    Effect.tapError(error =>
      Effect.logWarning(
        `CBR lookup failed (${error.message}); falling back to open.er-api.com`,
      ),
    ),
    Effect.catch(() => fromErApi),
  )

  return Fx.of({ usdToRub })
}).pipe(Layer.effect(Fx))
