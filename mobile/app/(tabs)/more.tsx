import { useState } from 'react'
import {
  ScrollView,
  View,
  Text,
  TouchableOpacity,
  Alert,
  Modal,
  RefreshControl,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useAuth } from '../../src/contexts/AuthContext'
import {
  useGetBudgetEntriesQuery,
  useDeleteBudgetEntryMutation,
  useGetCategoriesQuery,
  useCreateCategoryMutation,
  useDeleteCategoryMutation,
  useGetWishlistItemsQuery,
  useCreateWishlistItemMutation,
  useDeleteWishlistItemMutation,
} from '../../src/store/api'
import type { BudgetEntry, Category, WishlistItem } from '../../src/store/api'
import { formatCurrency } from '@tally-trace/shared'
import type { CurrencyCode } from '@tally-trace/shared'
import { Card, Button, Input, SectionHeader, LoadingSpinner, EmptyState, Badge } from '../../src/components/ui'

// ─── Section Enum ─────────────────────────────────────────────────────────────

type Section = 'menu' | 'budget-entries' | 'categories' | 'wishlist' | 'profile'

// ─── Budget Entries Section ───────────────────────────────────────────────────

function BudgetEntriesSection({ currency }: { currency: CurrencyCode }) {
  const { data, isLoading, isFetching, refetch } = useGetBudgetEntriesQuery({ limit: 50 })
  const [deleteEntry] = useDeleteBudgetEntryMutation()
  const entries = data?.items ?? []

  if (isLoading) return <LoadingSpinner message="Loading…" />

  return (
    <ScrollView
      contentContainerStyle={{ padding: 16 }}
      refreshControl={<RefreshControl refreshing={isFetching} onRefresh={refetch} tintColor="#0ea5e9" />}
    >
      {entries.length === 0 ? (
        <EmptyState message="No recurring income/expenses yet." />
      ) : (
        entries.map((entry) => (
          <Card key={entry.id} className="mb-3">
            <View className="flex-row items-start justify-between">
              <View className="flex-1 mr-3">
                <Text className="text-white font-semibold">{entry.name}</Text>
                <Text className="text-slate-500 text-xs capitalize">
                  {entry.cadence} · {entry.entry_type}
                  {entry.is_autopay ? ' · Auto-pay' : ''}
                </Text>
                <Text className="text-slate-500 text-xs mt-0.5">
                  Next: {entry.next_occurrence.split('T')[0]}
                </Text>
              </View>
              <View className="items-end gap-1">
                <Text
                  className={`font-bold ${entry.entry_type === 'income' ? 'text-emerald-400' : 'text-red-400'}`}
                >
                  {formatCurrency(entry.amount, entry.currency as CurrencyCode)}
                </Text>
                <Badge
                  label={entry.entry_type}
                  color={entry.entry_type === 'income' ? 'green' : 'red'}
                />
              </View>
            </View>
            <TouchableOpacity
              onPress={() =>
                Alert.alert('Delete Entry', `Remove "${entry.name}"?`, [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'Delete', style: 'destructive', onPress: () => deleteEntry(entry.id) },
                ])
              }
              className="mt-3 py-1.5 rounded-lg bg-red-900/40 items-center"
            >
              <Text className="text-red-400 text-xs font-medium">🗑 Delete</Text>
            </TouchableOpacity>
          </Card>
        ))
      )}
    </ScrollView>
  )
}

// ─── Categories Section ───────────────────────────────────────────────────────

