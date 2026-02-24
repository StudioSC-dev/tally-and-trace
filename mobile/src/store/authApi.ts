import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react'
import type { User, LoginRequest, RegisterRequest, TokenResponse, UpdateUserRequest } from '@tally-trace/shared'
import { tokenStore } from '../utils/tokenStore'
import Constants from 'expo-constants'
import { Platform } from 'react-native'

// Re-export for convenience
export type { User, LoginRequest, RegisterRequest, TokenResponse, UpdateUserRequest }

// Android emulator routes to the host machine via 10.0.2.2 (not localhost).
// iOS Simulator can use localhost directly.
const LOCAL_API_URL = Platform.OS === 'android'
  ? 'http://10.0.2.2:8000/api/v1'
  : 'http://localhost:8000/api/v1'

const API_BASE_URL =
  (Constants.expoConfig?.extra?.apiUrl as string | undefined) ??
  process.env.EXPO_PUBLIC_API_URL ??
  LOCAL_API_URL

const rawBaseQuery = fetchBaseQuery({
  baseUrl: API_BASE_URL,
  prepareHeaders: (headers) => {
    const token = tokenStore.getToken()
    if (token) {
      headers.set('authorization', `Bearer ${token}`)
    }
    return headers
  },
})

export const authApi = createApi({
  reducerPath: 'authApi',
  baseQuery: rawBaseQuery,
  tagTypes: ['User'],
  endpoints: (builder) => ({
    register: builder.mutation<User, RegisterRequest>({
      query: (userData) => ({
        url: 'auth/register',
        method: 'POST',
        body: userData,
      }),
    }),

    login: builder.mutation<TokenResponse, LoginRequest>({
      query: (credentials) => ({
        url: 'auth/login',
        method: 'POST',
        body: credentials,
      }),
      async onQueryStarted(_, { dispatch, queryFulfilled }) {
        try {
          const { data } = await queryFulfilled
          await tokenStore.setToken(data.access_token)
          dispatch(authApi.endpoints.getCurrentUser.initiate())
        } catch (error) {
          console.error('Login failed:', error)
        }
      },
    }),

    getCurrentUser: builder.query<User, void>({
      query: () => 'auth/me',
      providesTags: ['User'],
      async onQueryStarted(_, { queryFulfilled }) {
        try {
          const { data } = await queryFulfilled
          await tokenStore.setUser(JSON.stringify(data))
        } catch (error) {
          console.error('Failed to get current user:', error)
        }
      },
    }),

    updateUser: builder.mutation<User, UpdateUserRequest>({
      query: (userData) => ({
        url: 'auth/me',
        method: 'PUT',
        body: userData,
      }),
      invalidatesTags: ['User'],
    }),

    logout: builder.mutation<void, void>({
      query: () => ({ url: 'auth/logout', method: 'POST' }),
      async onQueryStarted(_, { dispatch }) {
        await tokenStore.clearAll()
        dispatch(authApi.util.resetApiState())
      },
    }),

    resendVerification: builder.mutation<{ message: string }, { email: string }>({
      query: (data) => ({
        url: 'auth/resend-verification',
        method: 'POST',
        body: data,
      }),
    }),
  }),
})

export const {
  useRegisterMutation,
  useLoginMutation,
  useGetCurrentUserQuery,
  useUpdateUserMutation,
  useLogoutMutation,
  useResendVerificationMutation,
} = authApi
