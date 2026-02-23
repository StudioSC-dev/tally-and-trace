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
  useGetAllocationsQuery,
  useGetAccountsQuery,
  useCreateAllocationMutation,
  useUpdateAllocationMutation,
  useDeleteAllocationMutation,
} from '../../src/store/api'
import type { Allocation, Account } from '../../src/store/api'
import { useAuth } from '../../src/contexts/AuthContext'
import { formatCurrency } from '@tally-trace/shared'
import type { CurrencyCode } from '@tally-trace/shared'
import { Card, Button, Input, LoadingSpinner, EmptyState, SectionHeader } from '../../src/components/ui'

// ─── Progress Bar ─────────────────────────────────────────────────────────────

function ProgressBar({ percent }: { percent: number }) {
  const clamped = Math.min(Math.max(percent, 0), 100)
  const color = clamped >= 100 ? 'bg-emerald-500' : clamped >= 50 ? 'bg-sky-500' : 'bg-yellow-500'
  return (
    <View className="h-2 bg-slate-700 rounded-full overflow-hidden">
      <View className={`h-full ${color} rounded-full`} style={{ width: `${clamped}%` }} />
    </View>
  )
}

// ─── Allocation Form Modal ────────────────────────────────────────────────────

function AllocationFormModal({
  visible,
  onClose,
  initial,
  accounts,
  entityId,
  defaultCurrency,
}: {
  visible: boolean
  onClose: () => void
  initial?: Partial<Allocation>
  accounts: Account[]
  entityId: number
  defaultCurrency: CurrencyCode
}) {
  const isEdit = !!initial?.id
  const [create, { isLoading: creating }] = useCreateAllocationMutation()
  const [update, { isLoading: updating }] = useUpdateAllocationMutation()

  const [form, setForm] = useState({
    name: initial?.name ?? '',
    allocation_type: initial?.allocation_type ?? 'savings',
    description: initial?.description ?? '',
    target_amount: String(initial?.target_amount ?? ''),
    current_amount: String(initial?.current_amount ?? 0),
    account_id: String(initial?.account_id ?? accounts[0]?.id ?? ''),
    currency: initial?.currency ?? defaultCurrency,
  })

  const set = (key: keyof typeof form, value: string) =>
    setForm((p) => ({ ...p, [key]: value }))

  const handleSubmit = async () => {
    if (!form.name.trim() || !form.account_id) {
      return Alert.alert('Error', 'Name and account are required.')
    }
    try {
      const payload: Partial<Allocation> = {
        name: form.name.trim(),
        allocation_type: form.allocation_type as Allocation['allocation_type'],
        description: form.description.trim() || undefined,
        target_amount: form.target_amount ? parseFloat(form.target_amount) : undefined,
        current_amount: parseFloat(form.current_amount) || 0,
        account_id: parseInt(form.account_id),
        currency: form.currency as CurrencyCode,
        entity_id: entityId,
      }
      if (isEdit && initial?.id) {
        await update({ id: initial.id, data: payload }).unwrap()
      } else {
        await create(payload).unwrap()
      }
      onClose()
    } catch {
      Alert.alert('Error', 'Could not save allocation.')
    }
  }

  const isSaving = creating || updating

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet">
      <View className="flex-1 bg-slate-900 px-6 pt-8">
        <View className="flex-row items-center justify-between mb-6">
          <Text className="text-white text-xl font-bold">
            {isEdit ? 'Edit Allocation' : 'New Allocation'}
          </Text>
          <TouchableOpacity onPress={onClose}>
            <Text className="text-sky-400 font-semibold">Cancel</Text>
          </TouchableOpacity>
        </View>

        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ gap: 16 }}>
          <Input
            label="Name"
            placeholder="e.g. Emergency Fund"
            value={form.name}
            onChangeText={(v) => set('name', v)}
          />

          {/* Type */}
          <View className="gap-2">
            <Text className="text-slate-400 text-sm font-medium">Type</Text>
            <View className="flex-row gap-2">
              {(['savings', 'budget', 'goal'] as const).map((t) => (
                <TouchableOpacity
                  key={t}
                  onPress={() => set('allocation_type', t)}
                  className={`flex-1 py-2 rounded-lg border items-center ${
                    form.allocation_type === t
                      ? 'bg-sky-500 border-sky-500'
                      : 'bg-slate-800 border-slate-700'
                  }`}
                >
                  <Text
                    className={
                      form.allocation_type === t ? 'text-white font-semibold text-sm' : 'text-slate-300 text-sm'
                    }
                  >
                    {t === 'savings' ? '🐷 Savings' : t === 'budget' ? '📊 Budget' : '🎯 Goal'}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          <Input
            label="Target Amount (optional)"
            placeholder="0.00"
            value={form.target_amount}
            onChangeText={(v) => set('target_amount', v)}
            keyboardType="decimal-pad"
          />

          <Input
            label="Current Amount"
            placeholder="0.00"
            value={form.current_amount}
            onChangeText={(v) => set('current_amount', v)}
            keyboardType="decimal-pad"
          />

          {/* Account */}
          <View className="gap-2">
            <Text className="text-slate-400 text-sm font-medium">Account</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View className="flex-row gap-2">
                {accounts.map((acc) => (
                  <TouchableOpacity
                    key={acc.id}
                    onPress={() => set('account_id', String(acc.id))}
                    className={`px-3 py-2 rounded-lg border ${
                      form.account_id === String(acc.id)
                        ? 'bg-sky-500 border-sky-500'
                        : 'bg-slate-800 border-slate-700'
                    }`}
                  >
                    <Text
                      className={
                        form.account_id === String(acc.id)
                          ? 'text-white font-semibold'
                          : 'text-slate-300'
                      }
                    >
                      {acc.name}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </ScrollView>
          </View>

          <Input
            label="Description (optional)"
            placeholder="Short description"
            value={form.description}
            onChangeText={(v) => set('description', v)}
          />

          <Button
            label={isEdit ? 'Save Changes' : 'Create'}
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

export default function AllocationsScreen() {
  const { user } = useAuth()
  const currency = (user?.default_currency as CurrencyCode) ?? 'PHP'

  const { data, isLoading, isFetching, refetch } = useGetAllocationsQuery({ is_active: true, limit: 100 })
  const { data: accData } = useGetAccountsQuery({ is_active: true, limit: 100 })
  const [deleteAllocation] = useDeleteAllocationMutation()

  const [modalVisible, setModalVisible] = useState(false)
  const [editing, setEditing] = useState<Allocation | undefined>()

  const allocations = data?.items ?? []
  const accounts = accData?.items ?? []

  const handleDelete = (alloc: Allocation) => {
    Alert.alert('Delete Allocation', `Remove "${alloc.name}"?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => deleteAllocation(alloc.id),
      },
    ])
  }

  if (isLoading) return <LoadingSpinner message="Loading allocations…" />

  const goals = allocations.filter((a) => a.allocation_type === 'goal')
  const savings = allocations.filter((a) => a.allocation_type === 'savings')
  const budgets = allocations.filter((a) => a.allocation_type === 'budget')

  const renderAllocation = (alloc: Allocation) => {
    const progress = alloc.target_amount
      ? (alloc.current_amount / alloc.target_amount) * 100
      : 0

    return (
      <Card key={alloc.id} className="mb-3">
        <View className="flex-row items-start justify-between mb-2">
          <View className="flex-1 mr-3">
            <Text className="text-white font-semibold">{alloc.name}</Text>
            {alloc.description && (
              <Text className="text-slate-500 text-xs mt-0.5">{alloc.description}</Text>
            )}
          </View>
          <Text className="text-white font-bold">
            {formatCurrency(alloc.current_amount, alloc.currency as CurrencyCode)}
          </Text>
        </View>

        {alloc.target_amount && (
          <>
            <ProgressBar percent={progress} />
            <View className="flex-row justify-between mt-1">
              <Text className="text-slate-500 text-xs">{Math.round(progress)}%</Text>
              <Text className="text-slate-500 text-xs">
                of {formatCurrency(alloc.target_amount, alloc.currency as CurrencyCode)}
              </Text>
            </View>
          </>
        )}

        <View className="flex-row gap-2 mt-3">
          <TouchableOpacity
            onPress={() => { setEditing(alloc); setModalVisible(true) }}
            className="flex-1 py-1.5 rounded-lg bg-slate-700 items-center"
          >
            <Text className="text-slate-200 text-xs font-medium">✏️ Edit</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => handleDelete(alloc)}
            className="flex-1 py-1.5 rounded-lg bg-red-900/40 items-center"
          >
            <Text className="text-red-400 text-xs font-medium">🗑 Delete</Text>
          </TouchableOpacity>
        </View>
      </Card>
    )
  }

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
          title="Allocations & Goals"
          action={
            <TouchableOpacity
              onPress={() => { setEditing(undefined); setModalVisible(true) }}
              className="bg-sky-500 px-3 py-1.5 rounded-lg"
            >
              <Text className="text-white font-semibold text-sm">+ Add</Text>
            </TouchableOpacity>
          }
        />

        {allocations.length === 0 ? (
          <EmptyState message="No allocations yet. Tap + Add to create one." />
        ) : (
          <>
            {goals.length > 0 && (
              <View className="mb-4">
                <Text className="text-slate-400 text-sm font-semibold mb-3">🎯 Goals</Text>
                {goals.map(renderAllocation)}
              </View>
            )}
            {savings.length > 0 && (
              <View className="mb-4">
                <Text className="text-slate-400 text-sm font-semibold mb-3">🐷 Savings</Text>
                {savings.map(renderAllocation)}
              </View>
            )}
            {budgets.length > 0 && (
              <View className="mb-4">
                <Text className="text-slate-400 text-sm font-semibold mb-3">📊 Budgets</Text>
                {budgets.map(renderAllocation)}
              </View>
            )}
          </>
        )}

        <View className="h-6" />
      </ScrollView>

      <AllocationFormModal
        visible={modalVisible}
        onClose={() => setModalVisible(false)}
        initial={editing}
        accounts={accounts}
        entityId={1}
        defaultCurrency={currency}
      />
    </SafeAreaView>
  )
}
