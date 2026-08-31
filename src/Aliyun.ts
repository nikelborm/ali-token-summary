/**
 * Transport for Alibaba Cloud RPC-style OpenAPI calls.
 *
 * Two interchangeable implementations of the same `AliyunApi` service, each a
 * layer of its own so the caller picks one and provides nothing else:
 *
 * - `layerHttp` signs and issues the request itself. No `aliyun` binary
 *   required, one round trip, and the credentials never touch a command line.
 * - `layerCli` shells out to `aliyun`, as an escape hatch if the signing ever
 *   drifts out of step with the service.
 *
 * Both target `bssOpenApi` and hand back the parsed-but-unvalidated JSON
 * payload; validating it is the caller's job, via Schema.
 */
import * as EArray from 'effect/Array'
import * as Context from 'effect/Context'
import * as Crypto from 'effect/Crypto'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import { flow } from 'effect/Function'
import * as Layer from 'effect/Layer'
import * as Order from 'effect/Order'
import type * as PlatformError from 'effect/PlatformError'
import * as Redacted from 'effect/Redacted'
import * as Schema from 'effect/Schema'
import * as HttpClient from 'effect/unstable/http/HttpClient'
import * as HttpClientRequest from 'effect/unstable/http/HttpClientRequest'
import * as ChildProcess from 'effect/unstable/process/ChildProcess'
import * as ChildProcessSpawner from 'effect/unstable/process/ChildProcessSpawner'

import * as Credentials from './Credentials.ts'

export class AliyunError extends Schema.TaggedError<AliyunError>()(
  'AliyunError',
  {
    message: Schema.String,
    cause: Schema.optionalKey(Schema.ErrorInstance()),
    body: Schema.optionalKey(Schema.Json),
  },
) {}

export interface Endpoint {
  /** Host serving the product's API, e.g. `business.ap-southeast-1.aliyuncs.com`. */
  readonly host: string
  /** Region id sent alongside the request, e.g. `ap-southeast-1`. */
  readonly region: string
  /** API version of the product, e.g. `2017-12-14` for BSS OpenAPI. */
  readonly version: string
  /** Product namespace as the `aliyun` CLI knows it, e.g. `bssopenapi`. */
  readonly product: string
}

export const bssOpenApi: Endpoint = {
  host: 'business.ap-southeast-1.aliyuncs.com',
  region: 'ap-southeast-1',
  version: '2017-12-14',
  product: 'bssopenapi',
}

// TODO: find sources for this
/**
 * Alibaba's canonicalisation treats only `A-Za-z0-9-_.~` as unreserved, which
 * is a slightly smaller set than `encodeURIComponent` leaves alone.
 */
export const alibabaEncodeURIComponent = (value: string): string =>
  encodeURIComponent(value)
    .replaceAll('!', '%21')
    .replaceAll("'", '%27')
    .replaceAll('(', '%28')
    .replaceAll(')', '%29')
    .replaceAll('*', '%2A')

export const canonicalizeQuery = (parameters: Record<string, string>): string =>
  Object.entries(parameters)
    .sort(([left], [right]) => Order.String(left, right))
    .map(flow(EArray.map(alibabaEncodeURIComponent), EArray.join('=')))
    .join('&')

const makeHmacSha1Base64 = (
  key: string,
  message: string,
): Effect.Effect<string> =>
  Effect.sync(() => {
    const hasher = new Bun.CryptoHasher('sha1', key)
    hasher.update(message)
    return hasher.digest('base64')
  })

/** Signature Version 1.0: sign `METHOD&/&<canonical query>` with `secret&`. */
export const sign = (
  secret: string,
  method: string,
  canonicalQuery: string,
): Effect.Effect<string, PlatformError.PlatformError, Crypto.Crypto> =>
  makeHmacSha1Base64(
    `${secret}&`,
    `${method}&${alibabaEncodeURIComponent('/')}&${alibabaEncodeURIComponent(canonicalQuery)}`,
  )

export class AliyunApi extends Context.Service<
  AliyunApi,
  {
    /** Invokes `action` and returns the decoded JSON body, still untyped. */
    call(
      action: string,
      parameters: Record<string, string>,
    ): Effect.Effect<Schema.Json, AliyunError>
  }
>()('ali_summary/AliyunApi') {}

/**
 * Either transport, seen from the outside: one service, the union of what the
 * two need, so a caller can pick between them at runtime.
 */
