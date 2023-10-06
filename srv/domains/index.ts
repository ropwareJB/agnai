import { logger } from '../logger'
import { billingMgr } from './billing/manager'
import { obtainManagerLock } from './lock'

export * from './domain'
export * from './billing/cmd'

const managers = [billingMgr]

export async function startManagers() {
  for (const mgr of managers) {
    try {
      await obtainManagerLock(mgr)
    } catch (ex) {
      logger.error({ err: ex }, 'Lock attempt failed')
    }
  }
}
