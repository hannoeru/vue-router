import { dequal } from 'dequal/lite'

export function isSameParamValue(a: unknown, b: unknown): boolean {
  try {
    return dequal(a, b)
  } catch (error) {
    if (error instanceof RangeError) return false
    throw error
  }
}
