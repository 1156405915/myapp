import type { MayiApi } from '../../shared/protocol'

declare global {
  interface Window {
    mayi: MayiApi
  }
}

export {}
