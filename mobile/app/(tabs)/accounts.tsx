import { useState } from 'react'
import {
  ScrollView,
  View,
  Text,
  TouchableOpacity,
  RefreshControl,
  Modal,
  Alert,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import {
  useGetAccountsQuery,
  useCreateAccountMutation,
  useUpdateAccountMutation,
  useDeleteAccountMutation,
} from '../../src/store/api'
import type { Account } from '../../src/store/api'
import { useAuth } from '../../src/contexts/AuthContext'
import { formatCurrency } from '@tally-trace/shared'
import type { CurrencyCode } from '@tally-trace/shared'
import {
  Card,
  Button,
  Input,
  LoadingSpinner,
  EmptyState,
  SectionHeader,
  Badge,
} from '../../src/components/ui'

// ─── Account Type Config ─────────────────────────────────────────────────────

const ACCOUNT_TYPES = [
  { value: 'cash', label: 'Cash', emoji: '💵' },
  { value: 'e_wallet', label: 'E-Wallet', emoji: '📱' },
  { value: 'savings', label: 'Savings', emoji: '🐷' },
  { value: 'checking', label: 'Checking', emoji: '🏦' },
  { value: 'credit', label: 'Credit', emoji: '💳' },
] as const

function accountEmoji(type: string): string {
  return ACCOUNT_TYPES.find((t) => t.value === type)?.emoji ?? '🏦'
}

// ─── Account Form Modal ───────────────────────────────────────────────────────

interface AccountFormProps {
  visible: boolean
  onClose: () => void
  initial?: Partial<Account>
  entityId: number
  defaultCurrency: CurrencyCode
}

function AccountFormModal({ visible, onClose, initial, entityId, defaultCurrency }: AccountFormProps) {
  const [createAccount, { isLoading: creating }] = useCreateAccountMutation()
  const [updateAccount, { isLoading: updating }] = useUpdateAccountMutation()

  const isEdit = !!initial?.id
  const [form, setForm] = useState({
    name: initial?.name ?? '',
    account_type: initial?.account_type ?? 'savings',
    description: initial?.description ?? '',
    balance: String(initial?.balance ?? 0),
    currency: initial?.currency ?? defaultCurrency,
  })

  const update = (key: keyof typeof form, value: string) =>
    setForm((p) => ({ ...p, [key]: value }))

  const handleSubmit = async () => {
    if (!form.name.trim()) return Alert.alert('Error', 'Account name is required.')
    try {
      const payload = {
        name: form.name.trim(),
        account_type: form.account_type as Account['account_type'],
        description: form.description.trim() || undefined,
        balance: parseFloat(form.balance) || 0,
        currency: form.currency as CurrencyCode,
        entity_id: entityId,
      }
      if (isEdit && initial?.id) {
        await updateAccount({ id: initial.id, data: payload }).unwrap()
      } else {
        await createAccount(payload).unwrap()
      }
      onClose()
    } catch {
      Alert.alert('Error', 'Could not save account. Please try again.')
    }
  }

  const isSaving = creating || updating

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet">
      <View className="flex-1 bg-slate-900 px-6 pt-8">
        <View className="flex-row items-center justify-between mb-6">
          <Text className="text-white text-xl font-bold">
            {isEdit ? 'Edit Account' : 'New Account'}
          </Text>
          <TouchableOpacity onPress={onClose}>
            <Text className="text-sky-400 text-base font-semibold">Cancel</Text>
          </TouchableOpacity>
        </View>

        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ gap: 16 }}>
          <Input
            label="Account Name"
            placeholder="e.g. BDO Savings"
            value={form.name}
            onChangeText={(v) => update('name', v)}
          />

          {/* Account Type */}
          <View className="gap-2">
            <Text className="text-slate-400 text-sm font-medium">Account Type</Text>
            <View className="flex-row flex-wrap gap-2">
              {ACCOUNT_TYPES.map(({ value, label, emoji }) => (
                <TouchableOpacity
                  key={value}
                  onPress={() => update('account_type', value)}
                  className={`flex-row items-center gap-1 px-3 py-2 rounded-lg border ${
                    form.account_type === value
                      ? 'bg-sky-500 border-sky-500'
                      : 'bg-slate-800 border-slate-700'
                  }`}
                >
                  <Text>{emoji}</Text>
                  <Text
                    className={
                      form.account_type === value ? 'text-white font-semibold' : 'text-slate-300'
                    }
                  >
                    {label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          <Input
            label="Balance"
            placeholder="0.00"
            value={form.balance}
            onChangeText={(v) => update('balance', v)}
            keyboardType="decimal-pad"
          />

          <Input
            label="Description (optional)"
            placeholder="Short description"
            value={form.description}
            onChangeText={(v) => update('description', v)}
          />

          <Button
            label={isEdit ? 'Save Changes' : 'Create Account'}
            onPress={handleSubmit}
            loading={isSaving}
            className="mt-4"
          />
        </ScrollView>
      </View>
    </Modal>
  )
}

// ─── Main Screen ─────────────────────────────────────────────────────────────

export default function AccountsScreen() {
  const { user } = useAuth()
  const currency = (user?.default_currency as CurrencyCode) ?? 'PHP'
  const { data, isLoading, isFetching, refetch } = useGetAccountsQuery({ is_active: true, limit: 100 })
  const [deleteAccount] = useDeleteAccountMutation()

  const [modalVisible, setModalVisible] = useState(false)
  const [editing, setEditing] = useState<Account | undefined>()

  const accounts = data?.items ?? []

  const handleDelete = (acc: Account) => {
    Alert.alert('Delete Account', `Remove "${acc.name}"?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => deleteAccount(acc.id),
      },
    ])
  }

  const openEdit = (acc: Account) => {
    setEditing(acc)
    setModalVisible(true)
  }

  const openNew = () => {
    setEditing(undefined)
    setModalVisible(true)
  }

  if (isLoading) return <LoadingSpinner message="Loading accounts…" />

  return (
    <SafeAreaView className="flex-1 bg-slate-900">
      <ScrollView
        className="flex-1"
        contentContainerStyle={{ padding: 16 }}
        refreshControl={
          <RefreshControl refreshing={isFetching} onRefresh={refetch} tintColor="#0ea5e9" />
        }
      >
        <SectionHeader
          title="Accounts"
          action={
            <TouchableOpacity
              onPress={openNew}
              className="bg-sky-500 px-3 py-1.5 rounded-lg"
            >
              <Text className="text-white font-semibold text-sm">+ Add</Text>
            </TouchableOpacity>
          }
        />

        {/* Summary */}
        <Card className="mb-4">
          <Text className="text-slate-400 text-xs mb-1">Total Balance</Text>
          <Text className="text-white text-3xl font-bold">
            {formatCurrency(
              accounts.reduce((s, a) => s + a.balance, 0),
              currency
            )}
          </Text>
          <Text className="text-slate-500 text-xs mt-1">{accounts.length} active account(s)</Text>
        </Card>

        {accounts.length === 0 ? (
          <EmptyState message="No accounts yet. Tap + Add to create one." />
        ) : (
          <View className="gap-3">
            {accounts.map((acc) => (
              <Card key={acc.id}>
                <View className="flex-row items-start justify-between">
                  <View className="flex-row items-center gap-3 flex-1">
                    <Text className="text-2xl">{accountEmoji(acc.account_type)}</Text>
                    <View className="flex-1">
                      <Text className="text-white font-semibold text-base">{acc.name}</Text>
                      <Text className="text-slate-400 text-xs capitalize">
                        {acc.account_type.replace('_', ' ')} · {acc.currency}
                      </Text>
                    </View>
                  </View>
                  <Text className="text-white font-bold text-lg">
                    {formatCurrency(acc.balance, acc.currency as CurrencyCode)}
                  </Text>
                </View>

                {acc.description && (
                  <Text className="text-slate-500 text-xs mt-2">{acc.description}</Text>
                )}

                <View className="flex-row gap-2 mt-3">
                  <TouchableOpacity
                    onPress={() => openEdit(acc)}
                    className="flex-1 py-2 rounded-lg bg-slate-700 items-center"
                  >
                    <Text className="text-slate-200 text-sm font-medium">✏️ Edit</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => handleDelete(acc)}
                    className="flex-1 py-2 rounded-lg bg-red-900/40 items-center"
                  >
                    <Text className="text-red-400 text-sm font-medium">🗑 Delete</Text>
                  </TouchableOpacity>
                </View>
              </Card>
            ))}
          </View>
        )}

        <View className="h-6" />
      </ScrollView>

      <AccountFormModal
        visible={modalVisible}
        onClose={() => setModalVisible(false)}
        initial={editing}
        entityId={1} // TODO: use active entity from context
        defaultCurrency={currency}
      />
    </SafeAreaView>
  )
}
