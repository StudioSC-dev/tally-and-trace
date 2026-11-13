import { configureStore } from '@reduxjs/toolkit'
import { setupListeners } from '@reduxjs/toolkit/query'
import { accountingApi } from './api'
import { authApi } from './authApi'
import { outboxListener, outboxReducer } from './outbox'

export const store = configureStore({
  reducer: {
    [accountingApi.reducerPath]: accountingApi.reducer,
    [authApi.reducerPath]: authApi.reducer,
    outbox: outboxReducer,
  },
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware().prepend(outboxListener.middleware).concat(accountingApi.middleware, authApi.middleware),
})

setupListeners(store.dispatch)

export type RootState = ReturnType<typeof store.getState>
export type AppDispatch = typeof store.dispatch
