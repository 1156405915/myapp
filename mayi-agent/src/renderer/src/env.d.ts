import type { MayiApi } from '../../preload'

declare global {
  interface Window {
    mayi?: MayiApi
  }
}

export {}
