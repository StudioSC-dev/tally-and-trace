export interface User {
  id: number
  email: string
  first_name: string
  last_name: string
  default_currency: string
  is_active: boolean
  is_verified: boolean
  onboarding_completed: boolean
  created_at: string
  updated_at?: string
  last_login?: string
}

export interface LoginRequest {
  email: string
  password: string
}

export interface RegisterRequest {
  email: string
  password: string
  first_name: string
  last_name: string
  default_currency: string
}

export interface TokenResponse {
  access_token: string
  /**
   * Present only for native clients (mobile) that have no cookie jar. Web receives
   * the refresh token as an httpOnly cookie instead and never reads this field.
   */
  refresh_token?: string
  token_type: string
  expires_in: number
}

export interface UpdateUserRequest {
  first_name?: string
  last_name?: string
  default_currency?: string
  is_active?: boolean
}
