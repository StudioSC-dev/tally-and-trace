import { useState } from 'react'
import {
  FlatList,
  View,
  Text,
  TouchableOpacity,
  RefreshControl,
  Modal,
  Alert,
  ScrollView,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import {
  useGetTransactionsQuery,
  useGetAccountsQuery,
  useGetCategoriesQuery,
  useCreateTransactionMutation,
  useUpdateTransactionMutation,
  useDeleteTransactionMutation,
} from '../../src/store/api'
import type { Transaction, Account, Category } from '../../src/store/api'
import { useAuth } from '../../src/contexts/AuthContext'
import { formatCurrency, formatRelativeDate } from '@tally-trace/shared'
import type { CurrencyCode } from '@tally-trace/shared'
import { Card, Button, Input, LoadingSpinner, EmptyState, Badge, SectionHeader } from '../../src/components/ui'

// ─── Transaction Item ─────────────────────────────────────────────────────────

function TransactionItem({
  tx,
  accounts,
  categories,
  onEdit,
  onDelete,
}: {
  tx: Transaction
  accounts: Account[]
  categories: Category[]
  onEdit: (tx: Transaction) => void
  onDelete: (tx: Transaction) => void
}) {
  const account = accounts.find((a) => a.id === tx.account_id)
  const category = categories.find((c) => c.id === tx.category_id)
  const isDebit = tx.transaction_type === 'debit'
  const isCredit = tx.transaction_type === 'credit'

  return (
    <TouchableOpacity onLongPress={() => onEdit(tx)}>
      <Card className="mb-3">
        <View className="flex-row items-start justify-between">
          <View className="flex-row items-center gap-3 flex-1">
            <View
              className={`w-10 h-10 rounded-full items-center justify-center ${
                isCredit ? 'bg-emerald-900/50' : isDebit ? 'bg-red-900/50' : 'bg-sky-900/50'
              }`}
            >
              <Text>{isCredit ? '⬆️' : isDebit ? '⬇️' : '↔️'}</Text>
            </View>
            <View className="flex-1">
              <Text className="text-white font-medium" numberOfLines={1}>
                {tx.description ?? '(no description)'}
              </Text>
              <Text className="text-slate-500 text-xs">
                {formatRelativeDate(tx.transaction_date)}
                {account ? ` · ${account.name}` : ''}
                {category ? ` · ${category.name}` : ''}
              </Text>
            </View>
          </View>

          <View className="items-end">
            <Text
              className={`font-bold text-base ${
                isCredit ? 'text-emerald-400' : isDebit ? 'text-red-400' : 'text-sky-400'
              }`}
            >
              {isDebit ? '-' : isCredit ? '+' : ''}
              {formatCurrency(tx.amount, tx.currency as CurrencyCode)}
            </Text>
            {tx.is_reconciled && (
              <Text className="text-slate-500 text-xs">✓ Reconciled</Text>
            )}
          </View>
        </View>

        <View className="flex-row gap-2 mt-3">
          <TouchableOpacity
            onPress={() => onEdit(tx)}
            className="flex-1 py-1.5 rounded-lg bg-slate-700 items-center"
          >
            <Text className="text-slate-200 text-xs font-medium">✏️ Edit</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => onDelete(tx)}
            className="flex-1 py-1.5 rounded-lg bg-red-900/40 items-center"
          >
            <Text className="text-red-400 text-xs font-medium">🗑 Delete</Text>
          </TouchableOpacity>
        </View>
      </Card>
    </TouchableOpacity>
  )
}

// ─── Transaction Form Modal ───────────────────────────────────────────────────

