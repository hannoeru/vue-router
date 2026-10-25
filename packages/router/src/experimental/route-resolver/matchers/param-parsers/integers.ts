import type { ParamParser } from './types'

const PARAM_INTEGER_SINGLE = {
  get: (value: string | null) => {
    const num = Number(value)
    if (value && Number.isSafeInteger(num)) {
      return num
    }
    return undefined
  },
  set: (value: number) => String(value),
} satisfies ParamParser<number | undefined, string | null, number>

const PARAM_INTEGER_REPEATABLE = {
  get: (value: (string | null)[]) => {
    const parsed = value
      .filter((v): v is string => v != null)
      .map(PARAM_INTEGER_SINGLE.get)
    return parsed.every(v => v !== undefined) ? parsed : undefined
  },
  set: (value: number[]) => value.map(PARAM_INTEGER_SINGLE.set),
} satisfies ParamParser<number[] | undefined, (string | null)[], number[]>

/**
 * Native Param parser for integers.
 *
 * @internal
 */
export const PARAM_PARSER_INT = {
  get: value =>
    Array.isArray(value)
      ? PARAM_INTEGER_REPEATABLE.get(value)
      : value != null
        ? PARAM_INTEGER_SINGLE.get(value)
        : null,
  set: value =>
    Array.isArray(value)
      ? PARAM_INTEGER_REPEATABLE.set(value)
      : value != null
        ? PARAM_INTEGER_SINGLE.set(value)
        : null,
} satisfies ParamParser<
  number | number[] | null | undefined,
  string | (string | null)[] | null | undefined,
  number | number[] | null | undefined
>
