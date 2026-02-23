import { View, Text } from 'react-native'
import { Link } from 'expo-router'

export default function NotFoundScreen() {
  return (
    <View className="flex-1 bg-slate-900 items-center justify-center p-6">
      <Text className="text-6xl mb-4">🔍</Text>
      <Text className="text-white text-xl font-bold mb-2">Page not found</Text>
      <Text className="text-slate-400 text-center mb-8">
        The screen you're looking for doesn't exist.
      </Text>
      <Link href="/(tabs)" className="text-sky-400 text-base underline">
        Go to home
      </Link>
    </View>
  )
}
