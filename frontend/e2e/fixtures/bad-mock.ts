import type { TokenResponse } from '@tally-trace/shared'
import { apiRoute } from '../support/mockApi'

// Deliberate type error: access_token must be a string. Excluded from tsconfig.e2e.json and
// compiled only by the `support › e2e typecheck rejects invalid mock types` test.
export const badLogin = apiRoute<TokenResponse>('POST', '/auth/login', {
  access_token: 12345,
  token_type: 'bearer',
  expires_in: 3600,
})
