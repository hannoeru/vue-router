import { isSameParamValue } from '../../../param-equality'
import type { MatcherQueryParamsValue } from '../matcher-pattern'
import type { ParamParserWithGetSet } from './types'
import type { StandardSchemaV1 } from './standard-schema-types'

function defineBuiltinParser<T>(
  get: (value: string) => T | undefined,
  set: (value: T) => string | undefined
): ParamParserWithGetSet<T | T[] | null | undefined, MatcherQueryParamsValue> {
  return {
    get(value) {
      if (value == null) return value as null | undefined
      if (!Array.isArray(value)) return get(value)
      const result: T[] = []
      for (const item of value) {
        if (item == null) continue
        const parsed = get(item)
        if (parsed === undefined) return undefined
        result.push(parsed)
      }
      return result
    },
    set(value) {
      if (value == null) return value as null | undefined
      if (!Array.isArray(value)) return set(value)
      const result: string[] = []
      for (const item of value) {
        const serialized = set(item)
        if (serialized === undefined) return undefined
        result.push(serialized)
      }
      return result
    },
    eq: isSameParamValue,
  }
}

const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i
const INTEGER = /^[+-]?\d+$/

export const PARAM_PARSER_FLOAT = defineBuiltinParser<number>(
  value =>
    DECIMAL.test(value) && Number.isFinite(Number(value))
      ? Number(value)
      : undefined,
  value => (Number.isFinite(value) ? String(value) : undefined)
)

export const PARAM_PARSER_INDEX = defineBuiltinParser<number>(
  value =>
    INTEGER.test(value) &&
    Number.isSafeInteger(Number(value)) &&
    Number(value) >= 1
      ? Number(value) - 1
      : undefined,
  value =>
    Number.isSafeInteger(value) && value >= 0 && Number.isSafeInteger(value + 1)
      ? String(value + 1)
      : undefined
)

export const PARAM_PARSER_HEX = defineBuiltinParser<number>(
  value =>
    /^(?:0x)?[\da-f]+$/i.test(value) &&
    Number.isSafeInteger(parseInt(value, 16))
      ? parseInt(value, 16)
      : undefined,
  value =>
    Number.isSafeInteger(value) && value >= 0 ? value.toString(16) : undefined
)

function parseDate(value: string): Date | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined
  const date = new Date(value)
  return Number.isFinite(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
    ? date
    : undefined
}

export const PARAM_PARSER_DATE = defineBuiltinParser<Date>(parseDate, value =>
  Number.isFinite(value.getTime())
    ? value.toISOString().slice(0, 10)
    : undefined
)

export const PARAM_PARSER_DATETIME = defineBuiltinParser<Date>(
  value => {
    if (
      !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(
        value
      ) ||
      !parseDate(value.slice(0, 10))
    )
      return undefined
    const date = new Date(value)
    return Number.isFinite(date.getTime()) ? date : undefined
  },
  value => (Number.isFinite(value.getTime()) ? value.toISOString() : undefined)
)

export const PARAM_PARSER_TIMESTAMP = defineBuiltinParser<Date>(
  value => {
    if (!INTEGER.test(value)) return undefined
    const date = new Date(Number(value))
    return Number.isFinite(date.getTime()) ? date : undefined
  },
  value =>
    Number.isFinite(value.getTime()) ? String(value.getTime()) : undefined
)

export function defineEnumParser<const T extends string | number>(
  values: readonly T[]
) {
  return defineBuiltinParser<T>(
    value => values.find(item => String(item) === value),
    value => (values.includes(value) ? String(value) : undefined)
  )
}

export function defineArrayParser<T>(
  parser: {
    get: (value: string) => T | T[] | null | undefined
    set: (value: NoInfer<T>) => MatcherQueryParamsValue
    eq?: (a: NoInfer<T>, b: NoInfer<T>) => boolean
  },
  separator = ','
): ParamParserWithGetSet<T[] | undefined, MatcherQueryParamsValue> {
  if (!separator) throw new TypeError('Array separator must not be empty')
  return {
    get(value) {
      if (typeof value !== 'string') return undefined
      if (value === '') return []
      const result: T[] = []
      try {
        for (const item of value.split(separator)) {
          const parsed = parser.get(item)
          if (parsed == null || Array.isArray(parsed)) return undefined
          result.push(parsed)
        }
      } catch {
        return undefined
      }
      return result
    },
    set(value) {
      if (!value) return undefined
      const result: string[] = []
      for (const item of value) {
        const serialized = parser.set(item)
        if (
          typeof serialized !== 'string' ||
          serialized.includes(separator) ||
          (serialized === '' && value.length === 1)
        )
          return undefined
        result.push(serialized)
      }
      return result.join(separator)
    },
    eq: (a, b) =>
      a === b ||
      (!!a &&
        !!b &&
        a.length === b.length &&
        a.every((value, i) => (parser.eq || isSameParamValue)(value, b[i]!))),
  }
}

export function defineJsonParser<T = unknown>(
  validate?:
    | ((value: unknown) => T | null | undefined)
    | StandardSchemaV1<unknown, T>
): ParamParserWithGetSet<T | null | undefined, MatcherQueryParamsValue> {
  return {
    get(value) {
      if (typeof value !== 'string') return undefined
      try {
        const parsed: unknown = JSON.parse(value)
        if (!validate) return parsed as T
        if (typeof validate === 'function') return validate(parsed) ?? undefined
        const result = validate['~standard'].validate(parsed)
        if (result instanceof Promise)
          throw new TypeError(
            'async validation is not supported for param parsers'
          )
        return result.issues ? undefined : result.value
      } catch {
        return undefined
      }
    },
    set(value) {
      if (value === undefined) return undefined
      try {
        return JSON.stringify(value)
      } catch {
        return undefined
      }
    },
    eq: isSameParamValue,
  }
}

export const PARAM_PARSER_JSON = defineJsonParser()
