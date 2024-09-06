import { indexer } from "./indexer"
import * as viem from 'viem'
import config from '../config'
import { chain, publicClient } from "./chain"
import * as threads from './threads'
import { contracts, getLatestBaseFee } from "./contracts"
import { signers } from "./signers"
import * as randomUtils from '@gibs/random/lib/utils'
import { log } from "./logger"
import _ from "lodash"

const consumeRandomness = async () => {
  const conf = config.randomness.get(chain.id)!
  const { consumer } = await signers()
  const lastBaseFee = await getLatestBaseFee()
  const overrides = {
    account: consumer.account!,
    maxFeePerGas: lastBaseFee * 2n,
    maxPriorityFeePerGas: lastBaseFee > 10n ? lastBaseFee / 10n : 1n,
    type: 'eip1559',
    gas: 10_000_000n,
  } as const
  await Promise.all(conf.streams.map(async (randomConfig) => {
    const rand = Math.floor(Math.random() * 256)
    const required = 3
    const decimals = 18
    const price = viem.parseUnits(randomConfig.info.price, decimals)
    const { pointers } = await indexer.pointersOrderedBySelf({
      pointerLimit: 100,
      pointerFilter: {
        token: randomConfig.info.token,
        price_lte: price.toString(),
        duration_lte: randomConfig.info.duration,
        durationIsTimestamp: randomConfig.info.durationIsTimestamp,
      },
      preimageLimit: required,
      preimageFilter: {
        data_gte: viem.bytesToHex(Uint8Array.from([rand]), { size: 32 }),
        heatId: null,
      },
    })
    const locations = pointers.items.flatMap((pointer) => (
      pointer.preimages!.items.map((preimage) => ({
        provider: pointer.provider as viem.Hex,
        token: pointer.token as viem.Hex,
        price: BigInt(pointer.price),
        duration: BigInt(pointer.duration),
        durationIsTimestamp: pointer.durationIsTimestamp,
        offset: BigInt(pointer.offset),
        index: BigInt(preimage.index),
      }))
    ))
    if (locations.length > 3) {
      return
    }
    if (locations.length < required) {
      log('required=%o location=%o', required, locations)
      throw new Error('ran out of locations!')
    }
    log('consuming %o locations', locations.length)
    await contracts().random.write.heat([BigInt(required), {
      ...randomConfig.info,
      price,
      duration: BigInt(randomConfig.info.duration) * 2n,
      provider: consumer.account!.address,
      offset: 0n,
      index: 0n,
    }, locations], {
      ...overrides,
      value: randomUtils.sum(locations),
    })
  }))
}

const detectSecrets = async () => {
  const { consumer } = await signers()
  const { preimages } = await indexer.unlinkedSecrets({
    secret_not: null,
    castId: null,
  })
  const preimageHashes = preimages.items.map((preimage) => (
    preimage.data
  ))
  const startKeyToPreimages = _.groupBy(preimages.items, 'start.key')
  const checked = new Set<viem.Hex>()
  for (const preimage of preimageHashes) {
    const { preimages } = await indexer.unfinishedStarts({
      data: preimage
    })
    const start = preimages.items?.[0]?.heat?.start
    if (start?.chopped || start?.castId) continue
    const heats = start?.heat?.items
    if (!heats) continue
    const key = start.key as viem.Hex
    if (checked.has(key)) {
      break
    }
    checked.add(key)
    const orderedPreimages = _.sortBy(startKeyToPreimages[key], 'heat.index')
    const secrets = orderedPreimages.map<viem.Hex>((p) => (
      p.secret as viem.Hex
    ))
    if (_.compact(secrets).length !== heats.length) {
      continue
    }
    const lastBaseFee = await getLatestBaseFee()
    const overrides = {
      account: consumer.account!,
      maxFeePerGas: lastBaseFee * 2n,
      maxPriorityFeePerGas: lastBaseFee > 10n ? lastBaseFee / 10n : 1n,
      type: 'eip1559',
      gas: 10_000_000n,
    } as const
    const pointerLocations = heats.map<randomUtils.PreimageInfo>(({
      preimage: { pointer, index }
    }) => ({
      provider: pointer.provider as viem.Hex,
      token: pointer.token as viem.Hex,
      price: BigInt(pointer.price),
      durationIsTimestamp: pointer.durationIsTimestamp,
      duration: BigInt(pointer.duration),
      offset: BigInt(pointer.offset),
      index: BigInt(index),
    }))
    const txHash = await contracts().random.write.cast(
      [start.key as viem.Hex, pointerLocations, secrets], overrides)
    log('sending cast %o', txHash)
    await publicClient.waitForTransactionReceipt({
      hash: txHash,
    })
  }
}

const intervals = new Map<threads.Runner, number>([
  [consumeRandomness, 60_000 * 10],
  [detectSecrets, 10_000],
])

export const main = async () => {
  await threads.main(intervals)
}
