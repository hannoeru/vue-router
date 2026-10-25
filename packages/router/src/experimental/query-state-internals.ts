export const QUERY_STATE_SCROLL: unique symbol = Symbol()

export interface QueryStateNavigation {
  [QUERY_STATE_SCROLL]?: boolean
}
