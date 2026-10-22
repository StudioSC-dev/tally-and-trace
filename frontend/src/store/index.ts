import { configureStore } from '@reduxjs/toolkit'
import { setupListeners } from '@reduxjs/toolkit/query'
import { accountingApi } from './api'
import { authApi } from './authApi'
import { busyMiddleware } from './busy'

export const store = configureStore({
  reducer: {
    [accountingApi.reducerPath]: accountingApi.reducer,
    [authApi.reducerPath]: authApi.reducer,
  },
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware().concat(busyMiddleware, accountingApi.middleware, authApi.middleware),
})

setupListeners(store.dispatch)

export type RootState = ReturnType<typeof store.getState>
export type AppDispatch = typeof store.dispatch
