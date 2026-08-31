/**
 * Alibaba Cloud access key resolution.
 *
 * Environment first, then the password store. The two `pass` lookups are
 * independent, so they run concurrently.
 */
import * as Config from 'effect/Config'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Redacted from 'effect/Redacted'
import * as Schema from 'effect/Schema'
import * as Str from 'effect/String'
import * as ChildProcess from 'effect/unstable/process/ChildProcess'
import * as ChildProcessSpawner from 'effect/unstable/process/ChildProcessSpawner'

export class CredentialsError extends Schema.TaggedError<CredentialsError>()(
  'CredentialsError',
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const ENV_KEY_ID = 'ALIBABA_CLOUD_ACCESS_KEY_ID'
const ENV_KEY_SECRET = 'ALIBABA_CLOUD_ACCESS_KEY_SECRET'

const PASS_KEY_ID = 'alibabacloud.com/vova/access_key_id'
const PASS_KEY_SECRET = 'alibabacloud.com/vova/access_key_secret'

/**
 * `pass show` prints the secret on the first line and may print arbitrary
 * metadata after it, so everything past the first newline is discarded.
 */
const passShow = Effect.fn('Credentials.passShow')(function* (entry: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

  const output = yield* spawner
    .string(ChildProcess.make('pass', ['show', entry]))
    .pipe(
      Effect.mapError(
        cause =>
          new CredentialsError({
            message: `Could not read "${entry}" from the password store`,
            cause,
          }),
      ),
    )

  const secret = Str.trim(output.split('\n')[0] ?? '')
  if (secret === '') {
    return yield* new CredentialsError({
      message: `Password store entry "${entry}" is empty`,
    })
  }
  return secret
})

export class Credentials extends Context.Service<
  Credentials,
  {
    readonly accessKeyId: string
    readonly accessKeySecret: Redacted.Redacted<string>
    readonly source: 'environment' | 'pass'
  }
>()('ali_summary/Credentials') {}

export const layer = Effect.gen(function* () {
  const keyId = yield* Config.string(ENV_KEY_ID).pipe(Config.option)
  const keySecret = yield* Config.redacted(ENV_KEY_SECRET).pipe(Config.option)

  if (Option.isSome(keyId) && Option.isSome(keySecret)) {
    yield* Effect.logDebug(
      `Using credentials from ${ENV_KEY_ID}/${ENV_KEY_SECRET}`,
    )
    return Credentials.of({
      accessKeyId: keyId.value,
      accessKeySecret: keySecret.value,
      source: 'environment',
    })
  }

  yield* Effect.logDebug(
    'Access key not in the environment, falling back to `pass`',
  )

  const [id, secret] = yield* Effect.all(
    [passShow(PASS_KEY_ID), passShow(PASS_KEY_SECRET)],
    { concurrency: 2 },
  )

  return Credentials.of({
    accessKeyId: id,
    accessKeySecret: Redacted.make(secret),
    source: 'pass',
  })
}).pipe(Layer.effect(Credentials))
