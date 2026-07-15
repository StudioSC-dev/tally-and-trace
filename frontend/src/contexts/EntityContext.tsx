import React, { createContext, useContext, useEffect, useMemo, ReactNode } from 'react'
import { useGetEntitiesQuery } from '../store/api'
import type { Entity } from '../store/api'
import { useAuth } from './AuthContext'

const ACTIVE_ENTITY_KEY = 'active_entity_id'

interface EntityContextType {
  entities: Entity[]
  activeEntity: Entity | null
  activeEntityId: number | null
  setActiveEntityId: (id: number) => void
  isLoading: boolean
}

const EntityContext = createContext<EntityContextType | undefined>(undefined)

export function getStoredEntityId(): number | null {
  const raw = localStorage.getItem(ACTIVE_ENTITY_KEY)
  const parsed = raw ? Number(raw) : NaN
  return Number.isFinite(parsed) ? parsed : null
}

interface EntityProviderProps {
  children: ReactNode
}

export const EntityProvider: React.FC<EntityProviderProps> = ({ children }) => {
  const { isAuthenticated } = useAuth()
  const { data: entities = [], isLoading } = useGetEntitiesQuery(
    { is_active: true },
    { skip: !isAuthenticated }
  )

  const storedId = getStoredEntityId()
  const activeEntity = useMemo(() => {
    if (entities.length === 0) return null
    return entities.find((e) => e.id === storedId) ?? entities[0]
  }, [entities, storedId])

  // Keep localStorage in sync: default to the first entity, or repair a stale/deleted selection.
  useEffect(() => {
    if (activeEntity && activeEntity.id !== storedId) {
      localStorage.setItem(ACTIVE_ENTITY_KEY, String(activeEntity.id))
    }
  }, [activeEntity, storedId])

  const setActiveEntityId = (id: number) => {
    localStorage.setItem(ACTIVE_ENTITY_KEY, String(id))
    // Reload so every RTK Query cache re-fetches under the new X-Entity-Id header.
    window.location.reload()
  }

  const value: EntityContextType = {
    entities,
    activeEntity,
    activeEntityId: activeEntity?.id ?? null,
    setActiveEntityId,
    isLoading,
  }

  return <EntityContext.Provider value={value}>{children}</EntityContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export const useEntity = (): EntityContextType => {
  const context = useContext(EntityContext)
  if (context === undefined) {
    throw new Error('useEntity must be used within an EntityProvider')
  }
  return context
}
