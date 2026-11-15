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
import type { Transaction, Account, Category, FullTransaction, SharedFullTransaction } from '../../src/store/api'
import { useAuth } from '../../src/contexts/AuthContext'
import {
  categoryOptionLabel,
  formatCurrency,
  formatRelativeDate,
  transactionDate,
  transactionDescription,
  transferAccountFields,
} from '@tally-trace/shared'
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
  // Limited rows carry account refs and a category name instead of ids; narrow before reading ids.
  const accountName =
    tx.view === 'limited'
      ? tx.counterpart
        ? `${tx.account?.name ?? 'Other account'} → ${tx.counterpart.name}`
        : tx.account?.name
      : accounts.find((a) => a.id === tx.account_id)?.name
  const categoryName =
    tx.view === 'limited'
      ? tx.category_name
      : tx.view === 'shared_full'
        ? tx.category_name
        : categories.find((c) => c.id === tx.category_id)?.name
  const canEdit = tx.permissions.can_edit
  const canDelete = tx.permissions.can_delete
  const isDebit = tx.transaction_type === 'debit'
  const isCredit = tx.transaction_type === 'credit'

  return (
    <TouchableOpacity onLongPress={canEdit ? () => onEdit(tx) : undefined} activeOpacity={canEdit ? 0.2 : 1}>
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
                {transactionDescription(tx) ?? '(no description)'}
              </Text>
              <Text className="text-slate-500 text-xs">
                {formatRelativeDate(transactionDate(tx))}
                {accountName ? ` · ${accountName}` : ''}
                {categoryName ? ` · ${categoryName}` : ''}
                {tx.created_by ? ` · ${tx.created_by}` : ''}
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
            {tx.view !== 'limited' && tx.is_reconciled && (
              <Text className="text-slate-500 text-xs">✓ Reconciled</Text>
            )}
          </View>
        </View>

        {(canEdit || canDelete) && (
          <View className="flex-row gap-2 mt-3">
            {canEdit && (
              <TouchableOpacity
                onPress={() => onEdit(tx)}
                className="flex-1 py-1.5 rounded-lg bg-slate-700 items-center"
              >
                <Text className="text-slate-200 text-xs font-medium">✏️ Edit</Text>
              </TouchableOpacity>
            )}
            {canDelete && (
              <TouchableOpacity
                onPress={() => onDelete(tx)}
                className="flex-1 py-1.5 rounded-lg bg-red-900/40 items-center"
              >
                <Text className="text-red-400 text-xs font-medium">🗑 Delete</Text>
              </TouchableOpacity>
            )}
          </View>
        )}
      </Card>
    </TouchableOpacity>
  )
}

// ─── Transaction Form Modal ───────────────────────────────────────────────────

