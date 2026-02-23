import { useState } from 'react'
import {
  View,
  Text,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  TouchableOpacity,
} from 'react-native'
import { Link } from 'expo-router'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useAuth } from '../../src/contexts/AuthContext'
import { Button, Input } from '../../src/components/ui'

export default function LoginScreen() {
  const { login } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleLogin = async () => {
    if (!email.trim() || !password.trim()) {
      setError('Please fill in all fields.')
      return
    }
    setError('')
    setLoading(true)
    try {
      await login(email.trim(), password)
    } catch {
      setError('Invalid email or password. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <SafeAreaView className="flex-1 bg-slate-900">
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        className="flex-1"
      >
        <ScrollView
          contentContainerStyle={{ flexGrow: 1 }}
          keyboardShouldPersistTaps="handled"
        >
          <View className="flex-1 px-6 pt-16 pb-8 justify-center">
            {/* Logo / Branding */}
            <View className="items-center mb-10">
              <View className="bg-sky-500 w-16 h-16 rounded-2xl items-center justify-center mb-4">
                <Text className="text-white text-3xl font-bold">T</Text>
              </View>
              <Text className="text-white text-3xl font-bold">Tally & Trace</Text>
              <Text className="text-slate-400 mt-1">Sign in to your account</Text>
            </View>

            {/* Form */}
            <View className="gap-4">
              <Input
                label="Email"
                placeholder="you@example.com"
                value={email}
                onChangeText={setEmail}
                keyboardType="email-address"
                autoCapitalize="none"
                autoComplete="email"
              />
              <Input
                label="Password"
                placeholder="••••••••"
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                autoComplete="password"
              />

              {error ? (
                <Text className="text-red-400 text-sm text-center">{error}</Text>
              ) : null}

              <Button
                label="Sign In"
                onPress={handleLogin}
                loading={loading}
                className="mt-2"
              />
            </View>

            {/* Register link */}
            <View className="flex-row justify-center mt-8">
              <Text className="text-slate-400">Don't have an account? </Text>
              <Link href="/(auth)/register" asChild>
                <TouchableOpacity>
                  <Text className="text-sky-400 font-semibold">Sign up</Text>
                </TouchableOpacity>
              </Link>
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}
