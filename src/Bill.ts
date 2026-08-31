/**
 * Model Studio bill retrieval and the domain model it decodes into.
 *
 * The interesting field is `InstanceID`, which is where Alibaba hides the model
 * name. For Model Studio inference it looks like:
 *
 *     1110389;ws-9h4296dos6ll46s2;glm-5.2-fast-preview;input_token;0
 *     ^owner  ^workspace          ^model               ^token type ^
 *
 * The segment count is not stable - some models emit a sixth, empty segment -
 * so the token-type segment is located by pattern and the model read from the
 * position before it, rather than by a fixed index.
 */
import { BigDecimal, Context, Effect, Layer, Option, Schema } from 'effect'

import { AliyunApi, type AliyunError } from './Aliyun.ts'

export class BillError extends Schema.TaggedError<BillError>()('BillError', {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export const ZERO = BigDecimal.fromBigInt(0n)

/** Bill amounts arrive as JSON numbers, often in exponent form (`3.92E-5`). */
const decimalFromNumber = (value: number): BigDecimal.BigDecimal =>
  Option.getOrElse(BigDecimal.fromNumber(value), () => ZERO)

/** Usage and unit prices arrive as strings, and may be empty. */
const decimalFromString = (value: string): BigDecimal.BigDecimal =>
  Option.getOrElse(BigDecimal.fromString(value), () => ZERO)

export type TokenKind = 'input' | 'output' | 'cache' | 'other'

const TOKEN_SEGMENT = /^(input|output)_token(_cache)?$/

const classify = (segment: string): TokenKind =>
  segment.endsWith('_cache')
    ? 'cache'
    : segment.startsWith('output')
      ? 'output'
      : 'input'

export interface Attribution {
  readonly model: string
  readonly kind: TokenKind
}

/**
 * Recovers the model name and token type from an `InstanceID`.
 *
 * Products outside Model Studio inference use an unrelated `InstanceID` shape,
 * so anything unrecognised falls back to a caller-supplied label instead of
 * being silently dropped from the report.
 */
export const attribute = (
  instanceId: string,
  fallback: string,
): Attribution => {
  const segments = instanceId.split(';')
  const index = segments.findIndex(segment => TOKEN_SEGMENT.test(segment))
  if (index > 0) {
    return { model: segments[index - 1]!, kind: classify(segments[index]!) }
  }
  return { model: instanceId === '' ? fallback : instanceId, kind: 'other' }
}

const RawItem = Schema.Struct({
  InstanceID: Schema.String,
  BillingItem: Schema.optionalKey(Schema.String),
  ProductCode: Schema.String,
  ProductName: Schema.optionalKey(Schema.String),
  Currency: Schema.optionalKey(Schema.String),
  Usage: Schema.optionalKey(Schema.String),
  UsageUnit: Schema.optionalKey(Schema.String),
  ListPrice: Schema.optionalKey(Schema.String),
  // What the usage is actually worth, before Alibaba rounds sub-cent totals
  // down and discounts the remainder away. This is the number worth tracking.
  PretaxGrossAmount: Schema.Number,
  // What ends up on the invoice after that round-down.
  PretaxAmount: Schema.optionalKey(Schema.Number),
})

const InstanceBillResponse = Schema.Struct({
  Code: Schema.optionalKey(Schema.String),
  Message: Schema.optionalKey(Schema.String),
  Success: Schema.optionalKey(Schema.Boolean),
  Data: Schema.optionalKey(
    Schema.Struct({
      BillingCycle: Schema.optionalKey(Schema.String),
      TotalCount: Schema.optionalKey(Schema.Number),
      NextToken: Schema.optionalKey(Schema.String),
      Items: Schema.optionalKey(Schema.Array(RawItem)),
    }),
  ),
})

const decodeResponse = Schema.decodeUnknownEffect(InstanceBillResponse)

/** One bill line, with the model attribution already resolved. */
export interface LineItem {
  readonly model: string
  readonly kind: TokenKind
  readonly productCode: string
  readonly productName: string
  readonly billingItem: string
  /** Gross cost in USD, before the sub-cent round-down. */
  readonly gross: BigDecimal.BigDecimal
  /** Cost actually charged, after the round-down. */
  readonly charged: BigDecimal.BigDecimal
  /** Usage expressed in whole tokens. */
  readonly tokens: BigDecimal.BigDecimal
  /** Unit list price, in USD per 1K tokens. */
  readonly listPrice: BigDecimal.BigDecimal
}

const THOUSAND = BigDecimal.fromBigInt(1000n)

const toLineItem = (raw: (typeof RawItem)['Type']): LineItem => {
  const { kind, model } = attribute(
    raw.InstanceID,
    raw.ProductName ?? raw.ProductCode,
  )
  const usage = decimalFromString(raw.Usage ?? '')
  // Model Studio meters in units of 1K tokens; anything else is passed through
  // unscaled rather than silently misreported.
  const tokens =
    raw.UsageUnit === '1K tokens' ? BigDecimal.multiply(usage, THOUSAND) : usage

  return {
    model,
    kind,
    productCode: raw.ProductCode,
    productName: raw.ProductName ?? raw.ProductCode,
    billingItem: raw.BillingItem ?? '',
    gross: decimalFromNumber(raw.PretaxGrossAmount),
    charged: decimalFromNumber(raw.PretaxAmount ?? 0),
    tokens,
    listPrice: decimalFromString(raw.ListPrice ?? ''),
  }
}

export interface InstanceBillOptions {
  /** Billing cycle in `YYYY-MM` form. */
  readonly cycle: string
  /** Restrict to a single product code; omit to cover every product. */
  readonly productCode?: string | undefined
}

export class Bill extends Context.Service<
  Bill,
  {
    instanceBill(
      options: InstanceBillOptions,
    ): Effect.Effect<ReadonlyArray<LineItem>, BillError>
  }
>()('ali_summary/Bill') {}

export const layer = Effect.gen(function* () {
  const api = yield* AliyunApi

  const page = Effect.fn('Bill.page')(function* (
    options: InstanceBillOptions,
    nextToken: Option.Option<string>,
  ) {
    const payload = yield* api
      .call('DescribeInstanceBill', {
        BillingCycle: options.cycle,
        Granularity: 'MONTHLY',
        IsBillingItem: 'true',
        MaxResults: '300',
        ...(options.productCode === undefined
          ? {}
          : { ProductCode: options.productCode }),
        ...(Option.isSome(nextToken) ? { NextToken: nextToken.value } : {}),
      })
      .pipe(
        Effect.mapError(
          (error: AliyunError) =>
            new BillError({ message: error.message, cause: error.cause }),
        ),
      )

    const response = yield* Effect.mapError(
      decodeResponse(payload),
      cause =>
        new BillError({
          message: 'DescribeInstanceBill returned an unexpected shape',
          cause,
        }),
    )

    if (response.Success === false) {
      return yield* new BillError({
        message: `DescribeInstanceBill refused the request: ${response.Message ?? response.Code ?? 'no reason given'}`,
      })
    }

    // An absent or empty token both mean "no further pages".
    const token = response.Data?.NextToken
    return {
      items: (response.Data?.Items ?? []).map(toLineItem),
      nextToken:
        token === undefined || token === ''
          ? Option.none<string>()
          : Option.some(token),
    }
  })

  const instanceBill = Effect.fn('Bill.instanceBill')(function* (
    options: InstanceBillOptions,
  ) {
    const collected: Array<LineItem> = []
    let cursor = Option.none<string>()

    // DescribeInstanceBill caps a page at 300 items and paginates by token.
    while (true) {
      const result = yield* page(options, cursor)
      collected.push(...result.items)
      if (Option.isNone(result.nextToken)) break
      cursor = result.nextToken
    }

    return collected
  })

  return Bill.of({ instanceBill })
}).pipe(Layer.effect(Bill))
