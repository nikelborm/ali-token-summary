import { describe, expect, test } from 'bun:test'

import * as BigDecimal from 'effect/BigDecimal'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'

import * as Aliyun from '../src/Aliyun.ts'
import * as Bill from '../src/Bill.ts'
import * as Format from '../src/Format.ts'
import * as Report from '../src/Report.ts'
import * as Fixtures from './fixtures.ts'

const withPayload = (payload: unknown) =>
  Bill.layer.pipe(
    Layer.provide(
      Layer.succeed(
        Aliyun.AliyunApi,
        Aliyun.AliyunApi.of({ call: () => Effect.succeed(payload) }),
      ),
    ),
  )

const fetchRows = (payload: unknown) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const bill = yield* Bill.Bill
      return Report.aggregate(yield* bill.instanceBill({ cycle: '2026-08' }))
    }).pipe(Effect.provide(withPayload(payload))),
  )

/** Narrowing lookups: a missing row is a test failure with a name attached. */
const rowAt = (
  rows: ReadonlyArray<Report.ModelTotals>,
  index: number,
): Report.ModelTotals => {
  const row = rows[index]
  if (row === undefined) throw new Error(`no row at index ${index}`)
  return row
}

const rowOf = (
  rows: ReadonlyArray<Report.ModelTotals>,
  model: string,
): Report.ModelTotals => {
  const row = rows.find(candidate => candidate.model === model)
  if (row === undefined) throw new Error(`no row for model ${model}`)
  return row
}

const tableRow = (table: Report.Table, model: string): Report.TableRow => {
  const row = table[model]
  if (row === undefined) throw new Error(`no table row for model ${model}`)
  return row
}

describe('attribute', () => {
  test('reads the model from the segment before the token type', () => {
    expect(
      Bill.attribute('1110389;ws-9h4296dos6ll46s2;glm-5.1;input_token;0', '?'),
    ).toEqual({
      model: 'glm-5.1',
      kind: 'input',
    })
  })

  test('is unaffected by the extra empty segment some models emit', () => {
    expect(
      Bill.attribute(
        '1110389;ws-9h4296dos6ll46s2;qwen3.8-flash;output_token;;0',
        '?',
      ),
    ).toEqual({
      model: 'qwen3.8-flash',
      kind: 'output',
    })
  })

  test('distinguishes cached input from fresh input', () => {
    expect(
      Bill.attribute('1110389;ws-x;qwen3.8-flash;input_token_cache;;0', '?')
        .kind,
    ).toBe('cache')
  })

  test('keeps unrecognised instance ids rather than dropping the line', () => {
    expect(Bill.attribute('mp-instance-8842', 'Marketplace')).toEqual({
      model: 'mp-instance-8842',
      kind: 'other',
    })
  })
})

describe('aggregate', () => {
  test("sums a model's line items to the cent-exact gross", async () => {
    const rows = await fetchRows(Fixtures.describeInstanceBill)
    const fast = rowOf(rows, 'glm-5.2-fast-preview')

    // 3.92e-5 input + 9.24e-4 output, matching QueryBillOverview's total for sfm.
    expect(Format.toPlainString(fast.gross)).toBe('0.0009632')
    expect(Format.toPlainString(fast.inputTokens)).toBe('14')
    expect(Format.toPlainString(fast.outputTokens)).toBe('105')
  })

  test('orders by spend, so the models that cost money come first', async () => {
    const rows = await fetchRows(Fixtures.describeInstanceBill)
    expect(rowAt(rows, 0).model).toBe('glm-5.2-fast-preview')
  })

  test('collapses every token type of one model into a single row', async () => {
    const rows = await fetchRows(Fixtures.describeInstanceBill)
    const qwen = rowOf(rows, 'qwen3.8-flash')
    expect(qwen.products).toEqual(['sfm'])
    expect(rows.filter(row => row.model === 'qwen3.8-flash')).toHaveLength(1)
  })

  test('carries marketplace lines through alongside Model Studio ones', async () => {
    const payload = {
      ...Fixtures.describeInstanceBill,
      Data: {
        ...Fixtures.describeInstanceBill.Data,
        Items: [
          ...Fixtures.describeInstanceBill.Data.Items,
          Fixtures.marketplaceItem,
        ],
      },
    }
    const rows = await fetchRows(payload)
    const total = Report.totalOf(rows)

    const top = rowAt(rows, 0)

    // Its usage carries no recognisable token type, but must still be counted.
    expect(Format.toPlainString(top.otherTokens)).toBe('400')
    expect(
      Format.money(Option.getOrThrow(Report.perMillionTokens(top)), 4),
    ).toBe('4.597')
    expect(top.model).toBe('mp-instance-8842')
    expect(Format.toPlainString(total.gross)).toBe('0.002802')
    expect(total.products).toEqual(['mpintl-mt9-dt26', 'sfm'])
  })
})

describe('formatting', () => {
  test('never falls back to scientific notation, whatever the scale', () => {
    // BigDecimal.format switches to an exponent once the scale reaches 16,
    // which a currency multiplication reaches easily.
    const awkward = BigDecimal.make(392n, 20)
    expect(BigDecimal.format(awkward)).toContain('e')
    expect(Format.toPlainString(awkward)).not.toContain('e')
    expect(Format.money(awkward, 12)).not.toContain('e')
  })

  test('separates digit groups with spaces', () => {
    expect(Format.count(BigDecimal.fromStringUnsafe('1234567'))).toBe(
      '1 234 567',
    )
    expect(Format.money(BigDecimal.fromStringUnsafe('1234.5'))).toBe('1 234.50')
  })

  test('keeps every significant digit of a sub-cent amount', () => {
    expect(Format.money(BigDecimal.fromStringUnsafe('0.0000392'), 8)).toBe(
      '0.0000392',
    )
  })
})

describe('derived figures', () => {
  test('prices a model per million tokens from its own usage', async () => {
    const rows = await fetchRows(Fixtures.describeInstanceBill)
    const fast = rowOf(rows, 'glm-5.2-fast-preview')
    const perMillion = Report.perMillionTokens(fast)

    // 0.0009632 USD over 119 tokens.
    expect(Format.money(Option.getOrThrow(perMillion), 2)).toBe('8.09')
  })

  test('reports no unit price for a model with no metered usage', async () => {
    const rows = await fetchRows(Fixtures.describeInstanceBill)
    const idle = rowOf(rows, 'kimi-k3')
    expect(Option.isNone(Report.perMillionTokens(idle))).toBe(true)
  })

  test('converts to roubles by exact decimal multiplication', async () => {
    const rows = await fetchRows(Fixtures.describeInstanceBill)
    const table = Report.toTable([Report.totalOf(rows)], {
      currency: 'both',
      rate: Option.some({
        rubPerUsd: BigDecimal.fromStringUnsafe('85.6007'),
        source: 'CBR',
        asOf: '2026-08-29T11:30:00+03:00',
        stale: true,
      }),
    })

    const total = tableRow(table, 'TOTAL')

    expect(total.USD).toBe('0.0009632')
    expect(total.RUB).toBe('0.082451')
  })
})
