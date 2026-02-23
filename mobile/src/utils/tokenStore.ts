import * as SecureStore from 'expo-secure-store'

const TOKEN_KEY = 'access_token'
const USER_KEY = 'user_data'

// In-memory cache so synchronous reads work after initial load
let _accessToken: string | null = null
let _userData: string | null = null

export const tokenStore = {
  /** Synchronous read – returns cached value (populated after `load()`) */
  getToken: (): string | null => _accessToken,

  /** Persist token to SecureStore and update in-memory cache */
  setToken: async (token: string): Promise<void> => {
    _accessToken = token
    await SecureStore.setItemAsync(TOKEN_KEY, token)
  },

  /** Remove token from SecureStore and clear cache */
  clearToken: async (): Promise<void> => {
    _accessToken = null
    await SecureStore.deleteItemAsync(TOKEN_KEY)
  },

  /** Persist user JSON to SecureStore */
  setUser: async (userJson: string): Promise<void> => {
    _userData = userJson
    await SecureStore.setItemAsync(USER_KEY, userJson)
  },

  /** Get cached user JSON */
  getUser: (): string | null => _userData,

  /** Remove user from SecureStore */
  clearUser: async (): Promise<void> => {
    _userData = null
    await SecureStore.deleteItemAsync(USER_KEY)
  },

  /**
   * Load persisted token & user into the in-memory cache.
   * Call this once on app startup before rendering routes.
   */
  load: async (): Promise<{ token: string | null; userJson: string | null }> => {
    _accessToken = await SecureStore.getItemAsync(TOKEN_KEY)
    _userData = await SecureStore.getItemAsync(USER_KEY)
    return { token: _accessToken, userJson: _userData }
  },

  /** Clear everything – used on logout */
  clearAll: async (): Promise<void> => {
    _accessToken = null
    _userData = null
    await SecureStore.deleteItemAsync(TOKEN_KEY)
    await SecureStore.deleteItemAsync(USER_KEY)
  },
}
