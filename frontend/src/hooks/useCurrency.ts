import { useAuth } from '../contexts/AuthContext'
import { getCurrencySymbol, CurrencyCode } from '../utils/currency'
import { formatSigned } from '../utils/amount'

/**
 * Custom hook to get currency formatting functions based on user's default currency
 */
export function useCurrency() {
  const { user } = useAuth()
  const currencyCode = (user?.default_currency as CurrencyCode) || 'PHP'
  
  return {
    currencyCode,
    format: (amount: number) => formatSigned(amount, currencyCode),
    symbol: getCurrencySymbol(currencyCode),
    formatWithSymbol: (amount: number) => formatSigned(amount, currencyCode)
  }
}
