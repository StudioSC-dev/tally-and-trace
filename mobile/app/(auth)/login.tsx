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
import { useResendVerificationMutation } from '../../src/store/authApi'

export default function LoginScreen() {
  const { login } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [resendMessage, setResendMessage] = useState('')
  const [resendLoading, setResendLoading] = useState(false)
  const [resendVerification] = useResendVerificationMutation()

  const handleLogin = async () => {
    if (!email.trim() || !password.trim()) {
      setError('Please fill in all fields.')
      return
    }
    setError('')
    setResendMessage('')
    setLoading(true)
    try {
      await login(email.trim(), password)
    } catch (err: unknown) {
      let errorMessage = 'Invalid email or password. Please try again.'
      
      if (err && typeof err === 'object' && 'data' in err) {
        const errorData = (err as { data: { detail?: string } }).data
        const detail = errorData?.detail
        if (detail && typeof detail === 'string') {
          errorMessage = detail
        }
      }
      
      setError(errorMessage)
    } finally {
      setLoading(false)
    }
  }

  const handleResendVerification = async () => {
    if (!email.trim()) {
      setResendMessage('Please enter your email address first.')
      return
    }
    
    setResendLoading(true)
    setResendMessage('')
    try {
      const result = await resendVerification({ email: email.trim() }).unwrap()
      setResendMessage(result.message || 'Verification email sent! Please check your inbox.')
      setError('') // Clear error message
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'data' in err) {
        const errorData = (err as { data: { detail?: string } }).data
        const detail = errorData?.detail
        setResendMessage(detail || 'Failed to send verification email. Please try again.')
      } else {
        setResendMessage('Failed to send verification email. Please try again.')
      }
    } finally {
      setResendLoading(false)
    }
  }

  const isEmailNotVerified = error === 'Email not verified'

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
                <View className="bg-red-500/10 border border-red-500/20 rounded-lg p-3">
                  <Text className="text-red-400 text-sm text-center mb-2">{error}</Text>
                  {isEmailNotVerified && (
                    <TouchableOpacity
                      onPress={handleResendVerification}
                      disabled={resendLoading}
                      className="mt-2"
                    >
                      <Text className="text-sky-400 text-sm text-center underline disabled:opacity-50">
                        {resendLoading ? 'Sending...' : 'Resend verification email'}
                      </Text>
                    </TouchableOpacity>
                  )}
                </View>
              ) : null}

              {resendMessage && !isEmailNotVerified && (
                <View className={`rounded-lg p-3 border ${
                  resendMessage.includes('sent') || resendMessage.includes('already verified')
                    ? 'bg-emerald-500/10 border-emerald-500/20'
                    : 'bg-yellow-500/10 border-yellow-500/20'
                }`}>
                  <Text className={`text-sm text-center ${
                    resendMessage.includes('sent') || resendMessage.includes('already verified')
                      ? 'text-emerald-400'
                      : 'text-yellow-400'
                  }`}>
                    {resendMessage}
                  </Text>
                </View>
              )}

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
