import { useState } from 'react'
import {
  View,
  Text,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  TouchableOpacity,
} from 'react-native'
import { Link, useRouter } from 'expo-router'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useAuth } from '../../src/contexts/AuthContext'
import { Button, Input } from '../../src/components/ui'
import { SUPPORTED_CURRENCIES } from '@tally-trace/shared'

export default function RegisterScreen() {
  const { register } = useAuth()
  const router = useRouter()
  const [form, setForm] = useState({
    first_name: '',
    last_name: '',
    email: '',
    password: '',
    confirm_password: '',
    default_currency: 'PHP',
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)
  
  // Password validation
  const passwordRequirements = {
    minLength: form.password.length >= 8,
    hasUpperCase: /[A-Z]/.test(form.password),
    hasLowerCase: /[a-z]/.test(form.password),
    hasNumber: /\d/.test(form.password),
    hasSpecialChar: /[!@#$%^&*()._+\-=]/.test(form.password),
  }
  
  const isPasswordValid = Object.values(passwordRequirements).every(Boolean)

  const update = (key: keyof typeof form, value: string) =>
    setForm((prev) => ({ ...prev, [key]: value }))

  const handleRegister = async () => {
    if (!form.first_name || !form.last_name || !form.email || !form.password) {
      setError('Please fill in all required fields.')
      return
    }
    if (!isPasswordValid) {
      setError('Password does not meet all requirements. Please check the requirements below.')
      return
    }
    if (form.password !== form.confirm_password) {
      setError('Passwords do not match.')
      return
    }
    setError('')
    setSuccess(false)
    setLoading(true)
    try {
      await register({
        first_name: form.first_name.trim(),
        last_name: form.last_name.trim(),
        email: form.email.trim(),
        password: form.password,
        default_currency: form.default_currency,
      })
      setSuccess(true)
      // Navigate to login after a short delay
      setTimeout(() => {
        router.push('/(auth)/login')
      }, 2000)
    } catch (err: unknown) {
      let errorMessage = 'Registration failed. Please try again.'
      
      if (err && typeof err === 'object' && 'data' in err) {
        const errorData = (err as { data: { detail?: string | Array<{ msg: string }> } }).data
        const detail = errorData?.detail
        
        if (detail) {
          // Handle Pydantic validation errors (array of error objects)
          if (Array.isArray(detail)) {
            errorMessage = detail.map((error: { msg: string }) => error.msg).join('; ')
          } 
          // Handle simple string error
          else if (typeof detail === 'string') {
            errorMessage = detail
          }
        }
      }
      
      setError(errorMessage)
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
          contentContainerStyle={{ flexGrow: 1, paddingBottom: 40 }}
          keyboardShouldPersistTaps="handled"
        >
          <View className="px-6 pt-12 pb-8">
            {/* Branding */}
            <View className="items-center mb-8">
              <View className="bg-sky-500 w-14 h-14 rounded-2xl items-center justify-center mb-3">
                <Text className="text-white text-2xl font-bold">T</Text>
              </View>
              <Text className="text-white text-2xl font-bold">Create Account</Text>
              <Text className="text-slate-400 mt-1 text-sm">
                Join Tally & Trace for free
              </Text>
            </View>

            {/* Form */}
            <View className="gap-4">
              <View className="flex-row gap-3">
                <View className="flex-1">
                  <Input
                    label="First Name"
                    placeholder="Jane"
                    value={form.first_name}
                    onChangeText={(v) => update('first_name', v)}
                    autoCapitalize="words"
                  />
                </View>
                <View className="flex-1">
                  <Input
                    label="Last Name"
                    placeholder="Doe"
                    value={form.last_name}
                    onChangeText={(v) => update('last_name', v)}
                    autoCapitalize="words"
                  />
                </View>
              </View>

              <Input
                label="Email"
                placeholder="you@example.com"
                value={form.email}
                onChangeText={(v) => update('email', v)}
                keyboardType="email-address"
                autoCapitalize="none"
                autoComplete="email"
              />

              <View>
                <View className="flex-row items-center justify-between mb-1">
                  <Text className="text-slate-400 text-sm font-medium">Password</Text>
                  <TouchableOpacity
                    onPress={() => setShowPassword(!showPassword)}
                    className="px-2 py-1"
                  >
                    <Text className="text-sky-400 text-xs">
                      {showPassword ? 'Hide' : 'Show'}
                    </Text>
                  </TouchableOpacity>
                </View>
                <Input
                  placeholder="Enter a strong password"
                  value={form.password}
                  onChangeText={(v) => update('password', v)}
                  secureTextEntry={!showPassword}
                />
                {form.password ? (
                  <View className="mt-2 gap-1">
                    <Text className="text-slate-400 text-xs font-medium">Password requirements:</Text>
                    <View className="gap-0.5">
                      <Text className={`text-xs ${passwordRequirements.minLength ? 'text-emerald-400' : 'text-slate-500'}`}>
                        {passwordRequirements.minLength ? '✓' : '○'} At least 8 characters
                      </Text>
                      <Text className={`text-xs ${passwordRequirements.hasUpperCase ? 'text-emerald-400' : 'text-slate-500'}`}>
                        {passwordRequirements.hasUpperCase ? '✓' : '○'} One uppercase letter
                      </Text>
                      <Text className={`text-xs ${passwordRequirements.hasLowerCase ? 'text-emerald-400' : 'text-slate-500'}`}>
                        {passwordRequirements.hasLowerCase ? '✓' : '○'} One lowercase letter
                      </Text>
                      <Text className={`text-xs ${passwordRequirements.hasNumber ? 'text-emerald-400' : 'text-slate-500'}`}>
                        {passwordRequirements.hasNumber ? '✓' : '○'} One number
                      </Text>
                      <Text className={`text-xs ${passwordRequirements.hasSpecialChar ? 'text-emerald-400' : 'text-slate-500'}`}>
                        {passwordRequirements.hasSpecialChar ? '✓' : '○'} One special character (!@#$%^&*().-_+=)
                      </Text>
                    </View>
                  </View>
                ) : null}
              </View>

              <View>
                <View className="flex-row items-center justify-between mb-1">
                  <Text className="text-slate-400 text-sm font-medium">Confirm Password</Text>
                  <TouchableOpacity
                    onPress={() => setShowConfirmPassword(!showConfirmPassword)}
                    className="px-2 py-1"
                  >
                    <Text className="text-sky-400 text-xs">
                      {showConfirmPassword ? 'Hide' : 'Show'}
                    </Text>
                  </TouchableOpacity>
                </View>
                <Input
                  placeholder="Repeat password"
                  value={form.confirm_password}
                  onChangeText={(v) => update('confirm_password', v)}
                  secureTextEntry={!showConfirmPassword}
                />
                {form.confirm_password && form.password !== form.confirm_password && (
                  <Text className="mt-1 text-xs text-red-400">Passwords do not match</Text>
                )}
              </View>

              {/* Currency Picker */}
              <View className="gap-1">
                <Text className="text-slate-400 text-sm font-medium">
                  Default Currency
                </Text>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  className="-mx-1"
                >
                  <View className="flex-row gap-2 px-1">
                    {SUPPORTED_CURRENCIES.map((c) => (
                      <TouchableOpacity
                        key={c}
                        onPress={() => update('default_currency', c)}
                        className={`px-3 py-2 rounded-lg border ${
                          form.default_currency === c
                            ? 'bg-sky-500 border-sky-500'
                            : 'bg-slate-800 border-slate-700'
                        }`}
                      >
                        <Text
                          className={
                            form.default_currency === c
                              ? 'text-white font-semibold'
                              : 'text-slate-300'
                          }
                        >
                          {c}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </ScrollView>
              </View>

              {success ? (
                <View className="bg-emerald-500/10 border border-emerald-500/20 rounded-lg p-3">
                  <Text className="text-emerald-400 text-sm text-center">
                    Registration successful! Please check your email to verify your account before logging in.
                  </Text>
                </View>
              ) : error ? (
                <Text className="text-red-400 text-sm text-center">{error}</Text>
              ) : null}

              <Button
                label="Create Account"
                onPress={handleRegister}
                loading={loading}
                disabled={success}
                className="mt-2"
              />
            </View>

            {/* Login link */}
            <View className="flex-row justify-center mt-6">
              <Text className="text-slate-400">Already have an account? </Text>
              <Link href="/(auth)/login" asChild>
                <TouchableOpacity>
                  <Text className="text-sky-400 font-semibold">Sign in</Text>
                </TouchableOpacity>
              </Link>
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}
