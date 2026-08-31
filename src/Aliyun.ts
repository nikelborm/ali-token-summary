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
import {
  Context,
  Crypto,
  DateTime,
  Effect,
  Layer,
  Redacted,
  Schema,
} from 'effect'
import { HttpClient, HttpClientRequest } from 'effect/unstable/http'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'

import { Credentials } from './Credentials.ts'

export class AliyunError extends Schema.TaggedError<AliyunError>()(
  'AliyunError',
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
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

/**
 * Alibaba's canonicalisation treats only `A-Za-z0-9-_.~` as unreserved, which
 * is a slightly smaller set than `encodeURIComponent` leaves alone.
 */
export const percentEncode = (value: string): string =>
  encodeURIComponent(value)
    .replace(/!/g, '%21')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\*/g, '%2A')

export const canonicalQuery = (parameters: Record<string, string>): string =>
  Object.keys(parameters)
    .sort()
    .map(key => `${percentEncode(key)}=${percentEncode(parameters[key]!)}`)
    .join('&')

const hmacSha1Base64 = (key: string, message: string): string => {
  const hasher = new Bun.CryptoHasher('sha1', key)
  hasher.update(message)
  return hasher.digest('base64')
}

/** Signature Version 1.0: sign `METHOD&/&<canonical query>` with `secret&`. */
export const signature = (
  secret: string,
  method: string,
  parameters: Record<string, string>,
): string =>
  hmacSha1Base64(
    `${secret}&`,
    `${method}&${percentEncode('/')}&${percentEncode(canonicalQuery(parameters))}`,
  )

export class AliyunApi extends Context.Service<
  AliyunApi,
  {
    /** Invokes `action` and returns the decoded JSON body, still untyped. */
    call(
      action: string,
      parameters: Record<string, string>,
    ): Effect.Effect<unknown, AliyunError>
  }
>()('ali_summary/AliyunApi') {}

/**
 * Either transport, seen from the outside: one service, the union of what the
 * two need, so a caller can pick between them at runtime.
 */
export type AliyunApiLayer = Layer.Layer<
  AliyunApi,
  never,
  | Credentials
  | Crypto.Crypto
  | HttpClient.HttpClient
  | ChildProcessSpawner.ChildProcessSpawner
>

const parseJson = (action: string, body: string) =>
  Effect.try({
    try: () => JSON.parse(body) as unknown,
    catch: cause =>
      new AliyunError({
        message: `${action} returned a body that is not JSON`,
        cause,
      }),
  })

/** Signs the request locally and sends it straight to the service. */
export const layerHttp = Effect.gen(function* () {
  const credentials = yield* Credentials
  const client = yield* HttpClient.HttpClient
  const crypto = yield* Crypto.Crypto

  const call = Effect.fn('AliyunApi.http')(function* (
    action: string,
    parameters: Record<string, string>,
  ) {
    const now = yield* DateTime.now
    // The service rejects sub-second precision in Timestamp.
    const timestamp = `${DateTime.toDateUtc(now).toISOString().slice(0, 19)}Z`
    // Replay protection: the service rejects a nonce it has seen before.
    const nonce = yield* crypto.randomUUIDv4.pipe(
      Effect.mapError(
        cause =>
          new AliyunError({
            message: 'Could not generate a signature nonce',
            cause,
          }),
      ),
    )

    const signed: Record<string, string> = {
      ...parameters,
      Action: action,
      Format: 'JSON',
      Version: bssOpenApi.version,
      RegionId: bssOpenApi.region,
      AccessKeyId: credentials.accessKeyId,
      SignatureMethod: 'HMAC-SHA1',
      SignatureVersion: '1.0',
      SignatureNonce: nonce,
      Timestamp: timestamp,
    }

    const query = canonicalQuery(signed)
    const sig = signature(
      Redacted.value(credentials.accessKeySecret),
      'GET',
      signed,
    )
    const url = `https://${bssOpenApi.host}/?${query}&Signature=${percentEncode(sig)}`

    const response = yield* client.execute(HttpClientRequest.get(url)).pipe(
      Effect.mapError(
        cause =>
          new AliyunError({
            message: `Request to ${bssOpenApi.host} failed`,
            cause,
          }),
      ),
    )

    const body = yield* response.text.pipe(
      Effect.mapError(
        cause =>
          new AliyunError({
            message: 'Could not read the response body',
            cause,
          }),
      ),
    )

    if (response.status >= 400) {
      // Alibaba returns a JSON error envelope; surfacing it verbatim is
      // far more useful than the status code alone.
      return yield* new AliyunError({
        message: `${action} failed with HTTP ${response.status}: ${body}`,
      })
    }

    return yield* parseJson(action, body)
  })

  return AliyunApi.of({ call })
}).pipe(Layer.effect(AliyunApi))

/**
 * Delegates to the `aliyun` binary. Credentials go through the environment
 * rather than argv, so they stay out of the process table.
 */
export const layerCli = Effect.gen(function* () {
  const credentials = yield* Credentials
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

    return yield* parseJson(action, output)
  })

  return AliyunApi.of({ call })
}).pipe(Layer.effect(AliyunApi))