function CategoriesSection({ entityId }: { entityId: number }) {
  const { data: cats, isLoading, isFetching, refetch } = useGetCategoriesQuery({ is_active: true })
  const [createCategory] = useCreateCategoryMutation()
  const [deleteCategory] = useDeleteCategoryMutation()

  const [showForm, setShowForm] = useState(false)
  const [name, setName] = useState('')
  const [isExpense, setIsExpense] = useState(true)

  const handleCreate = async () => {
    if (!name.trim()) return Alert.alert('Error', 'Name is required.')
    try {
      await createCategory({ name: name.trim(), is_expense: isExpense, entity_id: entityId }).unwrap()
      setName('')
      setShowForm(false)
    } catch {
      Alert.alert('Error', 'Could not create category.')
    }
  }

  if (isLoading) return <LoadingSpinner message="Loading…" />

  return (
    <ScrollView
      contentContainerStyle={{ padding: 16 }}
      refreshControl={<RefreshControl refreshing={isFetching} onRefresh={refetch} tintColor="#0ea5e9" />}
    >
      {showForm && (
        <Card className="mb-4 gap-3">
          <Input
            label="Category Name"
            placeholder="e.g. Groceries"
            value={name}
            onChangeText={setName}
          />
          <View className="flex-row gap-2">
            {[{ label: '⬇️ Expense', value: true }, { label: '⬆️ Income', value: false }].map(({ label, value }) => (
              <TouchableOpacity
                key={String(value)}
                onPress={() => setIsExpense(value)}
                className={`flex-1 py-2 rounded-lg border items-center ${isExpense === value ? 'bg-sky-500 border-sky-500' : 'bg-slate-800 border-slate-700'}`}
              >
                <Text className={isExpense === value ? 'text-white font-semibold text-sm' : 'text-slate-300 text-sm'}>
                  {label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
          <View className="flex-row gap-2">
            <Button label="Cancel" variant="secondary" onPress={() => setShowForm(false)} className="flex-1" />
            <Button label="Create" onPress={handleCreate} className="flex-1" />
          </View>
        </Card>
      )}

      {!showForm && (
        <TouchableOpacity
          onPress={() => setShowForm(true)}
          className="bg-sky-500 py-2.5 rounded-xl items-center mb-4"
        >
          <Text className="text-white font-semibold">+ New Category</Text>
        </TouchableOpacity>
      )}

      {(!cats || cats.length === 0) ? (
        <EmptyState message="No categories yet." />
      ) : (
        cats.map((cat) => (
          <Card key={cat.id} className="mb-2">
            <View className="flex-row items-center justify-between">
              <View className="flex-row items-center gap-2">
                <Text>{cat.is_expense ? '⬇️' : '⬆️'}</Text>
                <Text className="text-white font-medium">{cat.name}</Text>
              </View>
              <TouchableOpacity
                onPress={() =>
                  Alert.alert('Delete', `Remove "${cat.name}"?`, [
                    { text: 'Cancel', style: 'cancel' },
                    { text: 'Delete', style: 'destructive', onPress: () => deleteCategory(cat.id) },
                  ])
                }
                className="px-3 py-1 rounded-lg bg-red-900/40"
              >
                <Text className="text-red-400 text-xs">Delete</Text>
              </TouchableOpacity>
            </View>
          </Card>
        ))
      )}
    </ScrollView>
  )
}

// ─── Wishlist Section ─────────────────────────────────────────────────────────

function WishlistSection({ currency, entityId }: { currency: CurrencyCode; entityId: number }) {
  const { data, isLoading, isFetching, refetch } = useGetWishlistItemsQuery()
  const [createItem] = useCreateWishlistItemMutation()
  const [deleteItem] = useDeleteWishlistItemMutation()

  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ name: '', estimated_cost: '', priority: 'medium' })
  const set = (k: keyof typeof form, v: string) => setForm((p) => ({ ...p, [k]: v }))

  const handleCreate = async () => {
    if (!form.name.trim() || !form.estimated_cost) {
      return Alert.alert('Error', 'Name and cost are required.')
    }
    try {
      await createItem({
        name: form.name.trim(),
        estimated_cost: parseFloat(form.estimated_cost),
        priority: form.priority as WishlistItem['priority'],
        currency,
        entity_id: entityId,
        is_achieved: false,
      }).unwrap()
      setForm({ name: '', estimated_cost: '', priority: 'medium' })
      setShowForm(false)
    } catch {
      Alert.alert('Error', 'Could not create wishlist item.')
    }
  }

  const items = data?.items ?? []
  if (isLoading) return <LoadingSpinner message="Loading…" />

  return (
    <ScrollView
      contentContainerStyle={{ padding: 16 }}
      refreshControl={<RefreshControl refreshing={isFetching} onRefresh={refetch} tintColor="#0ea5e9" />}
    >
      {showForm && (
        <Card className="mb-4 gap-3">
          <Input label="Item Name" placeholder="e.g. MacBook Pro" value={form.name} onChangeText={(v) => set('name', v)} />
          <Input label="Estimated Cost" placeholder="0.00" value={form.estimated_cost} onChangeText={(v) => set('estimated_cost', v)} keyboardType="decimal-pad" />
          <View className="gap-1">
            <Text className="text-slate-400 text-sm font-medium">Priority</Text>
            <View className="flex-row gap-2">
              {(['low', 'medium', 'high', 'critical'] as const).map((p) => (
                <TouchableOpacity
                  key={p}
                  onPress={() => set('priority', p)}
                  className={`flex-1 py-2 rounded-lg border items-center ${form.priority === p ? 'bg-sky-500 border-sky-500' : 'bg-slate-800 border-slate-700'}`}
                >
                  <Text className={`text-xs capitalize ${form.priority === p ? 'text-white font-semibold' : 'text-slate-300'}`}>{p}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
          <View className="flex-row gap-2">
            <Button label="Cancel" variant="secondary" onPress={() => setShowForm(false)} className="flex-1" />
            <Button label="Add" onPress={handleCreate} className="flex-1" />
          </View>
        </Card>
      )}

      {!showForm && (
        <TouchableOpacity onPress={() => setShowForm(true)} className="bg-sky-500 py-2.5 rounded-xl items-center mb-4">
          <Text className="text-white font-semibold">+ New Wish</Text>
        </TouchableOpacity>
      )}

      {items.length === 0 ? (
        <EmptyState message="Your wishlist is empty." />
      ) : (
        items.map((item) => (
          <Card key={item.id} className="mb-3">
            <View className="flex-row items-start justify-between">
              <View className="flex-1 mr-3">
                <Text className="text-white font-semibold">{item.name}</Text>
                <Text className="text-slate-500 text-xs capitalize">{item.priority} priority</Text>
              </View>
              <Text className="text-white font-bold">
                {formatCurrency(item.estimated_cost, item.currency as CurrencyCode)}
              </Text>
            </View>
            <View className="flex-row gap-2 mt-3">
              <Badge label={item.is_achieved ? '✓ Achieved' : 'Saving'} color={item.is_achieved ? 'green' : 'yellow'} />
              <TouchableOpacity
                onPress={() =>
                  Alert.alert('Delete', `Remove "${item.name}"?`, [
                    { text: 'Cancel', style: 'cancel' },
                    { text: 'Delete', style: 'destructive', onPress: () => deleteItem(item.id) },
                  ])
                }
                className="ml-auto px-3 py-1 rounded-lg bg-red-900/40"
              >
                <Text className="text-red-400 text-xs">Delete</Text>
              </TouchableOpacity>
            </View>
          </Card>
        ))
      )}
    </ScrollView>
  )
}

// ─── Profile Section ──────────────────────────────────────────────────────────

function ProfileSection() {
  const { user, logout } = useAuth()

  return (
    <ScrollView contentContainerStyle={{ padding: 16 }}>
      <Card className="mb-4">
        <View className="items-center py-4">
          <View className="w-16 h-16 rounded-full bg-sky-500 items-center justify-center mb-3">
            <Text className="text-white text-2xl font-bold">
              {user?.first_name?.[0] ?? '?'}
            </Text>
          </View>
          <Text className="text-white text-xl font-bold">
            {user?.first_name} {user?.last_name}
          </Text>
          <Text className="text-slate-400 mt-1">{user?.email}</Text>
          <Text className="text-slate-500 text-sm mt-1">
            Currency: {user?.default_currency}
          </Text>
        </View>
      </Card>

      <Button
        label="Sign Out"
        variant="destructive"
        onPress={() =>
          Alert.alert('Sign Out', 'Are you sure you want to sign out?', [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Sign Out', style: 'destructive', onPress: logout },
          ])
        }
      />
    </ScrollView>
  )
}

// ─── Main Screen ─────────────────────────────────────────────────────────────

const MENU_ITEMS = [
  { id: 'budget-entries' as Section, label: 'Recurring Income/Expenses', emoji: '🔁', subtitle: 'Manage recurring bills and income' },
  { id: 'categories' as Section, label: 'Categories', emoji: '🏷️', subtitle: 'Organize your transactions' },
  { id: 'wishlist' as Section, label: 'Wishlist', emoji: '✨', subtitle: 'Track items you want to buy' },
  { id: 'profile' as Section, label: 'Profile & Settings', emoji: '👤', subtitle: 'Account info and sign out' },
]

export default function MoreScreen() {
  const { user } = useAuth()
  const currency = (user?.default_currency as CurrencyCode) ?? 'PHP'
  const [section, setSection] = useState<Section>('menu')

  if (section !== 'menu') {
    return (
      <SafeAreaView className="flex-1 bg-slate-900">
        <View className="flex-row items-center px-4 pt-4 pb-2">
          <TouchableOpacity onPress={() => setSection('menu')} className="mr-3">
            <Text className="text-sky-400 text-base">← Back</Text>
          </TouchableOpacity>
          <Text className="text-white text-lg font-bold capitalize">
            {MENU_ITEMS.find((m) => m.id === section)?.label ?? section}
          </Text>
        </View>
        {section === 'budget-entries' && <BudgetEntriesSection currency={currency} />}
        {section === 'categories' && <CategoriesSection entityId={1} />}
        {section === 'wishlist' && <WishlistSection currency={currency} entityId={1} />}
        {section === 'profile' && <ProfileSection />}
      </SafeAreaView>
    )
  }

  return (
    <SafeAreaView className="flex-1 bg-slate-900">
      <ScrollView contentContainerStyle={{ padding: 16 }}>
        <Text className="text-white text-2xl font-bold mb-6">More</Text>

        <View className="gap-3">
          {MENU_ITEMS.map((item) => (
            <TouchableOpacity
              key={item.id}
              onPress={() => setSection(item.id)}
              className="flex-row items-center gap-4 bg-slate-800 rounded-2xl p-4"
            >
              <View className="w-12 h-12 bg-slate-700 rounded-xl items-center justify-center">
                <Text className="text-2xl">{item.emoji}</Text>
              </View>
              <View className="flex-1">
                <Text className="text-white font-semibold">{item.label}</Text>
                <Text className="text-slate-400 text-sm">{item.subtitle}</Text>
              </View>
              <Text className="text-slate-500 text-lg">›</Text>
            </TouchableOpacity>
          ))}
        </View>
      </ScrollView>
    </SafeAreaView>
  )
}
