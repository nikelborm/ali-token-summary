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
import * as Redacted from 'effect/Redacted'
import * as Schema from 'effect/Schema'
import * as EString from 'effect/String'
import * as ChildProcess from 'effect/unstable/process/ChildProcess'
import * as ChildProcessSpawner from 'effect/unstable/process/ChildProcessSpawner'

export class Credentials extends Context.Service<
  Credentials,
  {
    readonly accessKeyId: string
    readonly accessKeySecret: Redacted.Redacted<string>
  }
>()('ali_summary/Credentials') {}

const ENV_KEY_ID = 'ALIBABA_CLOUD_ACCESS_KEY_ID'
const ENV_KEY_SECRET = 'ALIBABA_CLOUD_ACCESS_KEY_SECRET'

const PASS_KEY_ID = 'alibabacloud.com/vova/access_key_id'
const PASS_KEY_SECRET = 'alibabacloud.com/vova/access_key_secret'

// TODO: just implement a ConfigStore interface on top of pass instead of manual
// fallback, but first need to verify that there's a way to properly compose
// many stores, because this is essentially what I have

const getParsedEnvOrFallbackToPassStore = (conf: {
  envName: string
  passEntryPath: string
}) =>
  Config.schema(Schema.String, conf.envName).pipe(
    Config.option,
    Effect.flatMapEager(Effect.fromOption),
    Effect.catchTag('NoSuchElementError', () => passShow(conf.passEntryPath)),
    Effect.catchTag(
      'ConfigError',
      CredentialsError.passthroughCause(
        `Failed to parse environment config entry`,
      ),
    ),
    Effect.flatMapEager(Schema.decodeEffect(NonEmptyTrimmedString)),
    Effect.catchTag(
      'SchemaError',
      CredentialsError.passthroughCause(
        `Failed to parse decrypted password-store entry`,
      ),
    ),
  )

export const layer = Effect.all(
  {
    accessKeyId: getParsedEnvOrFallbackToPassStore({
      envName: ENV_KEY_ID,
      passEntryPath: PASS_KEY_ID,
    }),
    accessKeySecret: Effect.map(
      getParsedEnvOrFallbackToPassStore({
        envName: ENV_KEY_SECRET,
        passEntryPath: PASS_KEY_SECRET,
      }),
      Redacted.make,
    ),
  },
  { concurrency: 2 },
).pipe(Layer.effect(Credentials))

const passShow = (entry: string) =>
  ChildProcessSpawner.ChildProcessSpawner.use(spawner =>
    // inherit, so that gpg agent can show the password prompt
    spawner.string(
      ChildProcess.make({
        stderr: 'inherit',
        stdin: 'inherit',
      })`pass show ${entry}`,
    ),
  ).pipe(
    // The expectation is that nothing else will be present in the file except
    // one line we're looking for
    Effect.map(EString.trim),
    Effect.mapError(
      CredentialsError.passthroughCause(
        `Could not read "${entry}" from the password store`,
      ),
    ),
  )

export class CredentialsError extends Schema.TaggedError<CredentialsError>()(
  'CredentialsError',
  {
    message: Schema.String,
    cause: Schema.optional(Schema.ErrorInstance()),
  },
) {
  static passthroughCause = (message: string) => (cause: Error) =>
    new CredentialsError({ message, cause })
}

const NonEmptyTrimmedString = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isTrimmed(),
)
