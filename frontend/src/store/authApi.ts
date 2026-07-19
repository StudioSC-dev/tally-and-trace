import { createApi } from '@reduxjs/toolkit/query/react'
import { baseQueryWithReauth } from './baseQuery'

// Re-export auth types from shared so existing imports continue to work
export type {
  User,
  LoginRequest,
  RegisterRequest,
  TokenResponse,
  UpdateUserRequest,
} from '@tally-trace/shared'

import type { User, LoginRequest, RegisterRequest, TokenResponse, UpdateUserRequest } from '@tally-trace/shared'

// ─── Auth API ─────────────────────────────────────────────────────────────────

export const authApi = createApi({
  reducerPath: 'authApi',
  baseQuery: baseQueryWithReauth,
  tagTypes: ['User'],
  endpoints: (builder) => ({
    // Register new user
    register: builder.mutation<User, RegisterRequest>({
      query: (userData) => ({
        url: 'auth/register',
        method: 'POST',
        body: userData,
      }),
    }),

    // Login user
    login: builder.mutation<TokenResponse, LoginRequest>({
      query: (credentials) => ({
        url: 'auth/login',
        method: 'POST',
        body: credentials,
      }),
      async onQueryStarted(_, { dispatch, queryFulfilled }) {
        try {
          const { data } = await queryFulfilled
          localStorage.setItem('access_token', data.access_token)
          // The refresh token is NOT stored in JS — it arrives as an httpOnly cookie
          // the browser holds and sends automatically. data.refresh_token is present
          // only for native clients and is deliberately ignored here.
          // Fetch user data after successful login
          dispatch(authApi.endpoints.getCurrentUser.initiate())
        } catch (error) {
          console.error('Login failed:', error)
        }
      },
    }),

    // Get current user
    getCurrentUser: builder.query<User, void>({
      query: () => 'auth/me',
      providesTags: ['User'],
      async onQueryStarted(_, { queryFulfilled }) {
        try {
          const { data } = await queryFulfilled
          localStorage.setItem('user', JSON.stringify(data))
        } catch (error) {
          console.error('Failed to get current user:', error)
        }
      },
    }),

    // Update current user
    updateUser: builder.mutation<User, UpdateUserRequest>({
      query: (userData) => ({
        url: 'auth/me',
        method: 'PUT',
        body: userData,
      }),
      invalidatesTags: ['User'],
    }),

    // Logout user
    logout: builder.mutation<void, void>({
      query: () => ({
        url: 'auth/logout',
        method: 'POST',
        // No body: the server reads the refresh token from the cookie and clears it.
        body: {},
      }),
      async onQueryStarted(_, { dispatch }) {
        localStorage.removeItem('access_token')
        localStorage.removeItem('refresh_token') // legacy key cleanup
        localStorage.removeItem('user')
        localStorage.removeItem('active_entity_id')
        // Clear all cached data
        dispatch(authApi.util.resetApiState())
      },
    }),

    // Resend verification email
    resendVerification: builder.mutation<{ message: string }, { email: string }>({
      query: (data) => ({
        url: 'auth/resend-verification',
        method: 'POST',
        body: data,
      }),
    }),

    // Verify email
    verifyEmail: builder.mutation<{ message: string }, { token: string }>({
      query: (data) => ({
        url: 'auth/verify-email',
        method: 'POST',
        body: data,
      }),
    }),

    // Complete onboarding
    completeOnboarding: builder.mutation<User, void>({
      query: () => ({
        url: 'auth/complete-onboarding',
        method: 'PATCH',
      }),
      invalidatesTags: ['User'],
      async onQueryStarted(_, { dispatch, queryFulfilled }) {
        try {
          const { data } = await queryFulfilled
          localStorage.setItem('user', JSON.stringify(data))
          // Refetch user to update state
          dispatch(authApi.endpoints.getCurrentUser.initiate())
        } catch (error) {
          console.error('Failed to complete onboarding:', error)
        }
      },
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
  useVerifyEmailMutation,
  useCompleteOnboardingMutation,
} = authApi
