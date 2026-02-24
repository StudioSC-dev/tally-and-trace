import React, { createContext, useContext, useEffect, useState, ReactNode } from 'react'
import { useDispatch } from 'react-redux'
import { authApi, User } from '../store/authApi'
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
  logout: () => void
  updateUser: (userData: Partial<User>) => Promise<void>
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

interface AuthProviderProps {
  children: ReactNode
}

export const AuthProvider: React.FC<AuthProviderProps> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const dispatch = useDispatch<AppDispatch>()

  // Check for existing token on mount
  useEffect(() => {
    console.log('AuthContext: Checking authentication status...')
    const token = localStorage.getItem('access_token')
    const savedUser = localStorage.getItem('user')
    
    console.log('AuthContext: Token exists:', !!token, 'Saved user exists:', !!savedUser)
    
    if (token && savedUser) {
      try {
        setUser(JSON.parse(savedUser))
        console.log('AuthContext: Parsed saved user, verifying token...')
        // Verify token is still valid by fetching current user
        dispatch(authApi.endpoints.getCurrentUser.initiate())
          .unwrap()
          .then((userData: User) => {
            console.log('AuthContext: Token valid, user data:', userData)
            setUser(userData)
            localStorage.setItem('user', JSON.stringify(userData))
          })
          .catch((error) => {
            console.log('AuthContext: Token invalid, clearing data:', error)
            // Token is invalid, clear everything
            localStorage.removeItem('access_token')
            localStorage.removeItem('user')
            setUser(null)
          })
          .finally(() => {
            console.log('AuthContext: Auth check complete, setting loading false')
            setIsLoading(false)
          })
      } catch (error) {
        console.error('AuthContext: Error parsing saved user:', error)
        localStorage.removeItem('access_token')
        localStorage.removeItem('user')
        setUser(null)
        setIsLoading(false)
      }
    } else {
      console.log('AuthContext: No token or saved user, setting loading false')
      setIsLoading(false)
    }
  }, [dispatch])

  const login = async (email: string, password: string) => {
    try {
      await dispatch(authApi.endpoints.login.initiate({ email, password })).unwrap()
      // User data will be set by the onQueryStarted callback in authApi
      const userData = await dispatch(authApi.endpoints.getCurrentUser.initiate()).unwrap()
      setUser(userData)
    } catch (error) {
      console.error('Login failed:', error)
      throw error
    }
  }

  const register = async (userData: {
    email: string
    password: string
    first_name: string
    last_name: string
    default_currency: string
  }) => {
    try {
      await dispatch(authApi.endpoints.register.initiate(userData)).unwrap()
      // Registration successful - user needs to verify email before logging in
    } catch (error) {
      console.error('Registration failed:', error)
      throw error
    }
  }

  const logout = () => {
    dispatch(authApi.endpoints.logout.initiate())
    setUser(null)
  }

  const updateUser = async (userData: Partial<User>) => {
    try {
      const result = await dispatch(authApi.endpoints.updateUser.initiate(userData)).unwrap()
      setUser(result)
      localStorage.setItem('user', JSON.stringify(result))
    } catch (error) {
      console.error('Update user failed:', error)
      throw error
    }
  }

  const value: AuthContextType = {
    user,
    isAuthenticated: !!user,
    isLoading,
    login,
    register,
    logout,
    updateUser,
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext)
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}
