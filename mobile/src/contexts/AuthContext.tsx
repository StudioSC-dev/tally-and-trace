import React, { createContext, useContext, useEffect, useState, ReactNode } from 'react'
import { useDispatch } from 'react-redux'
import type { User } from '@tally-trace/shared'
import { authApi } from '../store/authApi'
import { tokenStore } from '../utils/tokenStore'
import type { AppDispatch } from '../store'

interface AuthContextType {
  user: User | null
  isAuthenticated: boolean
  isLoading: boolean
  login: (email: string, password: string) => Promise<void>
  register: (userData: {
    email: string
    password: string
    first_name: string
    last_name: string
    default_currency: string
  }) => Promise<void>
  logout: () => Promise<void>
  updateUser: (userData: Partial<User>) => Promise<void>
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const dispatch = useDispatch<AppDispatch>()

  // On mount: restore token and user from SecureStore
  useEffect(() => {
    const restore = async () => {
      try {
        const { token, userJson } = await tokenStore.load()
        if (token && userJson) {
          setUser(JSON.parse(userJson))
          // Verify token is still valid
          dispatch(authApi.endpoints.getCurrentUser.initiate())
            .unwrap()
            .then((userData: User) => {
              setUser(userData)
              tokenStore.setUser(JSON.stringify(userData))
            })
            .catch(async () => {
              await tokenStore.clearAll()
              setUser(null)
            })
            .finally(() => setIsLoading(false))
        } else {
          setIsLoading(false)
        }
      } catch {
        await tokenStore.clearAll()
        setUser(null)
        setIsLoading(false)
      }
    }
    restore()
  }, [dispatch])

  const login = async (email: string, password: string) => {
    await dispatch(authApi.endpoints.login.initiate({ email, password })).unwrap()
    const userData = await dispatch(authApi.endpoints.getCurrentUser.initiate()).unwrap()
    setUser(userData)
  }

  const register = async (userData: {
    email: string
    password: string
    first_name: string
    last_name: string
    default_currency: string
  }) => {
    await dispatch(authApi.endpoints.register.initiate(userData)).unwrap()
    // Registration successful - user needs to verify email before logging in
  }

  const logout = async () => {
    try {
      await dispatch(authApi.endpoints.logout.initiate()).unwrap()
    } finally {
      await tokenStore.clearAll()
      setUser(null)
    }
  }

  const updateUser = async (userData: Partial<User>) => {
    const result = await dispatch(authApi.endpoints.updateUser.initiate(userData)).unwrap()
    setUser(result)
    await tokenStore.setUser(JSON.stringify(result))
  }

  return (
    <AuthContext.Provider
      value={{ user, isAuthenticated: !!user, isLoading, login, register, logout, updateUser }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = (): AuthContextType => {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
