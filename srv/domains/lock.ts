import { v4 } from 'uuid'
import { getDb } from '../db/client'
import { createHandler } from './domain'
import { logger } from '../logger'

type Handler = ReturnType<typeof createHandler<any>>

export async function obtainManagerLock(handler: Handler) {
  const lockName = `lock-${handler.name}`
  const sessionId = v4()
  lock(lockName, sessionId)
}

function maintainLock(name: string, sessionId: string) {
  const timer = setInterval(async () => {
    await getDb()
      .collection('evtstore-lock')
      .findOneAndUpdate({ id: name, sessionId }, { $set: { ttl: Date.now() + 10000 } })
  }, 5000)
  process.on('SIGTERM', () => clearInterval(timer))
}

type Lock = { id: string; ttl: number; sessionId: string }

async function lock(name: string, sessionId: string) {
  const collection = getDb().collection<Lock>('evtstore-lock')
  try {
    await collection.insertOne({ id: name, ttl: Date.now() + 1000, sessionId })
    maintainLock(name, sessionId)
    logger.info({ name }, 'Lock obtained')
    return
  } catch (ex) {
    const result = await getDb()
      .collection<{ id: string; ttl: number; sessionId: string }>('evtstore-lock')
      .findOneAndUpdate(
        {
          id: name,
          ttl: { $lt: Date.now() },
        },
        {
          $set: {
            ttl: Date.now() + 10000,
            sessionId,
          },
        },
        { returnDocument: 'after' }
      )

    if (result.value?.sessionId === sessionId) {
      logger.info({ name }, 'Lock obtained')
      maintainLock(name, sessionId)
      return
    }
  }

  setTimeout(() => lock(name, sessionId), 5000)
}
