import { ScrollView, View, Text, RefreshControl } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useGetDashboardSnapshotQuery } from '../../src/store/api'
import { useAuth } from '../../src/contexts/AuthContext'
import { formatCurrency } from '@tally-trace/shared'
import type { CurrencyCode } from '@tally-trace/shared'
import { formatRelativeDate } from '@tally-trace/shared'
import { Card, SectionHeader, LoadingSpinner, Badge, AmountText } from '../../src/components/ui'

export default function HomeScreen() {
  const { user } = useAuth()
  const { data, isLoading, isFetching, refetch } = useGetDashboardSnapshotQuery()

  const currency = (user?.default_currency as CurrencyCode) ?? 'PHP'

  if (isLoading) return <LoadingSpinner message="Loading dashboard…" />

  const snapshot = data

  return (
    <SafeAreaView className="flex-1 bg-slate-900">
      <ScrollView
        className="flex-1"
        contentContainerStyle={{ padding: 16, gap: 20 }}
        refreshControl={
          <RefreshControl refreshing={isFetching} onRefresh={refetch} tintColor="#0ea5e9" />
        }
      >
        {/* Header */}
        <View className="mb-2">
          <Text className="text-slate-400 text-sm">Welcome back,</Text>
          <Text className="text-white text-2xl font-bold">
            {user?.first_name ?? 'User'} 👋
          </Text>
        </View>

        {/* Total Balance */}
        <Card className="bg-gradient-to-br from-sky-600 to-sky-800">
          <Text className="text-sky-200 text-sm font-medium mb-1">Total Balance</Text>
          <Text className="text-white text-4xl font-bold">
            {formatCurrency(snapshot?.total_balance ?? 0, currency)}
          </Text>
          <Text className="text-sky-300 text-xs mt-2">
            Across {snapshot?.account_balances?.length ?? 0} account(s)
          </Text>
        </Card>

        {/* Quick Stats */}
        {snapshot?.net_disposable_income && (
          <View className="flex-row gap-3">
            <Card className="flex-1">
              <Text className="text-slate-400 text-xs mb-1">Income (MTD)</Text>
              <AmountText
                amount={snapshot.net_disposable_income.total_income}
                currency={currency}
                positive
                className="text-xl"
              />
            </Card>
            <Card className="flex-1">
              <Text className="text-slate-400 text-xs mb-1">Expenses (MTD)</Text>
              <AmountText
                amount={snapshot.net_disposable_income.total_expenses}
                currency={currency}
                negative
                className="text-xl"
              />
            </Card>
          </View>
        )}

        {/* Account Balances */}
        {snapshot?.account_balances && snapshot.account_balances.length > 0 && (
          <View>
            <SectionHeader title="Accounts" />
            <Card className="gap-3">
              {snapshot.account_balances.map((acc, idx) => (
                <View key={acc.id}>
                  {idx > 0 && <View className="h-px bg-slate-700" />}
                  <View className="flex-row items-center justify-between py-1">
                    <View>
                      <Text className="text-white font-medium">{acc.name}</Text>
                      <Text className="text-slate-500 text-xs capitalize">
                        {acc.type.replace('_', ' ')}
                      </Text>
                    </View>
                    <Text className="text-white font-semibold">
                      {formatCurrency(acc.balance, acc.currency as CurrencyCode)}
                    </Text>
                  </View>
                </View>
              ))}
            </Card>
          </View>
        )}

        {/* Recent Transactions */}
        {snapshot?.recent_transactions && snapshot.recent_transactions.length > 0 && (
          <View>
            <SectionHeader title="Recent Transactions" />
            <Card className="gap-3">
              {snapshot.recent_transactions.map((tx, idx) => (
                <View key={tx.id}>
                  {idx > 0 && <View className="h-px bg-slate-700" />}
                  <View className="flex-row items-center justify-between py-1">
                    <View className="flex-1 mr-3">
                      <Text className="text-white font-medium" numberOfLines={1}>
                        {tx.description ?? '(no description)'}
                      </Text>
                      <Text className="text-slate-500 text-xs">
                        {formatRelativeDate(tx.date)} · {tx.account_name}
                      </Text>
                    </View>
                    <AmountText
                      amount={tx.amount}
                      currency={tx.currency}
                      positive={tx.type === 'credit'}
                      negative={tx.type === 'debit'}
                    />
                  </View>
                </View>
              ))}
            </Card>
          </View>
        )}

        {/* Upcoming Events */}
        {snapshot?.upcoming_events && snapshot.upcoming_events.length > 0 && (
          <View>
            <SectionHeader title="Upcoming Bills" />
            <Card className="gap-3">
              {snapshot.upcoming_events.slice(0, 5).map((event, idx) => (
                <View key={idx}>
                  {idx > 0 && <View className="h-px bg-slate-700" />}
                  <View className="flex-row items-center justify-between py-1">
                    <View className="flex-1 mr-3">
                      <Text className="text-white font-medium" numberOfLines={1}>
                        {event.name}
                      </Text>
                      <Text className="text-slate-500 text-xs">
                        {formatRelativeDate(event.date)}
                        {event.is_autopay ? ' · Auto-pay' : ''}
                      </Text>
                    </View>
                    <View className="items-end gap-1">
                      <AmountText
                        amount={event.amount}
                        currency={event.currency}
                        negative={event.entry_type === 'expense'}
                        positive={event.entry_type === 'income'}
                      />
                      <Badge
                        label={event.entry_type}
                        color={event.entry_type === 'income' ? 'green' : 'red'}
                      />
                    </View>
                  </View>
                </View>
              ))}
            </Card>
          </View>
        )}

        {/* Wishlist Summary */}
        {snapshot?.wishlist_summary && snapshot.wishlist_summary.length > 0 && (
          <View>
            <SectionHeader title="Wishlist" />
            <Card className="gap-3">
              {snapshot.wishlist_summary.map((item, idx) => (
                <View key={item.id}>
                  {idx > 0 && <View className="h-px bg-slate-700" />}
                  <View className="flex-row items-center justify-between py-1">
                    <View className="flex-1 mr-3">
                      <Text className="text-white font-medium" numberOfLines={1}>
                        {item.name}
                      </Text>
                      <Text className="text-slate-500 text-xs capitalize">{item.priority}</Text>
                    </View>
                    <View className="items-end gap-1">
                      <Text className="text-white font-semibold">
                        {formatCurrency(item.estimated_cost, item.currency as CurrencyCode)}
                      </Text>
                      <Badge
                        label={item.is_ready ? 'Ready!' : 'Saving'}
                        color={item.is_ready ? 'green' : 'yellow'}
                      />
                    </View>
                  </View>
                </View>
              ))}
            </Card>
          </View>
        )}

        <View className="h-4" />
      </ScrollView>
    </SafeAreaView>
  )
}