export type AliyunApiLayer = Layer.Layer<
  AliyunApi,
  never,
  | Credentials.Credentials
  | Crypto.Crypto
  | HttpClient.HttpClient
  | ChildProcessSpawner.ChildProcessSpawner
>

/** Signs the request locally and sends it straight to the service. */
export const layerHttp: AliyunApiLayer = Effect.gen(function* () {
  const credentials = yield* Credentials.Credentials
  const client = yield* HttpClient.HttpClient
  const crypto = yield* Crypto.Crypto

  const call = Effect.fn('AliyunApi.http')(
    function* (action: string, parameters: Record<string, string>) {
      const now = yield* DateTime.now
      // The service rejects sub-second precision in Timestamp.
      const timestamp = `${DateTime.toDateUtc(now).toISOString().slice(0, 19)}Z`
      // Replay protection: the service rejects a nonce it has seen before.
      const nonce = yield* Effect.mapError(
        crypto.randomUUIDv4,
        cause =>
          new AliyunError({
            message: 'Could not generate a signature nonce',
            cause,
          }),
      )

      const payload: Record<string, string> = {
        ...parameters,
        Action: action,
        Format: 'JSON',
        Version: bssOpenApi.version,
        RegionId: bssOpenApi.region,
        AccessKeyId: credentials.accessKeyId,
        // TODO: check if it has other simpler signature methods which could be
        // easily supported by effect's builting Crypto, without reimplementing
        // HMAC
        SignatureMethod: 'HMAC-SHA1',
        SignatureVersion: '1.0',
        SignatureNonce: nonce,
        Timestamp: timestamp,
      }

      const canonicalQuery = canonicalizeQuery(payload)

      const signature = yield* Effect.mapError(
        sign(
          Redacted.value(credentials.accessKeySecret),
          'GET',
          canonicalQuery,
        ),
        cause =>
          new AliyunError({ message: 'Could not sign the request', cause }),
      )

      const url = `https://${bssOpenApi.host}/?${canonicalQuery}&Signature=${alibabaEncodeURIComponent(signature)}`

      const response = yield* HttpClientRequest.get(url).pipe(
        client.execute,
        Effect.mapError(
          cause =>
            new AliyunError({
              message: `Request to ${bssOpenApi.host} failed`,
              cause,
            }),
        ),
      )

      const body = yield* Effect.mapError(
        response.json,
        cause =>
          new AliyunError({
            message: 'Could not read the response body',
            cause,
          }),
      )

      if (response.status >= 400)
        // We can't do anything about it, in the sense that we need to expose
        // the same interface from the CLI too, we cannot throw here, besides,
        // most of the time the API has message and status embedded directly
        // into the response
        yield* Effect.logError(`${action} failed with HTTP ${response.status}`)

      return body
    },
    Effect.provideService(Crypto.Crypto, crypto),
  )

  return AliyunApi.of({ call })
}).pipe(Layer.effect(AliyunApi))

const decodeJson = Schema.Json.pipe(Schema.fromJsonString, Schema.decodeEffect)

/**
 * Delegates to the `aliyun` binary. Credentials go through the environment
 * rather than argv, so they stay out of the process table.
 */
export const layerCli: AliyunApiLayer = Effect.gen(function* () {
  const credentials = yield* Credentials.Credentials
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

  const call = Effect.fn('AliyunApi.cli')(function* (
    action: string,
    parameters: Record<string, string>,
  ) {
    const args = [
      bssOpenApi.product,
      action,
      '--region',
      bssOpenApi.region,
      '--endpoint',
      bssOpenApi.host,
      ...Object.entries(parameters).flatMap(([key, value]) => [
        `--${key}`,
        value,
      ]),
    ]

    const output = yield* ChildProcess.make('aliyun', args, {
      env: {
        ALIBABA_CLOUD_ACCESS_KEY_ID: credentials.accessKeyId,
        ALIBABA_CLOUD_ACCESS_KEY_SECRET: Redacted.value(
          credentials.accessKeySecret,
        ),
      },
      extendEnv: true,
    }).pipe(
      spawner.string,
      Effect.mapError(
        cause =>
          new AliyunError({
            message: `\`aliyun ${bssOpenApi.product} ${action}\` failed`,
            cause,
          }),
      ),
    )

    return yield* Effect.mapError(
      decodeJson(output),
      cause =>
        new AliyunError({
          message: `Failed to parse JSON returned by aliyun CLI`,
          cause,
        }),
    )
  })

  return AliyunApi.of({ call })
}).pipe(Layer.effect(AliyunApi))
