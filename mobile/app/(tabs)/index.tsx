import { ScrollView, View, Text, RefreshControl } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useGetDashboardSnapshotQuery } from '../../src/store/api'
import { useAuth } from '../../src/contexts/AuthContext'
import { formatCurrency } from '@tally-trace/shared'
import type { CurrencyCode } from '@tally-trace/shared'
import { formatRelativeDate, isLimitedEvent, upcomingItemAmount } from '@tally-trace/shared'
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
            {formatCurrency(snapshot?.balances.total ?? 0, currency)}
          </Text>
          <Text className="text-sky-300 text-xs mt-2">
            Across {snapshot?.balances.by_account.length ?? 0} account(s)
          </Text>
        </Card>

        {/* Quick Stats */}
        {snapshot?.monthly_summary && (
          <View className="flex-row gap-3">
            <Card className="flex-1">
              <Text className="text-slate-400 text-xs mb-1">Monthly income</Text>
              <AmountText
                amount={snapshot.monthly_summary.monthly_income}
                currency={currency}
                positive
                className="text-xl"
              />
            </Card>
            <Card className="flex-1">
              <Text className="text-slate-400 text-xs mb-1">Monthly expenses</Text>
              <AmountText
                amount={snapshot.monthly_summary.monthly_expenses}
                currency={currency}
                negative
                className="text-xl"
              />
            </Card>
          </View>
        )}

        {/* Account Balances */}
        {snapshot && snapshot.balances.by_account.length > 0 && (
          <View>
            <SectionHeader title="Accounts" />
            <Card className="gap-3">
              {snapshot.balances.by_account.map((acc, idx) => (
                <View key={acc.id}>
                  {idx > 0 && <View className="h-px bg-slate-700" />}
                  <View className="flex-row items-center justify-between py-1">
                    <View>
                      <Text className="text-white font-medium">{acc.name}</Text>
                      {acc.is_spending_wallet && (
                        <Text className="text-slate-500 text-xs">Spending wallet</Text>
                      )}
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

        {/* Upcoming Events */}
        {snapshot && snapshot.upcoming_this_month.length > 0 && (
          <View>
            <SectionHeader title="Upcoming Bills" />
            <Card className="gap-3">
              {snapshot.upcoming_this_month.slice(0, 5).map((event, idx) => {
                // Limited events (shared accounts) carry a neutral name; they list their
                // face amount, since a card charge billed later has a cash_delta of 0.
                const limited = isLimitedEvent(event)
                const full = isLimitedEvent(event) ? null : event
                const name = limited ? event.display_name : (full?.name ?? '')
                const { amount, direction } = upcomingItemAmount(event)
                const date = limited ? event.date : (full?.due_date ?? '')
                const isIncome = direction === 'in'
                const isExpense = direction === 'out'
                const kindLabel = limited ? event.kind.replace('_', ' ') : (full?.entry_type ?? '')
                return (
                <View key={idx}>
                  {idx > 0 && <View className="h-px bg-slate-700" />}
                  <View className="flex-row items-center justify-between py-1">
                    <View className="flex-1 mr-3">
                      <Text className="text-white font-medium" numberOfLines={1}>
                        {name}
                      </Text>
                      <Text className="text-slate-500 text-xs">{formatRelativeDate(date)}</Text>
                    </View>
                    <View className="items-end gap-1">
                      <AmountText
                        amount={amount}
                        currency={limited ? event.currency : currency}
                        negative={isExpense}
                        positive={isIncome}
                      />
                      <Badge
                        label={kindLabel}
                        color={isIncome ? 'green' : 'red'}
                      />
                    </View>
                  </View>
                </View>
                )
              })}
            </Card>
          </View>
        )}

        {/* Wishlist Summary */}
        {snapshot && snapshot.wishlist_next_up.length > 0 && (
          <View>
            <SectionHeader title="Wishlist" />
            <Card className="gap-3">
              {snapshot.wishlist_next_up.map((item, idx) => (
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
                        {formatCurrency(item.cost, currency)}
                      </Text>
                      <Badge label={`By ${item.affordable_by}`} color="yellow" />
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