function TransactionFormModal({
  visible,
  onClose,
  initial,
  accounts,
  categories,
  entityId,
  defaultCurrency,
}: {
  visible: boolean
  onClose: () => void
  initial?: Partial<Transaction>
  accounts: Account[]
  categories: Category[]
  entityId: number
  defaultCurrency: CurrencyCode
}) {
  const isEdit = !!initial?.id
  const [createTransaction, { isLoading: creating }] = useCreateTransactionMutation()
  const [updateTransaction, { isLoading: updating }] = useUpdateTransactionMutation()

  const [form, setForm] = useState({
    description: initial?.description ?? '',
    amount: String(initial?.amount ?? ''),
    transaction_type: initial?.transaction_type ?? 'debit',
    account_id: String(initial?.account_id ?? accounts[0]?.id ?? ''),
    category_id: String(initial?.category_id ?? ''),
    transaction_date: initial?.transaction_date
      ? initial.transaction_date.split('T')[0]
      : new Date().toISOString().split('T')[0],
  })

  const update = (key: keyof typeof form, value: string) =>
    setForm((p) => ({ ...p, [key]: value }))

  const handleSubmit = async () => {
    if (!form.amount || !form.account_id) {
      return Alert.alert('Error', 'Amount and account are required.')
    }
    try {
      const payload: Partial<Transaction> = {
        description: form.description.trim() || undefined,
        amount: parseFloat(form.amount),
        transaction_type: form.transaction_type as Transaction['transaction_type'],
        account_id: parseInt(form.account_id),
        category_id: form.category_id ? parseInt(form.category_id) : undefined,
        transaction_date: new Date(form.transaction_date).toISOString(),
        entity_id: entityId,
        currency: defaultCurrency,
      }
      if (isEdit && initial?.id) {
        await updateTransaction({ id: initial.id, data: payload }).unwrap()
      } else {
        await createTransaction(payload).unwrap()
      }
      onClose()
    } catch {
      Alert.alert('Error', 'Could not save transaction.')
    }
  }

  const isSaving = creating || updating

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet">
      <View className="flex-1 bg-slate-900 px-6 pt-8">
        <View className="flex-row items-center justify-between mb-6">
          <Text className="text-white text-xl font-bold">
            {isEdit ? 'Edit Transaction' : 'New Transaction'}
          </Text>
          <TouchableOpacity onPress={onClose}>
            <Text className="text-sky-400 font-semibold">Cancel</Text>
          </TouchableOpacity>
        </View>

        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ gap: 16 }}>
          {/* Type */}
          <View className="gap-2">
            <Text className="text-slate-400 text-sm font-medium">Type</Text>
            <View className="flex-row gap-2">
              {(['debit', 'credit', 'transfer'] as const).map((t) => (
                <TouchableOpacity
                  key={t}
                  onPress={() => update('transaction_type', t)}
                  className={`flex-1 py-2 rounded-lg border items-center ${
                    form.transaction_type === t
                      ? 'bg-sky-500 border-sky-500'
                      : 'bg-slate-800 border-slate-700'
                  }`}
                >
                  <Text
                    className={
                      form.transaction_type === t ? 'text-white font-semibold' : 'text-slate-300'
                    }
                  >
                    {t === 'debit' ? '⬇️ Debit' : t === 'credit' ? '⬆️ Credit' : '↔️ Transfer'}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          <Input
            label="Amount"
            placeholder="0.00"
            value={form.amount}
            onChangeText={(v) => update('amount', v)}
            keyboardType="decimal-pad"
          />

          <Input
            label="Description (optional)"
            placeholder="What was this for?"
            value={form.description}
            onChangeText={(v) => update('description', v)}
          />

          {/* Account */}
          <View className="gap-2">
            <Text className="text-slate-400 text-sm font-medium">Account</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View className="flex-row gap-2">
                {accounts.map((acc) => (
                  <TouchableOpacity
                    key={acc.id}
                    onPress={() => update('account_id', String(acc.id))}
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

          {/* Category */}
          <View className="gap-2">
            <Text className="text-slate-400 text-sm font-medium">Category (optional)</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View className="flex-row gap-2">
                <TouchableOpacity
                  onPress={() => update('category_id', '')}
                  className={`px-3 py-2 rounded-lg border ${
                    !form.category_id ? 'bg-sky-500 border-sky-500' : 'bg-slate-800 border-slate-700'
                  }`}
                >
                  <Text className={!form.category_id ? 'text-white font-semibold' : 'text-slate-300'}>
                    None
                  </Text>
                </TouchableOpacity>
                {categories.map((cat) => (
                  <TouchableOpacity
                    key={cat.id}
                    onPress={() => update('category_id', String(cat.id))}
                    className={`px-3 py-2 rounded-lg border ${
                      form.category_id === String(cat.id)
                        ? 'bg-sky-500 border-sky-500'
                        : 'bg-slate-800 border-slate-700'
                    }`}
                  >
                    <Text
                      className={
                        form.category_id === String(cat.id)
                          ? 'text-white font-semibold'
                          : 'text-slate-300'
                      }
                    >
                      {cat.name}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </ScrollView>
          </View>

          <Input
            label="Date"
            placeholder="YYYY-MM-DD"
            value={form.transaction_date}
            onChangeText={(v) => update('transaction_date', v)}
          />

          <Button
            label={isEdit ? 'Save Changes' : 'Add Transaction'}
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

export default function TransactionsScreen() {
  const { user } = useAuth()
  const currency = (user?.default_currency as CurrencyCode) ?? 'PHP'

  const { data: txData, isLoading, isFetching, refetch } = useGetTransactionsQuery({ limit: 50 })
  const { data: accData } = useGetAccountsQuery({ is_active: true, limit: 100 })
  const { data: catData } = useGetCategoriesQuery({ is_active: true })
  const [deleteTransaction] = useDeleteTransactionMutation()

  const [modalVisible, setModalVisible] = useState(false)
  const [editing, setEditing] = useState<Transaction | undefined>()
  const [filterType, setFilterType] = useState<string>('')

  const transactions = txData?.items ?? []
  const accounts = accData?.items ?? []
  const categories = catData ?? []

  const filtered = filterType
    ? transactions.filter((tx) => tx.transaction_type === filterType)
    : transactions

  const handleDelete = (tx: Transaction) => {
    Alert.alert('Delete Transaction', 'Remove this transaction?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => deleteTransaction(tx.id) },
    ])
  }

  const openEdit = (tx: Transaction) => {
    setEditing(tx)
    setModalVisible(true)
  }

  if (isLoading) return <LoadingSpinner message="Loading transactions…" />

  return (
    <SafeAreaView className="flex-1 bg-slate-900">
      <View className="px-4 pt-4 pb-2">
        <SectionHeader
          title="Transactions"
          action={
            <TouchableOpacity
              onPress={() => { setEditing(undefined); setModalVisible(true) }}
              className="bg-sky-500 px-3 py-1.5 rounded-lg"
            >
              <Text className="text-white font-semibold text-sm">+ Add</Text>
            </TouchableOpacity>
          }
        />

        {/* Filter tabs */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} className="mb-2">
          <View className="flex-row gap-2">
            {[
              { label: 'All', value: '' },
              { label: '⬇️ Debit', value: 'debit' },
              { label: '⬆️ Credit', value: 'credit' },
              { label: '↔️ Transfer', value: 'transfer' },
            ].map(({ label, value }) => (
              <TouchableOpacity
                key={value}
                onPress={() => setFilterType(value)}
                className={`px-3 py-1.5 rounded-full ${
                  filterType === value ? 'bg-sky-500' : 'bg-slate-800'
                }`}
              >
                <Text className={filterType === value ? 'text-white font-semibold text-sm' : 'text-slate-400 text-sm'}>
                  {label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </ScrollView>
      </View>

      {filtered.length === 0 ? (
        <EmptyState message="No transactions found." />
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(item) => String(item.id)}
          renderItem={({ item }) => (
            <TransactionItem
              tx={item}
              accounts={accounts}
              categories={categories}
              onEdit={openEdit}
              onDelete={handleDelete}
            />
          )}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24 }}
          refreshControl={
            <RefreshControl refreshing={isFetching} onRefresh={refetch} tintColor="#0ea5e9" />
          }
        />
      )}

      <TransactionFormModal
        visible={modalVisible}
        onClose={() => setModalVisible(false)}
        initial={editing}
        accounts={accounts}
        categories={categories}
        entityId={1}
        defaultCurrency={currency}
      />
    </SafeAreaView>
  )
}