export function TransactionFormModal({
  visible,
  onClose,
  initial,
  accounts,
  categories,
  defaultCurrency,
}: {
  visible: boolean
  onClose: () => void
  initial?: FullTransaction | SharedFullTransaction
  accounts: Account[]
  categories: Category[]
  defaultCurrency: CurrencyCode
}) {
  // Only accounts the caller may add transactions to are offered in the form.
  const eligibleAccounts = accounts.filter((a) => a.permissions.can_add_transactions)
  const isEdit = !!initial?.id
  const isSharedEdit = initial?.view === 'shared_full'
  const [createTransaction, { isLoading: creating }] = useCreateTransactionMutation()
  const [updateTransaction, { isLoading: updating }] = useUpdateTransactionMutation()

  const [form, setForm] = useState({
    description: initial?.description ?? '',
    amount: String(initial?.amount ?? ''),
    transaction_type: initial?.transaction_type ?? 'debit',
    account_id: String(initial?.account_id ?? eligibleAccounts[0]?.id ?? ''),
    transfer_from_account_id: String(
      initial && initial.view === 'full' && initial.transaction_type === 'transfer'
        ? (initial.transfer_from_account_id ?? initial.account_id ?? '')
        : '',
    ),
    transfer_to_account_id: String(
      initial && initial.view === 'full' && initial.transaction_type === 'transfer'
        ? (initial.transfer_to_account_id ?? '')
        : '',
    ),
    received_amount: String(
      initial?.transaction_type === 'transfer'
        ? (initial.received_amount ?? '')
        : '',
    ),
    category_id: String(initial && initial.view === 'full' ? (initial.category_id ?? '') : ''),
    transaction_date: initial?.transaction_date
      ? initial.transaction_date.split('T')[0]
      : new Date().toISOString().split('T')[0],
  })

  const update = (key: keyof typeof form, value: string) =>
    setForm((p) => ({ ...p, [key]: value }))

  // A transfer between two currencies also needs what the destination received.
  const isTransferType = form.transaction_type === 'transfer'
  const sourceCurrency = eligibleAccounts.find((a) => String(a.id) === form.transfer_from_account_id)?.currency
  const destinationCurrency = eligibleAccounts.find((a) => String(a.id) === form.transfer_to_account_id)?.currency
  const crossCurrency =
    isTransferType && !!sourceCurrency && !!destinationCurrency && sourceCurrency !== destinationCurrency

  const handleSubmit = async () => {
    const isTransfer = form.transaction_type === 'transfer'
    if (isTransfer) {
      if (!form.amount) return Alert.alert('Error', 'Amount is required.')
      if (!form.transfer_from_account_id) {
        return Alert.alert('Error', 'Choose the source account for the transfer.')
      }
      if (!form.transfer_to_account_id) {
        return Alert.alert('Error', 'Choose the destination account for the transfer.')
      }
      if (form.transfer_from_account_id === form.transfer_to_account_id) {
        return Alert.alert('Error', 'Source and destination must be different accounts.')
      }
      if (crossCurrency && !(parseFloat(form.received_amount) > 0)) {
        return Alert.alert('Error', `Enter the amount received in ${destinationCurrency}.`)
      }
    } else if (!form.amount || !form.account_id) {
      return Alert.alert('Error', 'Amount and account are required.')
    }
    // A transfer is booked on its source account.
    const accountId = isTransfer ? form.transfer_from_account_id : form.account_id
    try {
      const payload: Partial<FullTransaction> = {
        description: form.description.trim() || undefined,
        amount: parseFloat(form.amount),
        transaction_type: form.transaction_type as Transaction['transaction_type'],
        account_id: parseInt(accountId),
        category_id: form.category_id ? parseInt(form.category_id) : undefined,
        transaction_date: new Date(form.transaction_date).toISOString(),
        // An edit keeps the record's own currency; only a new record takes its account's.
        currency:
          isEdit && initial?.currency
            ? (initial.currency as CurrencyCode)
            : ((eligibleAccounts.find((a) => String(a.id) === accountId)?.currency as CurrencyCode | undefined) ?? defaultCurrency),
        // Any other type sends both as null, so an edit away from a transfer clears them.
        ...transferAccountFields(
          form.transaction_type,
          form.transfer_from_account_id ? parseInt(form.transfer_from_account_id) : undefined,
          form.transfer_to_account_id ? parseInt(form.transfer_to_account_id) : undefined,
        ),
        // Only a transfer between currencies carries what the destination received.
        ...(crossCurrency ? { received_amount: parseFloat(form.received_amount) } : {}),
        // The API accepts an explicit null here; the shared field type only lists a number.
      } as Partial<FullTransaction>
      // Another user's record: the server refuses references owned by someone else.
      if (isSharedEdit) delete payload.category_id
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
                  testID={`type-${t}`}
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
            testID="amount"
          />

          <Input
            label="Description (optional)"
            placeholder="What was this for?"
            value={form.description}
            onChangeText={(v) => update('description', v)}
          />

          {/* Account */}
          {form.transaction_type !== 'transfer' && (
          <View className="gap-2" testID="account-picker">
            <Text className="text-slate-400 text-sm font-medium">Account</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View className="flex-row gap-2">
                {eligibleAccounts.map((acc) => (
                  <TouchableOpacity
                    key={acc.id}
                    testID={`account-${acc.id}`}
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
          )}

          {/* Transfer source and destination */}
          {form.transaction_type === 'transfer' &&
            (['transfer_from_account_id', 'transfer_to_account_id'] as const).map((key) => (
              <View key={key} className="gap-2" testID={key === 'transfer_from_account_id' ? 'transfer-from-picker' : 'transfer-to-picker'}>
                <Text className="text-slate-400 text-sm font-medium">
                  {key === 'transfer_from_account_id' ? 'From account' : 'To account'}
                </Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                  <View className="flex-row gap-2">
                    {eligibleAccounts.map((acc) => (
                      <TouchableOpacity
                        key={acc.id}
                        testID={`${key === 'transfer_from_account_id' ? 'transfer-from' : 'transfer-to'}-${acc.id}`}
                        onPress={() => update(key, String(acc.id))}
                        className={`px-3 py-2 rounded-lg border ${
                          form[key] === String(acc.id)
                            ? 'bg-sky-500 border-sky-500'
                            : 'bg-slate-800 border-slate-700'
                        }`}
                      >
                        <Text className={form[key] === String(acc.id) ? 'text-white font-semibold' : 'text-slate-300'}>
                          {acc.name}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </ScrollView>
              </View>
            ))}

          {/* Amount received, only for a transfer between currencies */}
          {crossCurrency && (
            <Input
              label={`Received amount (${destinationCurrency})`}
              placeholder="0.00"
              value={form.received_amount}
              onChangeText={(v) => update('received_amount', v)}
              keyboardType="decimal-pad"
              testID="received-amount"
            />
          )}

          {/* Category (hidden when editing another user's record) */}
          {!isSharedEdit && (
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
                      {categoryOptionLabel(cat, categories)}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </ScrollView>
          </View>
          )}

          <Input
            label="Date"
            placeholder="YYYY-MM-DD"
            value={form.transaction_date}
            onChangeText={(v) => update('transaction_date', v)}
          />

          <Button
            label={isEdit ? 'Save Changes' : 'Add Transaction'}
            onPress={handleSubmit}
            testID="submit"
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
  const [editing, setEditing] = useState<FullTransaction | SharedFullTransaction | undefined>()
  const [filterType, setFilterType] = useState<string>('')

  const transactions = txData?.items ?? []
  const accounts = accData?.items ?? []
  // Only accounts the caller may add transactions to are offered in the form.
  const writableAccounts = accounts.filter((a) => a.permissions.can_add_transactions)
  const categories = catData ?? []

  const filtered = filterType
    ? transactions.filter((tx) => tx.transaction_type === filterType)
    : transactions

  const handleDelete = (tx: Transaction) => {
    Alert.alert('Delete Transaction', 'Remove this transaction?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          deleteTransaction(tx.id)
            .unwrap()
            .catch((e: { data?: { detail?: unknown } }) =>
              Alert.alert('Error', typeof e?.data?.detail === 'string' ? e.data.detail : 'Could not delete transaction.'),
            )
        },
      },
    ])
  }

  const openEdit = (tx: Transaction) => {
    if (tx.view === 'limited' || !tx.permissions.can_edit) return
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
            writableAccounts.length > 0 ? (
            <TouchableOpacity
              onPress={() => { setEditing(undefined); setModalVisible(true) }}
              className="bg-sky-500 px-3 py-1.5 rounded-lg"
            >
              <Text className="text-white font-semibold text-sm">+ Add</Text>
            </TouchableOpacity>
            ) : undefined
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
        accounts={writableAccounts}
        categories={categories}
        defaultCurrency={currency}
      />
    </SafeAreaView>
  )
}
