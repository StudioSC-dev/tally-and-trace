import '../global.css'

import { useEffect, useState } from 'react'
import { Stack, useRouter, useSegments } from 'expo-router'
import { Provider } from 'react-redux'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { StatusBar } from 'expo-status-bar'
import { store } from '../src/store'
import { AuthProvider, useAuth } from '../src/contexts/AuthContext'
import { tokenStore } from '../src/utils/tokenStore'
import { View } from 'react-native'
import { LoadingSpinner } from '../src/components/ui'

// ─── Inner navigator: redirects based on auth state ──────────────────────────

function RootNavigator() {
  const { isAuthenticated, isLoading } = useAuth()
  const router = useRouter()
  const segments = useSegments()

  useEffect(() => {
    if (isLoading) return

    const inAuthGroup = segments[0] === '(auth)'

    if (!isAuthenticated && !inAuthGroup) {
      router.replace('/(auth)/login')
    } else if (isAuthenticated && inAuthGroup) {
      router.replace('/(tabs)')
    }
  }, [isAuthenticated, isLoading, segments, router])

  if (isLoading) {
    return (
      <View className="flex-1 bg-slate-900">
        <LoadingSpinner message="Loading…" />
      </View>
    )
  }

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(auth)" />
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="+not-found" />
    </Stack>
  )
}

// ─── Root Layout ─────────────────────────────────────────────────────────────

export default function RootLayout() {
  const [storeReady, setStoreReady] = useState(false)

  // Pre-load the token from SecureStore before rendering anything
  useEffect(() => {
    tokenStore.load().finally(() => setStoreReady(true))
  }, [])

  if (!storeReady) return null

  return (
    <Provider store={store}>
      <SafeAreaProvider>
        <AuthProvider>
          <StatusBar style="light" />
          <RootNavigator />
        </AuthProvider>
      </SafeAreaProvider>
    </Provider>
  )
}
