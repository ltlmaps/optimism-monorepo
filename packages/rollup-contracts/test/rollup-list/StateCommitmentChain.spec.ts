import '../setup'

/* External Imports */
import { getLogger, TestUtils } from '@eth-optimism/core-utils'
import { createMockProvider, deployContract, getWallets } from 'ethereum-waffle'
import { Contract } from 'ethers'

/* Internal Imports */
import { StateChainBatch } from './RLhelper'

/* Logging */
const log = getLogger('state-commitment-chain', true)

/* Contract Imports */
import * as StateCommitmentChain from '../../build/StateCommitmentChain.json'
import * as CanonicalTransactionChain from '../../build/CanonicalTransactionChain.json'
import * as RollupMerkleUtils from '../../build/RollupMerkleUtils.json'

/* Begin tests */
describe('StateCommitmentChain', () => {
  const provider = createMockProvider()
  const [wallet, sequencer, l1ToL2TransactionPasser, randomWallet] = getWallets(
    provider
  )
  let stateChain
  let canonicalTxChain
  let rollupMerkleUtils
  const DEFAULT_BATCH = ['0x1234', '0x5678']
  const DEFAULT_TX_BATCH = [
    '0x1234',
    '0x5678',
    '0x1234',
    '0x5678',
    '0x1234',
    '0x5678',
    '0x1234',
    '0x5678',
    '0x1234',
    '0x5678',
  ]
  const DEFAULT_STATE_ROOT = '0x1234'
  const LIVENESS_ASSUMPTION = 600

  const appendAndGenerateBatch = async (
    batch: string[],
    batchIndex: number = 0,
    cumulativePrevElements: number = 0
  ): Promise<StateChainBatch> => {
    await stateChain.appendStateBatch(batch)
    // Generate a local version of the rollup batch
    const localBatch = new StateChainBatch(
      batchIndex,
      cumulativePrevElements,
      batch
    )
    await localBatch.generateTree()
    return localBatch
  }

  const appendTxBatch = async (batch: string[]): Promise<void> => {
    const timestamp = Math.floor(Date.now() / 1000)
    // Submit the rollup batch on-chain
    await canonicalTxChain
      .connect(sequencer)
      .appendTransactionBatch(batch, timestamp)
  }

  before(async () => {
    rollupMerkleUtils = await deployContract(wallet, RollupMerkleUtils, [], {
      gasLimit: 6700000,
    })

    canonicalTxChain = await deployContract(
      wallet,
      CanonicalTransactionChain,
      [
        rollupMerkleUtils.address,
        sequencer.address,
        l1ToL2TransactionPasser.address,
        LIVENESS_ASSUMPTION,
      ],
      {
        gasLimit: 6700000,
      }
    )
    // length 10 batch
    await appendTxBatch(DEFAULT_TX_BATCH)
  })

  /* Deploy a new RollupChain before each test */
  beforeEach(async () => {
    stateChain = await deployContract(
      wallet,
      StateCommitmentChain,
      [rollupMerkleUtils.address, canonicalTxChain.address],
      {
        gasLimit: 6700000,
      }
    )
  })

  describe('appendStateBatch()', async () => {
    it('should not throw when appending a batch from any wallet', async () => {
      await stateChain.connect(randomWallet).appendStateBatch(DEFAULT_BATCH)
    })

    it('should throw if submitting an empty batch', async () => {
      const emptyBatch = []
      await TestUtils.assertRevertsAsync(
        'Cannot submit an empty state commitment batch',
        async () => {
          await stateChain.appendStateBatch(emptyBatch)
        }
      )
    })

    it('should add to batches array', async () => {
      await stateChain.appendStateBatch(DEFAULT_BATCH)
      const batchesLength = await stateChain.getBatchesLength()
      batchesLength.toNumber().should.equal(1)
    })

    it('should update cumulativeNumElements correctly', async () => {
      await stateChain.appendStateBatch(DEFAULT_BATCH)
      const cumulativeNumElements = await stateChain.cumulativeNumElements.call()
      cumulativeNumElements.toNumber().should.equal(DEFAULT_BATCH.length)
    })

    it('should calculate batchHeaderHash correctly', async () => {
      const localBatch = await appendAndGenerateBatch(DEFAULT_BATCH)
      const expectedBatchHeaderHash = await localBatch.hashBatchHeader()
      const calculatedBatchHeaderHash = await stateChain.batches(0)
      calculatedBatchHeaderHash.should.equal(expectedBatchHeaderHash)
    })

    it('should add multiple batches correctly', async () => {
      const numBatchs = 5
      for (let batchIndex = 0; batchIndex < numBatchs; batchIndex++) {
        const cumulativePrevElements = DEFAULT_BATCH.length * batchIndex
        const localBatch = await appendAndGenerateBatch(
          DEFAULT_BATCH,
          batchIndex,
          cumulativePrevElements
        )
        const expectedBatchHeaderHash = await localBatch.hashBatchHeader()
        const calculatedBatchHeaderHash = await stateChain.batches(batchIndex)
        calculatedBatchHeaderHash.should.equal(expectedBatchHeaderHash)
      }
      const cumulativeNumElements = await stateChain.cumulativeNumElements.call()
      cumulativeNumElements
        .toNumber()
        .should.equal(numBatchs * DEFAULT_BATCH.length)
      const batchesLength = await stateChain.getBatchesLength()
      batchesLength.toNumber().should.equal(numBatchs)
    })

    it('should throw if submitting more state commitments than number of txs in canonical tx chain', async () => {
      const numBatchs = 5
      for (let i = 0; i < numBatchs; i++) {
        await stateChain.appendStateBatch(DEFAULT_BATCH)
      }
      await TestUtils.assertRevertsAsync(
        'Cannot append more state commitments than total number of transactions in CanonicalTransactionChain',
        async () => {
          await stateChain.appendStateBatch(DEFAULT_BATCH)
        }
      )
    })
  })

  describe('verifyElement() ', async () => {
    it('should return true for valid elements for different batches and elements', async () => {
      await appendTxBatch(DEFAULT_TX_BATCH)
      await appendTxBatch(DEFAULT_TX_BATCH)
      const numBatches = 3
      const batch = [
        '0x1234',
        '0x4567',
        '0x890a',
        '0x4567',
        '0x890a',
        '0xabcd',
        '0x1234',
      ]
      for (let batchIndex = 0; batchIndex < numBatches; batchIndex++) {
        const cumulativePrevElements = batch.length * batchIndex
        const localBatch = await appendAndGenerateBatch(
          batch,
          batchIndex,
          cumulativePrevElements
        )
        for (
          let elementIndex = 0;
          elementIndex < batch.length;
          elementIndex += 3
        ) {
          const element = batch[elementIndex]
          const position = localBatch.getPosition(elementIndex)
          const elementInclusionProof = await localBatch.getElementInclusionProof(
            elementIndex
          )
          const isIncluded = await stateChain.verifyElement(
            element,
            position,
            elementInclusionProof
          )
          isIncluded.should.equal(true)
        }
      }
    })

    it('should return false for wrong position with wrong indexInBatch', async () => {
      const batch = ['0x1234', '0x4567', '0x890a', '0x4567', '0x890a', '0xabcd']
      const localBatch = await appendAndGenerateBatch(batch)
      const elementIndex = 1
      const element = batch[elementIndex]
      const position = localBatch.getPosition(elementIndex)
      const elementInclusionProof = await localBatch.getElementInclusionProof(
        elementIndex
      )
      //Give wrong position so inclusion proof is wrong
      const wrongPosition = position + 1
      const isIncluded = await stateChain.verifyElement(
        element,
        wrongPosition,
        elementInclusionProof
      )
      isIncluded.should.equal(false)
    })

    it('should return false for wrong position and matching indexInBatch', async () => {
      const batch = ['0x1234', '0x4567', '0x890a', '0x4567', '0x890a', '0xabcd']
      const localBatch = await appendAndGenerateBatch(batch)
      const elementIndex = 1
      const element = batch[elementIndex]
      const position = localBatch.getPosition(elementIndex)
      const elementInclusionProof = await localBatch.getElementInclusionProof(
        elementIndex
      )
      //Give wrong position so inclusion proof is wrong
      const wrongPosition = position + 1
      //Change index to also be false (so position = index + cumulative)
      elementInclusionProof.indexInBatch++
      const isIncluded = await stateChain.verifyElement(
        element,
        wrongPosition,
        elementInclusionProof
      )
      isIncluded.should.equal(false)
    })
  })
})
